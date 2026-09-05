import type { SheetDoc } from '../model/types'
import { computeTotals, liveRows, numeric } from '../crdt/doc'
import { formatDate, formatINR } from './format'
import { toDelimited } from './table'

/**
 * Export renderers.
 *
 * Every format carries the same header block (name, period, row count, total)
 * because a table of numbers with no total is not something anyone can act on
 * at the other end.
 */

const BLANK = '-'

/** "4 Oct 2025 to 9 Oct 2025", or one date when only one end is set. */
function periodText(doc: SheetDoc): string | null {
  const d = doc.duration
  if (!d.enabled || (!d.from && !d.to)) return null
  const from = d.from ? formatDate(d.from) : null
  const to = d.to ? formatDate(d.to) : null
  if (from && to) return `${from} to ${to}`
  return from ?? to
}

function header(doc: SheetDoc): { title: string; lines: string[]; totals: ReturnType<typeof computeTotals> } {
  const totals = computeTotals(doc)
  const lines = [`Rows: ${totals.count}`, `Total: ${formatINR(totals.total)}`]
  const period = periodText(doc)
  if (period) lines.unshift(`Period: ${period}`)
  return { title: doc.name, lines, totals }
}

function cellText(doc: SheetDoc, rowId: string, columnId: string): string {
  const row = doc.rows.find((r) => r.id === rowId)
  const col = doc.columns.find((c) => c.id === columnId)
  if (!row || !col) return ''
  const v = row.cells[columnId]
  if (v == null || v === '') return ''
  if (Array.isArray(v)) return v.map((a) => a.name).join('; ')
  if (col.kind === 'amount') return formatINR(numeric(v), { symbol: false })
  if (col.kind === 'date') return formatDate(String(v))
  return String(v)
}

export function toMarkdown(doc: SheetDoc): string {
  const { title, lines, totals } = header(doc)
  const rows = liveRows(doc)
  const cols = doc.columns
  const table = [
    `| ${cols.map((c) => c.name).join(' | ')} |`,
    `| ${cols.map((c) => (c.kind === 'amount' || c.kind === 'number' ? '---:' : '---')).join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map((c) => cellText(doc, r.id, c.id) || BLANK).join(' | ')} |`),
    `| ${cols.map((c, i) => (i === 0 ? `**${formatINR(totals.total, { symbol: false })}**` : i === 1 ? '**Total**' : '')).join(' | ')} |`,
  ].join('\n')
  return [`# ${title}`, '', ...lines, '', table].join('\n')
}

export function toCsv(doc: SheetDoc): string {
  const rows = liveRows(doc)
  const headers = doc.columns.map((c) => c.name)
  const body = rows.map((r) => doc.columns.map((c) => cellText(doc, r.id, c.id)))
  const totals = computeTotals(doc)
  const totalRow = doc.columns.map((c, i) =>
    c.kind === 'amount' ? String(totals.total) : i === 1 ? 'TOTAL' : '',
  )
  return toDelimited(headers, [...body, [], totalRow])
}

/**
 * Plain-text layout with aligned columns: what "Copy" puts on the clipboard.
 *
 * This one keeps the grid, because the clipboard's usual destinations (a code
 * block, a terminal, a monospaced note, a spreadsheet paste) either render it
 * in a fixed-pitch font or split it back into columns. Widths are capped so one
 * long caption cannot push the money column off the right of the screen.
 */
const MAX_COL_WIDTH = 34
const GAP = '  '

