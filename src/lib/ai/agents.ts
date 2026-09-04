import { env } from '../env'
import { chatStructured, type Msg } from './ollama'
import type { ToolCtx, ToolDef, ToolResult } from './tools'
import { computeTotals, findColumn, liveRows } from '../crdt/doc'
import { formatINR } from '../util/format'
import { isImage, isTabularText } from '../util/mime'
import { parseTable } from '../util/table'
import type { MemoryFact } from './memory'
import type { Skill } from './skills'
import { renderSkills } from './skills'

/**
 * Agents.
 *
 * The main loop is a generalist with the full tool set. Two specialists sit
 * behind tools because they need something the generalist cannot have in the
 * same call: a different model (vision) or a different decoding mode
 * (schema-constrained JSON). Delegating to them keeps the main context clean —
 * a 40-row receipt becomes one structured result instead of forty tool
 * round-trips.
 *
 * There is deliberately no generic "spawn an agent" tool. Every specialist here
 * has a defined input, a defined output shape, and a bounded cost.
 */

export type AgentId = 'main' | 'extractor' | 'analyst'

export const AGENTS: Record<AgentId, { title: string; model: () => string; purpose: string }> = {
  main: {
    title: 'Assistant',
    model: () => env.ollama.chatModel,
    purpose: 'Talks to the user, plans changes, calls tools, and asks for approval before writing.',
  },
  extractor: {
    title: 'Document reader',
    model: () => env.ollama.visionModel,
    purpose: 'Reads receipts, invoices, statements and screenshots into structured rows with per-row confidence.',
  },
  analyst: {
    title: 'Analyst',
    model: () => env.ollama.fastModel,
    purpose: 'Answers questions about the numbers. Read-only, and never proposes a change.',
  },
}

// --------------------------------------------------------------- system prompt

export function buildSystemPrompt(params: {
  userName: string
  skills: Skill[]
  facts: MemoryFact[]
  summary: string
  scope: { fileName?: string; folderName?: string; columns?: string[]; rowCount?: number; total?: number; period?: string | null }
  storage: string
}): string {
  const { scope } = params

  const blocks: string[] = [
    `You are the assistant inside Khata, an expense ledger. You are talking to ${params.userName}.`,
    '',
    'How this app works — get this right, users notice when you do not:',
    '- Data lives in folders. A folder holds files. A file is a table of rows.',
    '- Every file starts with three columns: an amount column (INR), Title, and Extra Captions. Users add their own columns for things like quantity, category, payment method, or receipt attachments.',
    '- Amounts entered are TOTALS. A quantity column is a note, not a multiplier. "3 coffees, 240" means the row is 240, not 720. This is not a spreadsheet and nothing is computed across columns.',
    '- A file may have a period (a date range or a month range) switched on.',
    '',
    'How you work:',
    '- Read before you write. Call get_file or query_rows so you are using real column names and real row ids. Never invent a row id.',
    '- Read ONCE. The result of a tool call stays in front of you for the rest of the turn — calling get_file again, or listing folders you have already listed, tells you nothing new and makes the user wait. If the open file is the one you need, you do not need list_files or list_folders at all.',
    '- Every write tool you call becomes a proposal the user reviews and approves. So propose the complete change, not a cautious fragment — but do not propose a change the user did not ask for.',
    '- Batch related edits into one tool call. One call is one approval and one undo step for the user; ten calls is ten of each.',
    '- When you have what you need, act. Do not narrate a plan you are about to carry out anyway.',
    '- If a request is ambiguous in a way that changes the numbers, ask. If it is ambiguous in a way that does not, pick the sensible reading, say which you picked, and continue.',
    '- Report what happened plainly. If something failed, say so and say why.',
    '',
    'Writing style: short sentences, no preamble, no "Certainly!". Amounts as ₹1,20,450 with Indian digit grouping. Do not use headers or bullet lists for a two-line answer.',
  ]

  if (scope.fileName) {
    blocks.push(
      '',
      '## Open file',
      `"${scope.fileName}"${scope.folderName ? ` in folder "${scope.folderName}"` : ''}`,
      `Columns: ${scope.columns?.join(', ') ?? 'unknown'}`,
      `${scope.rowCount ?? 0} rows, total ${formatINR(scope.total ?? 0)}${scope.period ? `, period ${scope.period}` : ''}`,
      'Tools default to this file when no fileId is given.',
    )
  } else if (scope.folderName) {
    blocks.push('', '## Open folder', `"${scope.folderName}" — the user is looking at its file list.`)
  } else {
    blocks.push('', '## Context', 'The user is on the home screen. No file is open, so ask or use list_files before acting on one.')
  }

  if (params.summary) {
    blocks.push('', '## Earlier in this conversation', params.summary)
  }

  if (params.facts.length) {
    blocks.push(
      '',
      '## What you know about this user',
      ...params.facts.map((f) => `- ${f.text}${f.kind === 'correction' ? ' (they corrected you on this before)' : ''}`),
      'These are things they told you previously. Apply them; do not recite them back.',
    )
  }

  const skillText = renderSkills(params.skills)
  if (skillText) {
    blocks.push('', '# Guidance for this request', skillText)
  }

  blocks.push(
    '',
    `Storage backend: ${params.storage}. Writes are transactional and verified, so you can tell the user their change is saved once a tool reports success.`,
  )

  return blocks.join('\n')
}

