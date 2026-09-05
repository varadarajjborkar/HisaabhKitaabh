import type { AttachmentRef, CellValue, Column, SheetDoc } from '../model/types'
import type { Op } from '../crdt/ops'
import { describeOp } from '../crdt/ops'
import { computeTotals, findColumn, liveRows, normalizeValue, numeric, parseAmount, SYSTEM_COLUMNS } from '../crdt/doc'
import { orderAfter, orderBetween, sortByOrder } from '../util/order'
import { shortId, ulid } from '../util/ids'
import type { Repo } from '../store/repo'
import type { ToolSpec } from './ollama'
import { formatINR } from '../util/format'
import { isImage, isTabularText } from '../util/mime'
import { parseTable } from '../util/table'
import { convertAmount, currencyCode, describeConversion, describeRate, rateFor } from '../util/currency'

/**
 * Tools available to the assistant.
 *
 * The split that matters is `mode`:
 *   - `read`  runs immediately. Reading the user's own data back to them needs
 *             no ceremony.
 *   - `write` never runs. It *plans*: it returns the exact operations it would
 *             apply plus a human-readable preview, and the runtime turns that
 *             into an approval prompt. The model cannot write to a document by
 *             any path that skips this.
 *
 * That asymmetry is the whole safety model. A confused model can waste a turn;
 * it cannot silently change a number in someone's ledger.
 */

export type ToolCtx = {
  repo: Repo
  userId: string
  /** The file the user currently has open, if any. Tools default to it. */
  fileId: string | null
  folderId: string | null
  /** Attachments uploaded with the current message, addressable by name or id. */
  inbox: AttachmentRef[]
}

export type ToolPlan = {
  fileId: string
  ops: Op[]
  summary: string
  preview: string[]
  /** Rendered before/after for the diff view in the approval card. */
  diff?: Array<{ label: string; before: string; after: string }>
}

export type ToolResult =
  | { kind: 'data'; data: unknown; display?: string }
  | { kind: 'plan'; plan: ToolPlan }
  | { kind: 'ask'; question: string; options: string[] }
  | { kind: 'error'; message: string }