export function toPlainText(doc: SheetDoc): string {
  const { title, lines, totals } = header(doc)
  const rows = liveRows(doc)
  const cols = doc.columns

  const clip = (s: string) => (s.length > MAX_COL_WIDTH ? `${s.slice(0, MAX_COL_WIDTH - 1)}…` : s)
  const grid = [
    cols.map((c) => clip(c.name)),
    ...rows.map((r) => cols.map((c) => clip(cellText(doc, r.id, c.id) || BLANK))),
  ]
  const widths = cols.map((_, i) => Math.max(...grid.map((r) => (r[i] ?? '').length)))
  const numericCol = cols.map((c) => c.kind === 'amount' || c.kind === 'number')

  const line = (cells: string[]) =>
    cells.map((cell, i) => (numericCol[i] ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join(GAP).trimEnd()

  const rule = widths.map((w) => '-'.repeat(w)).join(GAP)
  const footer = cols.map((c, i) =>
    c.kind === 'amount' ? formatINR(totals.total, { symbol: false }) : i === 1 ? 'TOTAL' : '',
  )

  return [
    title,
    '='.repeat(Math.min(title.length, 60)),
    ...lines,
    '',
    line(grid[0]),
    rule,
    ...grid.slice(1).map(line),
    rule,
    line(footer),
  ].join('\n')
}

/**
 * The mail draft.
 *
 * Deliberately *not* the aligned grid. A mailto: body is plain text, and every
 * mail client renders plain text in a proportional font, so padded spaces line
 * nothing up: the columns fan out and the amounts stop sitting under each
 * other, which is exactly how the old draft came out.
 *
 * So the table is turned on its side. One block per row, the title first, the
 * amount on its own line beneath it, then only the fields that actually hold
 * something, each labelled. That reads correctly in any font at any width,
 * wraps without losing which value belongs to which label, and drops the row of
 * placeholder dashes that made up half the old body.
 */
export function toEmail(doc: SheetDoc): { subject: string; body: string } {
  const { title, totals } = header(doc)
  const rows = liveRows(doc)
  const cols = doc.columns
  const period = periodText(doc)

  const amountCol = cols.find((c) => c.kind === 'amount')
  const titleCol = cols.find((c) => c.kind === 'text' && c.system) ?? cols.find((c) => c.id !== amountCol?.id)
  const extras = cols.filter((c) => c.id !== amountCol?.id && c.id !== titleCol?.id)

  const blocks = rows.map((row, i) => {
    const name = (titleCol && cellText(doc, row.id, titleCol.id)) || 'Untitled'
    const lines = [`${i + 1}. ${name}`]
    if (amountCol) lines.push(`   ${formatINR(numeric(row.cells[amountCol.id]))}`)
    for (const col of extras) {
      const value = cellText(doc, row.id, col.id)
      if (value) lines.push(`   ${col.name}: ${value}`)
    }
    return lines.join('\n')
  })

  const summary = [
    period ? `Period: ${period}` : null,
    `Rows: ${totals.count}`,
    `Total: ${formatINR(totals.total)}`,
  ].filter(Boolean) as string[]

  const body = [
    title,
    '',
    ...summary,
    '',
    ...(blocks.length ? [blocks.join('\n\n'), ''] : ['No rows yet.', '']),
    `Total: ${formatINR(totals.total)} across ${totals.count} row${totals.count === 1 ? '' : 's'}`,
    '',
    'made from HisaabKitaab',
  ].join('\n')

  return { subject: `${title}${period ? ` (${period})` : ''}`, body }
}

/** Self-contained HTML for the print-to-PDF path. No PDF library shipped to the client. */
export function toPrintableHtml(doc: SheetDoc): string {
  const { title, lines, totals } = header(doc)
  const rows = liveRows(doc)
  const cols = doc.columns
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const alignRight = (c: (typeof cols)[number]) => (c.kind === 'amount' || c.kind === 'number' ? ' style="text-align:right"' : '')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
  @page { size: A4; margin: 14mm; }
  body { font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; color: #16181d; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .meta { color: #5b6270; font-size: 11px; margin-bottom: 14px; }
  .meta span { margin-right: 14px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #5b6270;
       border-bottom: 1.5px solid #cfd4dc; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #eceef2; vertical-align: top; }
  tfoot td { border-top: 1.5px solid #cfd4dc; border-bottom: none; font-weight: 600; padding-top: 9px; }
  tr { page-break-inside: avoid; }
  .num { font-variant-numeric: tabular-nums; }
  .foot { margin-top: 16px; color: #8b919d; font-size: 10px; }
  </style></head><body>
  <h1>${esc(title)}</h1>
  <div class="meta">${lines.map((l) => `<span>${esc(l)}</span>`).join('')}</div>
  <table>
    <thead><tr>${cols.map((c) => `<th${alignRight(c)}>${esc(c.name)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${cols.map((c) => `<td${alignRight(c)} class="${c.kind === 'amount' ? 'num' : ''}">${esc(cellText(doc, r.id, c.id))}</td>`).join('')}</tr>`)
      .join('')}</tbody>
    <tfoot><tr>${cols
      .map((c, i) =>
        c.kind === 'amount'
          ? `<td style="text-align:right" class="num">${esc(formatINR(totals.total))}</td>`
          : `<td>${i === 1 ? 'Total' : ''}</td>`,
      )
      .join('')}</tr></tfoot>
  </table>
  <p class="foot">made from HisaabKitaab</p>
  </body></html>`
}