// ------------------------------------------------------------------ extractor

export type ExtractedRow = {
  amount: number | null
  title: string
  notes?: string
  date?: string
  quantity?: number
  category?: string
  confidence: 'high' | 'medium' | 'low'
  concern?: string
}

export type ExtractionResult = {
  rows: ExtractedRow[]
  documentTotal: number | null
  currency: string | null
  period: { from?: string; to?: string } | null
  notes: string[]
}

const EXTRACTION_SCHEMA = {
  type: 'object' as const,
  properties: {
    rows: {
      type: 'array',
      description: 'Every line item, in the order they appear on the document.',
      items: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Plain number. No currency symbol, no thousands separators. Negative for discounts.' },
          title: { type: 'string', description: 'What was bought, as printed.' },
          notes: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD, only if legible.' },
          quantity: { type: 'number' },
          category: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          concern: { type: 'string', description: 'Why this row is uncertain, if it is.' },
        },
        required: ['amount', 'title', 'confidence'],
      },
    },
    documentTotal: { type: 'number', description: 'The total printed on the document, if there is one.' },
    currency: { type: 'string' },
    periodFrom: { type: 'string', description: 'YYYY-MM-DD if the document covers a range.' },
    periodTo: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' }, description: 'Anything the user should know about this extraction.' },
  },
  required: ['rows', 'documentTotal', 'notes'],
}

/**
 * Coerce whatever the model returned into ExtractedRow.
 *
 * Models drift on nested field names even when the tool schema spells them out
 * — `description` for `title`, `price` for `amount` — so the shape is mapped
 * rather than trusted. Anything that cannot be read as a number becomes null
 * with low confidence, which surfaces in the approval card instead of silently
 * becoming a zero in someone's total.
 */
function coerceRow(raw: unknown): ExtractedRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const hit = Object.keys(r).find((key) => key.toLowerCase() === k)
      if (hit && r[hit] != null && r[hit] !== '') return r[hit]
    }
    return undefined
  }

  const rawAmount = pick('amount', 'price', 'value', 'total', 'cost', 'inr', 'sum')
  let amount: number | null = null
  if (typeof rawAmount === 'number' && Number.isFinite(rawAmount)) amount = rawAmount
  else if (typeof rawAmount === 'string') {
    const n = parseFloat(rawAmount.replace(/[^0-9.\-]/g, ''))
    amount = Number.isFinite(n) ? n : null
  }

  const title = String(pick('title', 'description', 'item', 'name', 'particulars', 'label') ?? '').trim()
  if (!title && amount == null) return null

  const qty = pick('quantity', 'qty', 'count')
  const confidence = String(pick('confidence') ?? '').toLowerCase()

  return {
    amount,
    title: title || '(untitled line)',
    notes: pick('notes', 'note', 'remark') ? String(pick('notes', 'note', 'remark')) : undefined,
    date: /^\d{4}-\d{2}-\d{2}/.test(String(pick('date') ?? '')) ? String(pick('date')).slice(0, 10) : undefined,
    quantity: typeof qty === 'number' ? qty : qty ? Number(qty) || undefined : undefined,
    category: pick('category', 'type') ? String(pick('category', 'type')) : undefined,
    // An unreadable amount is never "high" confidence, whatever the model said.
    confidence: amount == null ? 'low' : confidence === 'high' || confidence === 'medium' || confidence === 'low' ? (confidence as ExtractedRow['confidence']) : 'medium',
    concern: pick('concern', 'issue', 'warning') ? String(pick('concern', 'issue', 'warning')) : amount == null ? 'The amount could not be read.' : undefined,
  }
}

/**
 * Read one document into rows.
 *
 * Text-shaped files are parsed deterministically first and the model only maps
 * columns — no vision pass, no hallucinated digits. Images go to the vision
 * model. Structure comes from a tool call rather than `format`, because this
 * endpoint ignores `format` (verified, not assumed).
 */