export type ToolDef = {
  name: string
  description: string
  mode: 'read' | 'write' | 'meta'
  /** Shown in the approval card so the user knows what class of change this is. */
  risk: 'none' | 'low' | 'medium' | 'high'
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  run: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = parseAmount(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/**
 * Turn a fileId argument into a document.
 *
 * The failure path matters as much as the success path. A bare "File not found"
 * tells the model nothing about what to do next, and what it does next is
 * thrash: list files, list folders, guess another id, list files again. Naming
 * the file that *is* open, and saying plainly that ids are not to be guessed,
 * turns a dead end into a correction the model can act on in one step.
 */
/** Words models reach for when they mean "the one that is already open". */
const SELF_REFERENCES = new Set(['default', 'current', 'this', 'open', 'active', 'null', 'undefined', 'none'])

async function resolveDoc(ctx: ToolCtx, fileId?: unknown): Promise<SheetDoc> {
  const asked = str(fileId).trim()
  const selfReference = !asked || SELF_REFERENCES.has(asked.toLowerCase())
  const id = selfReference ? ctx.fileId : asked
  if (!id) throw new Error('No file is open. Call list_files to see what exists, then pass a real fileId. Do not invent one.')

  try {
    return await ctx.repo.getDoc(id)
  } catch {
    /*
     * Fall back to the file's name before giving up.
     *
     * Models pass the name where the id belongs constantly - "Souvenirs",
     * "default", the title from the last tool result - and each one used to
     * cost a failed call, a warning triangle in the transcript and a recovery
     * turn. It is the same file either way, and the user is watching. Resolve
     * the obvious intent, and reserve the error for a genuine miss.
     */
    const folderId = ctx.folderId
    if (folderId && asked) {
      const files = await ctx.repo.listFiles(folderId)
      const wanted = asked.toLowerCase()
      const hit = files.find((f) => f.name.toLowerCase() === wanted)
        ?? files.find((f) => f.name.toLowerCase().includes(wanted))
      if (hit) return ctx.repo.getDoc(hit.id)
    }

    const known = ctx.fileId
      ? `The file the user has open is "${ctx.fileId}" - leave fileId out to use it.`
      : 'Call list_files first and use an id from its result.'
    throw new Error(`There is no file with id "${asked || id}". ${known} File ids are opaque and cannot be guessed or constructed from a name.`)
  }
}

/** Render a row the way a person reads it, for previews and tool output. */
function renderRow(doc: SheetDoc, rowId: string): string {
  const row = doc.rows.find((r) => r.id === rowId)
  if (!row) return rowId
  return doc.columns
    .map((c) => {
      const v = row.cells[c.id]
      if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) return null
      return `${c.name}: ${c.kind === 'amount' ? formatINR(numeric(v)) : Array.isArray(v) ? `${v.length} file(s)` : v}`
    })
    .filter(Boolean)
    .join(' · ')
}

function compactDoc(doc: SheetDoc, rowLimit = 120) {
  const rows = liveRows(doc)
  const totals = computeTotals(doc)
  return {
    fileId: doc.id,
    name: doc.name,
    rev: doc.rev,
    currency: doc.currency,
    period: doc.duration.enabled ? doc.duration : null,
    columns: doc.columns.map((c) => ({ id: c.id, name: c.name, kind: c.kind, options: c.options })),
    rowCount: rows.length,
    total: totals.total,
    rows: rows.slice(0, rowLimit).map((r) => ({
      rowId: r.id,
      ...Object.fromEntries(doc.columns.map((c) => [c.name, displayValue(r.cells[c.id], c)])),
    })),
    truncated: rows.length > rowLimit ? `${rows.length - rowLimit} more rows not shown, use query_rows to filter` : undefined,
  }
}

function displayValue(v: CellValue, c: Column): unknown {
  if (v == null) return null
  if (Array.isArray(v)) return v.map((a) => a.name)
  if (c.kind === 'amount' || c.kind === 'number') return numeric(v)
  return v
}

/**
 * Map loose keys from the model onto real columns.
 * Returns matched cells plus the keys that had nowhere to go, so the model can
 * offer to add a column rather than dropping the user's data on the floor.
 */
function mapCells(doc: SheetDoc, input: Record<string, unknown>): { cells: Record<string, CellValue>; unmatched: string[] } {
  const cells: Record<string, CellValue> = {}
  const unmatched: string[] = []
  const aliases: Record<string, string> = {
    amount: SYSTEM_COLUMNS.amount, inr: SYSTEM_COLUMNS.amount, price: SYSTEM_COLUMNS.amount,
    cost: SYSTEM_COLUMNS.amount, value: SYSTEM_COLUMNS.amount, total: SYSTEM_COLUMNS.amount,
    title: SYSTEM_COLUMNS.title, name: SYSTEM_COLUMNS.title, item: SYSTEM_COLUMNS.title,
    description: SYSTEM_COLUMNS.title, what: SYSTEM_COLUMNS.title,
    notes: SYSTEM_COLUMNS.notes, note: SYSTEM_COLUMNS.notes, caption: SYSTEM_COLUMNS.notes,
    captions: SYSTEM_COLUMNS.notes, extra: SYSTEM_COLUMNS.notes, comment: SYSTEM_COLUMNS.notes,
  }

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    const direct = findColumn(doc, key)
    const aliased = !direct ? doc.columns.find((c) => c.id === aliases[key.trim().toLowerCase()]) : undefined
    const col = direct ?? aliased
    if (!col) {
      unmatched.push(key)
      continue
    }
    cells[col.id] = normalizeValue(value as CellValue, col)
  }
  return { cells, unmatched }
}

/**
 * Rewrite a call's amounts into the file's currency.
 *
 * Conversion happens here rather than in the model for two reasons. The rate
 * has to be looked up, and a model that guesses one is worse than useless; and
 * the arithmetic has to be right, which is not a thing to leave to a token
 * predictor when the output is somebody's money.
 *
 * The original figure and the rate are written into the notes column, because
 * "why is this row 84,096" is a question the file should be able to answer on
 * its own six months later.
 */
async function applyCurrency(
  doc: SheetDoc,
  cells: Record<string, CellValue>,
  from: string,
): Promise<{ cells: Record<string, CellValue>; note: string | null }> {
  const target = doc.currency || 'INR'
  const code = currencyCode(from)
  if (!code || code === target) return { cells, note: null }

  const amountCols = doc.columns.filter((c) => c.kind === 'amount')
  if (amountCols.length === 0) return { cells, note: null }

  const next = { ...cells }
  let note: string | null = null

  for (const col of amountCols) {
    const raw = next[col.id]
    if (raw == null || raw === '') continue
    const converted = await convertAmount(numeric(raw), code, target)
    next[col.id] = converted.amount
    note = describeConversion(converted)
  }

  if (note) {
    const notesCol = doc.columns.find((c) => c.id === SYSTEM_COLUMNS.notes)
    if (notesCol) {
      const existing = next[notesCol.id]
      next[notesCol.id] = existing == null || existing === '' ? note : `${String(existing)} (${note})`
    }
  }
  return { cells: next, note }
}

// ------------------------------------------------------------------ read tools

const listFolders: ToolDef = {
  name: 'list_folders',
  description: 'List the user\'s folders with their file counts. Use before creating a folder to avoid near-duplicates.',
  mode: 'read',
  risk: 'none',
  parameters: { type: 'object', properties: {} },
  async run(_args, ctx) {
    const folders = await ctx.repo.listFolders()
    return {
      kind: 'data',
      data: folders.map((f) => ({ folderId: f.id, name: f.name, files: f.fileCount, sample: f.sample ?? false })),
    }
  },
}

const listFiles: ToolDef = {
  name: 'list_files',
  description: 'List files, optionally inside one folder. Returns row counts and totals so you can answer "which file has X" without opening each one.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: { folderId: { type: 'string', description: 'Omit to list files across all folders.' } },
  },
  async run(args, ctx) {
    const folderId = str(args.folderId) || undefined
    const files = folderId ? await ctx.repo.listFiles(folderId) : await ctx.repo.listAllFiles()
    return {
      kind: 'data',
      data: files.map((f) => ({ fileId: f.id, folderId: f.folderId, name: f.name, rows: f.rowCount, total: f.total })),
    }
  },
}

const getFile: ToolDef = {
  name: 'get_file',
  description: 'Read a file: its columns, rows, period and total. Call this before any edit so you use real column names and row ids.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: { fileId: { type: 'string', description: 'Defaults to the file the user has open.' } },
  },
  async run(args, ctx) {
    return { kind: 'data', data: compactDoc(await resolveDoc(ctx, args.fileId)) }
  },
}

const listColumns: ToolDef = {
  name: 'list_columns',
  description: 'List just the columns of a file. Cheaper than get_file when you only need the schema.',
  mode: 'read',
  risk: 'none',
  parameters: { type: 'object', properties: { fileId: { type: 'string' } } },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    return { kind: 'data', data: doc.columns.map((c) => ({ id: c.id, name: c.name, kind: c.kind, system: !!c.system, options: c.options })) }
  },
}

const queryRows: ToolDef = {
  name: 'query_rows',
  description: 'Find rows matching criteria. Always use this before a bulk edit so you know exactly what will change, and report the count to the user.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      contains: { type: 'string', description: 'Free text matched against every cell.' },
      column: { type: 'string', description: 'Restrict `contains`/`equals` to one column (by name).' },
      equals: { type: 'string' },
      minAmount: { type: 'number' },
      maxAmount: { type: 'number' },
      isEmpty: { type: 'string', description: 'Column name that must be empty.' },
      limit: { type: 'number', description: 'Default 50.' },
    },
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const limit = Math.min(Number(args.limit) || 50, 300)
    const col = args.column ? findColumn(doc, str(args.column)) : undefined
    const emptyCol = args.isEmpty ? findColumn(doc, str(args.isEmpty)) : undefined
    const needle = str(args.contains).toLowerCase()
    const equals = str(args.equals).toLowerCase()
    const amountCol = doc.columns.find((c) => c.kind === 'amount')

    const matches = liveRows(doc).filter((r) => {
      if (needle) {
        const haystack = col
          ? String(r.cells[col.id] ?? '')
          : doc.columns.map((c) => String(r.cells[c.id] ?? '')).join(' ')
        if (!haystack.toLowerCase().includes(needle)) return false
      }
      if (equals && col && String(r.cells[col.id] ?? '').toLowerCase() !== equals) return false
      if (emptyCol) {
        const v = r.cells[emptyCol.id]
        if (!(v == null || v === '' || (Array.isArray(v) && v.length === 0))) return false
      }
      if (amountCol && args.minAmount != null && numeric(r.cells[amountCol.id]) < Number(args.minAmount)) return false
      if (amountCol && args.maxAmount != null && numeric(r.cells[amountCol.id]) > Number(args.maxAmount)) return false
      return true
    })

    const sum = amountCol ? matches.reduce((s, r) => s + numeric(r.cells[amountCol.id]), 0) : 0
    return {
      kind: 'data',
      data: {
        matchCount: matches.length,
        matchedTotal: Math.round(sum * 100) / 100,
        rows: matches.slice(0, limit).map((r) => ({
          rowId: r.id,
          ...Object.fromEntries(doc.columns.map((c) => [c.name, displayValue(r.cells[c.id], c)])),
        })),
        truncated: matches.length > limit,
      },
    }
  },
}