export async function runExtractor(input: {
  name: string
  mime: string
  bytes: Buffer
  instruction: string
  columns: string[]
}): Promise<ExtractionResult> {
  const isText = isTabularText(input.name, input.mime)
  const image = isImage(input.mime)

  if (!isText && !image) {
    return {
      rows: [],
      documentTotal: null,
      currency: null,
      period: null,
      notes: [`${input.name} is a format that cannot be read here. Ask the user for a CSV or a photo of the document.`],
    }
  }

  const messages: Msg[] = [
    {
      role: 'system',
      content: [
        'You read financial documents and report their line items by calling report_line_items exactly once.',
        'Rules:',
        '- Transcribe. Never infer a number that is not printed. If a figure is unreadable, set confidence "low" and describe the problem in `concern`.',
        '- One line item per row. Do not merge or split what the document shows.',
        '- Tax, tip, delivery and discounts are their own rows unless the instruction says otherwise. A discount is a negative amount.',
        '- Strip currency symbols; amounts are plain numbers. Indian formats like 1,20,450.50 are the single number 120450.50.',
        '- Put the printed grand total in documentTotal so the sum can be checked. Never adjust line items to make them agree.',
        '- Use the field names exactly as given: amount, title, notes, date, quantity, category, confidence, concern.',
        `- The destination file has these columns: ${input.columns.join(', ')}. Prefer titles and categories that fit them.`,
      ].join('\n'),
    },
  ]

  if (isText) {
    const text = input.bytes.toString('utf8')
    const table = parseTable(text, input.name)
    messages.push({
      role: 'user',
      content: [
        `Instruction: ${input.instruction}`,
        `File: ${input.name}`,
        table.rows.length
          ? `Parsed table (${table.rows.length} rows). Headers: ${table.headers.join(' | ')}\n${table.rows
              .slice(0, 300)
              .map((r) => table.headers.map((h) => r[h]).join(' | '))
              .join('\n')}`
          : `Raw contents:\n${text.slice(0, 20000)}`,
      ].join('\n\n'),
    })
  } else {
    messages.push({
      role: 'user',
      content: `Instruction: ${input.instruction}\nRead every line item from this document.`,
      images: [input.bytes.toString('base64')],
    })
  }

  const raw = await chatStructured<Record<string, unknown>>({
    model: image ? env.ollama.visionModel : env.ollama.extractModel,
    messages,
    toolName: 'report_line_items',
    description: 'Report every line item transcribed from the document. Call exactly once.',
    schema: EXTRACTION_SCHEMA,
    temperature: 0,
    numCtx: 32768,
    maxTokens: 6000,
  })

  if (!raw) {
    return { rows: [], documentTotal: null, currency: null, period: null, notes: ['The document reader could not produce a usable result. Ask the user to paste the figures instead.'] }
  }

  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .map(coerceRow)
    .filter((r): r is ExtractedRow => r !== null)

  const documentTotal = typeof raw.documentTotal === 'number' && Number.isFinite(raw.documentTotal) ? raw.documentTotal : null
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).map(String)

  const from = typeof raw.periodFrom === 'string' ? raw.periodFrom : undefined
  const to = typeof raw.periodTo === 'string' ? raw.periodTo : undefined

  // An arithmetic check we can do ourselves, so a mis-read surfaces before approval.
  if (documentTotal != null && rows.length > 0) {
    const sum = rows.reduce((s, r) => s + (r.amount ?? 0), 0)
    const gap = Math.round((documentTotal - sum) * 100) / 100
    if (Math.abs(gap) > 0.5) {
      notes.push(
        `The extracted rows add up to ${formatINR(sum)} but the document says ${formatINR(documentTotal)} — a gap of ${formatINR(Math.abs(gap))}. Something was probably missed or misread.`,
      )
    }
  }
  const lowConfidence = rows.filter((r) => r.confidence === 'low').length
  if (lowConfidence > 0) notes.push(`${lowConfidence} row(s) were hard to read — check them before approving.`)

  return {
    rows,
    documentTotal,
    currency: typeof raw.currency === 'string' ? raw.currency : null,
    period: from || to ? { from, to } : null,
    notes,
  }
}

// -------------------------------------------------------------------- analyst

/**
 * Read-only analysis over a document, with the arithmetic done in code.
 * The model gets pre-computed aggregates and writes the prose; it never adds
 * numbers up itself, which is where these answers usually go wrong.
 */