const computeStats: ToolDef = {
  name: 'compute_stats',
  description: 'Totals and breakdowns computed from the real data. Use this instead of doing arithmetic yourself.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      groupBy: { type: 'string', description: 'Column name to break the total down by.' },
    },
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const totals = computeTotals(doc)
    const amountCol = doc.columns.find((c) => c.kind === 'amount')
    const groupCol = args.groupBy ? findColumn(doc, str(args.groupBy)) : undefined

    let groups: Array<{ key: string; total: number; count: number; share: number }> | undefined
    if (groupCol && amountCol) {
      const map = new Map<string, { total: number; count: number }>()
      for (const r of liveRows(doc)) {
        const raw = r.cells[groupCol.id]
        const key = raw == null || raw === '' ? '(not set)' : Array.isArray(raw) ? `${raw.length} file(s)` : String(raw)
        const entry = map.get(key) ?? { total: 0, count: 0 }
        entry.total += numeric(r.cells[amountCol.id])
        entry.count += 1
        map.set(key, entry)
      }
      groups = [...map.entries()]
        .map(([key, v]) => ({ key, total: Math.round(v.total * 100) / 100, count: v.count, share: totals.total ? Math.round((v.total / totals.total) * 1000) / 10 : 0 }))
        .sort((a, b) => b.total - a.total)
    }

    return {
      kind: 'data',
      data: {
        file: doc.name,
        period: doc.duration.enabled ? doc.duration : null,
        total: totals.total,
        rows: totals.count,
        average: totals.mean,
        largest: totals.max,
        smallest: totals.min,
        groups,
      },
    }
  },
}

const readAttachment: ToolDef = {
  name: 'read_attachment',
  description: 'Read a file the user attached to this message, or one stored on a row. CSV/TSV/JSON/text is parsed into a table; images are returned for the vision model. Never guess at contents you have not read.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Attachment file name, or omit to read the first one attached to this message.' },
      rowId: { type: 'string', description: 'Read an attachment stored on this row instead.' },
      column: { type: 'string' },
    },
  },
  async run(args, ctx) {
    let ref: AttachmentRef | undefined
    if (args.rowId) {
      const doc = await resolveDoc(ctx, undefined)
      const row = doc.rows.find((r) => r.id === str(args.rowId))
      const col = args.column ? findColumn(doc, str(args.column)) : doc.columns.find((c) => c.kind === 'attachment')
      const value = row && col ? row.cells[col.id] : null
      ref = Array.isArray(value) ? value[0] : undefined
    } else {
      const wanted = str(args.name).toLowerCase()
      ref = wanted ? ctx.inbox.find((a) => a.name.toLowerCase().includes(wanted)) : ctx.inbox[0]
    }
    if (!ref) return { kind: 'error', message: 'No such attachment. Ask the user to attach the file again.' }

    const { bytes, mime, name } = await ctx.repo.getAttachment(ref)

    if (isTabularText(name, mime)) {
      const text = bytes.toString('utf8')
      const table = parseTable(text, name)
      return {
        kind: 'data',
        data: {
          name,
          mime,
          kind: 'table',
          headers: table.headers,
          rowCount: table.rows.length,
          rows: table.rows.slice(0, 200),
          truncated: table.rows.length > 200,
          rawPreview: table.rows.length === 0 ? text.slice(0, 4000) : undefined,
        },
      }
    }
    if (isImage(mime)) {
      return {
        kind: 'data',
        data: { name, mime, kind: 'image', imageBase64: bytes.toString('base64'), note: 'Image handed to the vision model.' },
      }
    }
    return {
      kind: 'data',
      data: {
        name,
        mime,
        kind: 'binary',
        size: bytes.length,
        note: 'This format cannot be read as text here. Ask the user to paste the figures, or to attach a CSV or a photo of the document.',
      },
    }
  },
}

const buildExport: ToolDef = {
  name: 'build_export',
  description: 'Produce a formatted rendering of a file for pasting, printing or emailing.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      format: { type: 'string', enum: ['markdown', 'csv', 'email'], description: 'Default markdown.' },
    },
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const { toMarkdown, toCsv, toEmail } = await import('../util/export')
    const format = str(args.format, 'markdown')
    const content = format === 'csv' ? toCsv(doc) : format === 'email' ? toEmail(doc).body : toMarkdown(doc)
    return { kind: 'data', data: { format, content }, display: content.slice(0, 4000) }
  },
}

// ----------------------------------------------------------------- write tools

const addRows: ToolDef = {
  name: 'add_rows',
  description:
    'Add one or more rows. Each row is an object keyed by column name - e.g. {"INR": 450, "Title": "Cab", "Paid via": "UPI"}. Amounts are totals already; never multiply by quantity. Keys that match no column are reported back rather than dropped. If the user gave amounts in another currency, pass the amounts unchanged and set `currency` - the conversion is done here at today\'s rate.',
  mode: 'write',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      rows: {
        type: 'array',
        description: 'Rows to add, each an object of column name -> value.',
        items: { type: 'object' },
      },
      currency: {
        type: 'string',
        description: "The currency the amounts in this call are written in. Omit when they are already in the file's currency.",
      },
    },
    required: ['rows'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const inputs = arr<Record<string, unknown>>(args.rows)
    if (inputs.length === 0) return { kind: 'error', message: 'No rows were supplied.' }
    if (inputs.length > 200) return { kind: 'error', message: 'That is more than 200 rows. Split it across several calls.' }
    const currency = str(args.currency)

    const visible = sortByOrder(liveRows(doc))
    let cursor: string | null = visible.length ? visible[visible.length - 1].order : null

    const ops: Op[] = []
    const preview: string[] = []
    const unmatchedAll = new Set<string>()

    let conversion: string | null = null
    for (const input of inputs) {
      const mapped = mapCells(doc, input)
      mapped.unmatched.forEach((u) => unmatchedAll.add(u))
      if (Object.keys(mapped.cells).length === 0) continue

      let cells = mapped.cells
      if (currency) {
        try {
          const applied = await applyCurrency(doc, cells, currency)
          cells = applied.cells
          conversion = applied.note ?? conversion
        } catch (err) {
          return { kind: 'error', message: (err as Error).message }
        }
      }
      cursor = orderAfter(cursor)
      const rowId = ulid()
      ops.push({ id: shortId(12), type: 'row.insert', rowId, order: cursor, cells })
      preview.push(
        doc.columns
          .filter((c) => cells[c.id] != null && cells[c.id] !== '')
          .map((c) => `${c.name}: ${c.kind === 'amount' ? formatINR(numeric(cells[c.id])) : cells[c.id]}`)
          .join(' · '),
      )
    }
    if (ops.length === 0) {
      return { kind: 'error', message: `None of those keys matched a column. Columns are: ${doc.columns.map((c) => c.name).join(', ')}. Add a column first if you need one.` }
    }

    const amountCol = doc.columns.find((c) => c.kind === 'amount')
    const added = amountCol
      ? ops.reduce((s, o) => s + (o.type === 'row.insert' ? numeric(o.cells?.[amountCol.id] ?? null) : 0), 0)
      : 0

    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops,
        summary: `Add ${ops.length} row${ops.length === 1 ? '' : 's'} to "${doc.name}"${added ? `, ${formatINR(added)} in total` : ''}${conversion ? ` - converted from ${conversion}` : ''}${unmatchedAll.size ? ` - ignoring unknown field${unmatchedAll.size === 1 ? '' : 's'}: ${[...unmatchedAll].join(', ')}` : ''}`,
        preview,
      },
    }
  },
}