export async function runAnalyst(ctx: ToolCtx, question: string, fileId?: string): Promise<string> {
  const id = fileId ?? ctx.fileId
  if (!id) return 'No file is open, so there is nothing to analyse yet.'
  const doc = await ctx.repo.getDoc(id)
  const totals = computeTotals(doc)
  const rows = liveRows(doc)

  const groupables = doc.columns.filter((c) => c.kind === 'select' || c.kind === 'text')
  const breakdowns: Record<string, Array<{ key: string; total: number; count: number }>> = {}
  const amountCol = doc.columns.find((c) => c.kind === 'amount')

  if (amountCol) {
    for (const col of groupables.slice(0, 4)) {
      const map = new Map<string, { total: number; count: number }>()
      for (const r of rows) {
        const raw = r.cells[col.id]
        const key = raw == null || raw === '' ? '(blank)' : String(raw)
        const e = map.get(key) ?? { total: 0, count: 0 }
        e.total += Number(r.cells[amountCol.id] ?? 0) || 0
        e.count++
        map.set(key, e)
      }
      if (map.size > 1 && map.size <= 25) {
        breakdowns[col.name] = [...map.entries()]
          .map(([key, v]) => ({ key, total: Math.round(v.total * 100) / 100, count: v.count }))
          .sort((a, b) => b.total - a.total)
      }
    }
  }

  const top = amountCol
    ? [...rows]
        .sort((a, b) => (Number(b.cells[amountCol.id]) || 0) - (Number(a.cells[amountCol.id]) || 0))
        .slice(0, 8)
        .map((r) => ({
          title: String(r.cells[findColumn(doc, 'Title')?.id ?? ''] ?? '(untitled)'),
          amount: Number(r.cells[amountCol.id]) || 0,
        }))
    : []

  const { content } = await import('./ollama').then((m) =>
    m.chat({
      model: env.ollama.fastModel,
      temperature: 0.1,
      maxTokens: 700,
      messages: [
        {
          role: 'system',
          content:
            'You answer questions about an expense file using only the figures given. Every number in the data is already computed correctly — quote it, never recalculate. Lead with the answer. Amounts as ₹ with Indian grouping (₹1,20,450). Two to five sentences unless a breakdown genuinely needs a short list. No advice unless asked.',
        },
        {
          role: 'user',
          content: [
            `Question: ${question}`,
            '',
            `File: ${doc.name}`,
            doc.duration.enabled ? `Period: ${doc.duration.from ?? '?'} to ${doc.duration.to ?? '?'}` : 'No period set',
            `Rows: ${totals.count}`,
            `Total: ${totals.total}`,
            `Average: ${totals.mean}, largest: ${totals.max}, smallest: ${totals.min}`,
            '',
            'Largest rows:',
            ...top.map((t) => `  ${t.title}: ${t.amount}`),
            '',
            ...Object.entries(breakdowns).flatMap(([name, groups]) => [
              `Breakdown by ${name}:`,
              ...groups.map((g) => `  ${g.key}: ${g.total} (${g.count} rows)`),
            ]),
          ].join('\n'),
        },
      ],
    }),
  )
  return content.trim()
}

// ------------------------------------------------ specialist tools for the loop

export const extractTool: ToolDef = {
  name: 'extract_from_document',
  description:
    'Hand an attached receipt, invoice, statement or spreadsheet to the document reader and get back structured rows with per-row confidence. Use this instead of read_attachment when the goal is to add the contents as rows.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Attachment name; omit for the first file attached to this message.' },
      instruction: { type: 'string', description: 'What to pull out, e.g. "line items only, ignore the loyalty points section".' },
    },
  },
  async run(args, ctx): Promise<ToolResult> {
    const wanted = typeof args.name === 'string' ? args.name.toLowerCase() : ''
    const ref = wanted ? ctx.inbox.find((a) => a.name.toLowerCase().includes(wanted)) : ctx.inbox[0]
    if (!ref) return { kind: 'error', message: 'No document is attached to this message.' }

    const doc = ctx.fileId ? await ctx.repo.getDoc(ctx.fileId) : null
    const { bytes, mime, name } = await ctx.repo.getAttachment(ref)

    const result = await runExtractor({
      name,
      mime,
      bytes,
      instruction: typeof args.instruction === 'string' ? args.instruction : 'Extract every line item.',
      columns: doc?.columns.map((c) => c.name) ?? ['INR', 'Title', 'Extra Captions'],
    })

    return {
      kind: 'data',
      data: {
        source: name,
        rowsFound: result.rows.length,
        documentTotal: result.documentTotal,
        period: result.period,
        notes: result.notes,
        rows: result.rows,
        next: 'Show the user what was found — especially any low-confidence rows and any note about a total mismatch — then call add_rows.',
      },
    }
  },
}

export const analystTool: ToolDef = {
  name: 'deep_analysis',
  description:
    'Ask the analyst for a written answer about the numbers in a file. Use for open questions like "where did the money go" or "why is this month higher". For a single figure, compute_stats is cheaper.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string' }, fileId: { type: 'string' } },
    required: ['question'],
  },
  async run(args, ctx): Promise<ToolResult> {
    const answer = await runAnalyst(ctx, String(args.question), typeof args.fileId === 'string' ? args.fileId : undefined)
    return { kind: 'data', data: { answer }, display: answer }
  },
}