const updateRows: ToolDef = {
  name: 'update_rows',
  description:
    'Change cells on existing rows. Pass rowIds from get_file or query_rows - never invent one. Batch every row of a bulk edit into one call so the user can undo it in one step. Set `currency` if the new amounts are written in something other than the file\'s currency.',
  mode: 'write',
  risk: 'high',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      updates: {
        type: 'array',
        description: 'Each entry: {"rowId": "...", "set": {"Column name": value}}',
        items: {
          type: 'object',
          properties: { rowId: { type: 'string' }, set: { type: 'object' } },
          required: ['rowId', 'set'],
        },
      },
      currency: {
        type: 'string',
        description: "The currency the new amounts are written in. Omit when they are already in the file's currency.",
      },
    },
    required: ['updates'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const updates = arr<{ rowId: string; set: Record<string, unknown> }>(args.updates)
    const currency = str(args.currency)
    const ops: Op[] = []
    const diff: Array<{ label: string; before: string; after: string }> = []
    const missing: string[] = []

    for (const u of updates) {
      const row = doc.rows.find((r) => r.id === u.rowId && !r.deleted)
      if (!row) {
        missing.push(u.rowId)
        continue
      }
      let cells = mapCells(doc, u.set ?? {}).cells
      if (currency) {
        try {
          cells = (await applyCurrency(doc, cells, currency)).cells
        } catch (err) {
          return { kind: 'error', message: (err as Error).message }
        }
      }
      for (const [columnId, value] of Object.entries(cells)) {
        const col = doc.columns.find((c) => c.id === columnId)!
        const before = row.cells[columnId]
        if (JSON.stringify(before ?? null) === JSON.stringify(value ?? null)) continue
        ops.push({ id: shortId(12), type: 'cell.set', rowId: u.rowId, columnId, value })
        diff.push({
          label: `${renderRow(doc, u.rowId).slice(0, 60)} - ${col.name}`,
          before: before == null || before === '' ? '(empty)' : String(col.kind === 'amount' ? formatINR(numeric(before)) : before),
          after: value == null || value === '' ? '(empty)' : String(col.kind === 'amount' ? formatINR(numeric(value)) : value),
        })
      }
    }

    if (ops.length === 0) {
      return {
        kind: 'error',
        message: missing.length
          ? `No rows matched those ids (${missing.slice(0, 3).join(', ')}). Call query_rows or get_file to get real row ids.`
          : 'Those values are already what the rows contain - nothing to change.',
      }
    }
    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops,
        summary: `Change ${ops.length} cell${ops.length === 1 ? '' : 's'} across ${new Set(ops.map((o) => (o as { rowId: string }).rowId)).size} row(s) in "${doc.name}"`,
        preview: diff.map((d) => `${d.label}: ${d.before} → ${d.after}`),
        diff,
      },
    }
  },
}

const deleteRows: ToolDef = {
  name: 'delete_rows',
  description: 'Delete rows by id. List what will be removed to the user before calling this. Deletions are recoverable via undo but should still never be a surprise.',
  mode: 'write',
  risk: 'high',
  parameters: {
    type: 'object',
    properties: { fileId: { type: 'string' }, rowIds: { type: 'array', items: { type: 'string' } } },
    required: ['rowIds'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const ids = arr<string>(args.rowIds).filter((id) => doc.rows.some((r) => r.id === id && !r.deleted))
    if (ids.length === 0) return { kind: 'error', message: 'None of those row ids exist in this file.' }

    const amountCol = doc.columns.find((c) => c.kind === 'amount')
    const removed = amountCol
      ? ids.reduce((s, id) => s + numeric(doc.rows.find((r) => r.id === id)?.cells[amountCol.id] ?? null), 0)
      : 0

    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops: ids.map((rowId) => ({ id: shortId(12), type: 'row.delete', rowId }) as Op),
        summary: `Delete ${ids.length} row${ids.length === 1 ? '' : 's'} from "${doc.name}"${removed ? `, removing ${formatINR(removed)} from the total` : ''}`,
        preview: ids.map((id) => renderRow(doc, id)),
      },
    }
  },
}

const addColumn: ToolDef = {
  name: 'add_column',
  description:
    'Add a column. Kinds: amount (money), number, text, date, select (fixed options), attachment (files). Only add one when the user has data with nowhere to live, and say why.',
  mode: 'write',
  risk: 'medium',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      name: { type: 'string' },
      kind: { type: 'string', enum: ['amount', 'number', 'text', 'date', 'select', 'attachment'] },
      options: { type: 'array', items: { type: 'string' }, description: 'Required for kind=select.' },
    },
    required: ['name', 'kind'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const name = str(args.name).trim()
    if (!name) return { kind: 'error', message: 'A column needs a name.' }
    if (doc.columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      return { kind: 'error', message: `A column called "${name}" already exists. Use it instead of adding another.` }
    }
    const kind = str(args.kind, 'text') as Column['kind']
    const last = doc.columns.map((c) => c.order).sort().pop() ?? null
    const column: Column = {
      id: `c_${shortId(6).toLowerCase()}`,
      name,
      kind,
      order: orderAfter(last),
      ...(kind === 'select' ? { options: arr<string>(args.options) } : {}),
    }
    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops: [{ id: shortId(12), type: 'column.insert', column }],
        summary: `Add a ${kind} column called "${name}" to "${doc.name}"`,
        preview: [`New column: ${name} (${kind})${column.options?.length ? ` - options: ${column.options.join(', ')}` : ''}`],
      },
    }
  },
}

const renameColumn: ToolDef = {
  name: 'rename_column',
  description: 'Rename a column. The data in it is untouched.',
  mode: 'write',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { fileId: { type: 'string' }, column: { type: 'string' }, newName: { type: 'string' } },
    required: ['column', 'newName'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const col = findColumn(doc, str(args.column))
    if (!col) return { kind: 'error', message: `No column called "${str(args.column)}". Columns: ${doc.columns.map((c) => c.name).join(', ')}` }
    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops: [{ id: shortId(12), type: 'column.rename', columnId: col.id, name: str(args.newName) }],
        summary: `Rename column "${col.name}" to "${str(args.newName)}"`,
        preview: [`${col.name} → ${str(args.newName)}`],
      },
    }
  },
}

const deleteColumn: ToolDef = {
  name: 'delete_column',
  description: 'Delete a column and every value in it. The three built-in columns cannot be deleted.',
  mode: 'write',
  risk: 'high',
  parameters: {
    type: 'object',
    properties: { fileId: { type: 'string' }, column: { type: 'string' } },
    required: ['column'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const col = findColumn(doc, str(args.column))
    if (!col) return { kind: 'error', message: `No column called "${str(args.column)}".` }
    if (col.system) return { kind: 'error', message: `"${col.name}" is a built-in column and cannot be removed.` }
    const filled = liveRows(doc).filter((r) => r.cells[col.id] != null && r.cells[col.id] !== '').length
    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops: [{ id: shortId(12), type: 'column.delete', columnId: col.id }],
        summary: `Delete column "${col.name}" and the ${filled} value${filled === 1 ? '' : 's'} in it`,
        preview: [`Removes "${col.name}" from all ${liveRows(doc).length} rows`],
      },
    }
  },
}

const setPeriod: ToolDef = {
  name: 'set_period',
  description: 'Turn the file period on or off and set its range. Dates are YYYY-MM-DD; months are YYYY-MM.',
  mode: 'write',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: {
      fileId: { type: 'string' },
      enabled: { type: 'boolean' },
      mode: { type: 'string', enum: ['date', 'month'] },
      from: { type: 'string' },
      to: { type: 'string' },
    },
    required: ['enabled'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    const duration = {
      enabled: Boolean(args.enabled),
      mode: (str(args.mode, doc.duration.mode) as 'date' | 'month'),
      from: str(args.from) || undefined,
      to: str(args.to) || undefined,
    }
    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops: [{ id: shortId(12), type: 'doc.duration', duration }],
        summary: duration.enabled ? `Set the period of "${doc.name}" to ${duration.from ?? '…'} → ${duration.to ?? '…'}` : `Turn off the period on "${doc.name}"`,
        preview: [duration.enabled ? `${duration.mode} range: ${duration.from ?? '(open)'} to ${duration.to ?? '(open)'}` : 'Period disabled'],
      },
    }
  },
}

const renameFile: ToolDef = {
  name: 'rename_file',
  description: 'Rename a file.',
  mode: 'write',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { fileId: { type: 'string' }, name: { type: 'string' } },
    required: ['name'],
  },
  async run(args, ctx) {
    const doc = await resolveDoc(ctx, args.fileId)
    return {
      kind: 'plan',
      plan: {
        fileId: doc.id,
        ops: [{ id: shortId(12), type: 'doc.rename', name: str(args.name) }],
        summary: `Rename "${doc.name}" to "${str(args.name)}"`,
        preview: [`${doc.name} → ${str(args.name)}`],
      },
    }
  },
}

/**
 * Structural creates don't produce document ops, so they carry a `create`
 * marker the runtime executes after approval. They still go through the same
 * approval gate as everything else that writes.
 */
const createFile: ToolDef = {
  name: 'create_file',
  description: 'Create a new empty file inside a folder.',
  mode: 'write',
  risk: 'low',
  parameters: {
    type: 'object',
    properties: { folderId: { type: 'string' }, name: { type: 'string' } },
    required: ['name'],
  },
  async run(args, ctx) {
    const folderId = str(args.folderId) || ctx.folderId
    if (!folderId) return { kind: 'error', message: 'Which folder? Call list_folders and ask the user.' }
    const folder = await ctx.repo.getFolder(folderId)
    return {
      kind: 'plan',
      plan: {
        fileId: `create:file:${folderId}:${str(args.name)}`,
        ops: [],
        summary: `Create a file called "${str(args.name)}" in "${folder.name}"`,
        preview: [`New file in ${folder.name}: ${str(args.name)}`],
      },
    }
  },
}

const createFolder: ToolDef = {
  name: 'create_folder',
  description: 'Create a new folder. Check list_folders first, because a near-duplicate folder costs the user later.',
  mode: 'write',
  risk: 'low',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  async run(args, ctx) {
    const name = str(args.name).trim()
    if (!name) return { kind: 'error', message: 'A folder needs a name.' }
    const existing = (await ctx.repo.listFolders()).find((f) => f.name.toLowerCase() === name.toLowerCase())
    if (existing) return { kind: 'error', message: `"${existing.name}" already exists. Use folderId ${existing.id}.` }
    return {
      kind: 'plan',
      plan: {
        fileId: `create:folder:${name}`,
        ops: [],
        summary: `Create a folder called "${name}"`,
        preview: [`New folder: ${name}`],
      },
    }
  },
}

const convertCurrency: ToolDef = {
  name: 'convert_currency',
  description:
    'Look up today\'s published exchange rate and convert an amount. Use it whenever a user names an amount in a currency other than the file\'s - never ask them what the rate is, and never guess one.',
  mode: 'read',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: {
      amount: { type: 'number', description: 'Omit to get the rate for one unit.' },
      from: { type: 'string', description: 'Currency the amount is in. A code like USD, or what the user wrote ($, dollars).' },
      to: { type: 'string', description: 'Currency to convert into. Defaults to the open file\'s currency.' },
    },
    required: ['from'],
  },
  async run(args, ctx) {
    const to = str(args.to) || (ctx.fileId ? (await resolveDoc(ctx, ctx.fileId)).currency : 'INR') || 'INR'
    const from = str(args.from)
    const amount = args.amount == null ? null : numeric(args.amount as CellValue)

    try {
      if (amount == null) {
        const rate = await rateFor(from, to)
        return { kind: 'data', data: { rate: rate.rate, from: rate.from, to: rate.to, asOf: rate.asOf, source: rate.source, describe: describeRate(rate) } }
      }
      const converted = await convertAmount(amount, from, to)
      return {
        kind: 'data',
        data: {
          original: converted.original,
          from: converted.rate.from,
          converted: converted.amount,
          to: converted.rate.to,
          rate: converted.rate.rate,
          asOf: converted.rate.asOf,
          source: converted.rate.source,
          describe: describeRate(converted.rate),
        },
      }
    } catch (err) {
      return { kind: 'error', message: (err as Error).message }
    }
  },
}

// ------------------------------------------------------------------ meta tools

const askUser: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the user a question when the answer changes what you would do and you cannot settle it from the data. Do not use it for things you can look up with a read tool, or to ask permission - writes are already gated.',
  mode: 'meta',
  risk: 'none',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete choices.' },
    },
    required: ['question'],
  },
  async run(args) {
    return { kind: 'ask', question: str(args.question), options: arr<string>(args.options).slice(0, 4) }
  },
}

export const TOOLS: ToolDef[] = [
  listFolders, listFiles, getFile, listColumns, queryRows, computeStats, readAttachment, buildExport,
  addRows, updateRows, deleteRows, addColumn, renameColumn, deleteColumn, setPeriod, renameFile,
  createFile, createFolder, convertCurrency,
  askUser,
]

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

/** Tools every request gets regardless of which skill matched. */
export const ALWAYS_TOOLS = ['get_file', 'list_folders', 'list_files', 'query_rows', 'compute_stats', 'convert_currency', 'ask_user']

export function toolSpecs(names: string[]): ToolSpec[] {
  return names
    .map((n) => TOOL_MAP.get(n))
    .filter((t): t is ToolDef => Boolean(t))
    .map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
}

export function describePlanOps(plan: ToolPlan, doc: SheetDoc): string[] {
  return plan.ops.map((op) => describeOp(op, doc.columns, doc.rows))
}

export { renderRow }
