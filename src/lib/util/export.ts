import type { SheetDoc } from '../model/types'
import { computeTotals, liveRows, numeric } from '../crdt/doc'
import { formatDate, formatMoney } from './format'
import { toDelimited } from './table'
import { displayWidth, layoutTable, type TextColumn } from './textTable'

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
  const lines = [`Rows: ${totals.count}`, `Total: ${formatMoney(totals.total, doc.currency)}`]
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
  if (col.kind === 'amount') return formatMoney(numeric(v), doc.currency, { symbol: false })
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
    `| ${cols.map((c, i) => (i === 0 ? `**${formatMoney(totals.total, doc.currency, { symbol: false })}**` : i === 1 ? '**Total**' : '')).join(' | ')} |`,
  ].join('\n')
  return [`# ${title}`, '', ...lines, '', table].join('\n')
}

/**
 * CSV, for a machine to read.
 *
 * Amounts go out unformatted - 8900, not "8,900". A grouped figure is a string
 * as far as every spreadsheet is concerned, so a column of them sums to zero,
 * which is a nasty thing to discover after importing a year of expenses. The
 * separators are for reading on a screen, and this file is not that.
 */
function csvCell(doc: SheetDoc, rowId: string, columnId: string): string {
  const col = doc.columns.find((c) => c.id === columnId)
  const row = doc.rows.find((r) => r.id === rowId)
  if (!col || !row) return ''
  const v = row.cells[columnId]
  if (v == null || v === '') return ''
  if (col.kind === 'amount' || col.kind === 'number') {
    const n = numeric(v)
    return Number.isFinite(n) ? String(n) : ''
  }
  return cellText(doc, rowId, columnId)
}

export function toCsv(doc: SheetDoc): string {
  const rows = liveRows(doc)
  const headers = doc.columns.map((c) => c.name)
  const body = rows.map((r) => doc.columns.map((c) => csvCell(doc, r.id, c.id)))
  const totals = computeTotals(doc)
  const totalRow = doc.columns.map((c, i) =>
    c.kind === 'amount' ? String(totals.total) : i === 1 ? 'TOTAL' : '',
  )
  return toDelimited(headers, [...body, [], totalRow])
}

/**
 * Which columns an export may show, in table order.
 *
 * Exposed so the mail dialog can offer the same list the renderer will use,
 * rather than the dialog and the renderer each deciding for themselves and
 * disagreeing about a column that was renamed a second ago.
 */
export function exportableColumns(doc: SheetDoc): Array<{ id: string; name: string; kind: string }> {
  return [...doc.columns]
    .sort((a, b) => (a.order < b.order ? -1 : 1))
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind }))
}

/**
 * How the text grid is laid out.
 *
 *  - `grid`    headings, rules, columns separated by spaces. The default.
 *  - `colon`   the same, with a colon after the amount, which reads as
 *              "this much, for this" rather than as two adjacent columns.
 *  - `plain`   no headings and no rules: just the rows and the total, for a
 *              short mail where the frame is more furniture than help.
 */
export type GridStyle = 'grid' | 'colon' | 'plain'

export const GRID_STYLES: Array<{ value: GridStyle; label: string; hint: string }> = [
  { value: 'grid', label: 'Grid', hint: 'Headings and rules' },
  { value: 'colon', label: 'Colon', hint: 'Amount : title' },
  { value: 'plain', label: 'Plain', hint: 'Rows only' },
]

export type ExportOptions = {
  /** Column ids to include, in any order; table order is always the doc's. */
  columnIds?: string[]
  /** Line budget for the text grid. */
  maxWidth?: number
  style?: GridStyle
}

function chosenColumns(doc: SheetDoc, columnIds?: string[]) {
  const ordered = [...doc.columns].sort((a, b) => (a.order < b.order ? -1 : 1))
  if (!columnIds || columnIds.length === 0) return ordered
  const wanted = new Set(columnIds)
  const kept = ordered.filter((c) => wanted.has(c.id))
  // An empty or stale selection would render a table with no columns at all.
  return kept.length ? kept : ordered
}

/**
 * The aligned grid, shared by the clipboard and the mail draft.
 *
 * Both used to build their own layout, which is how they drifted apart: one
 * padded by string length and the other gave up on columns entirely. There is
 * one grid now, and `layoutTable` owns every offset in it.
 */
export function buildGrid(doc: SheetDoc, options: ExportOptions = {}): string[] {
  const cols = chosenColumns(doc, options.columnIds)
  const rows = liveRows(doc)
  const totals = computeTotals(doc)
  const style: GridStyle = options.style ?? 'grid'
  const bare = style === 'plain'

  const columns: TextColumn[] = cols.map((col) => {
    const numeric = col.kind === 'amount' || col.kind === 'number'
    return {
      header: bare ? '' : col.name,
      align: numeric ? 'right' : 'left',
      // A wrapped number is not a number, so money and counts keep their width.
      noWrap: numeric,
      cells: rows.map((r) => cellText(doc, r.id, col.id) || BLANK),
    }
  })

  // The total sits under the money, and the word "TOTAL" under the first text
  // column so it has something to read against.
  const firstText = cols.findIndex((c) => c.kind !== 'amount' && c.kind !== 'number')
  const footer = cols.map((col, i) =>
    col.kind === 'amount'
      ? formatMoney(totals.byColumn[col.id] ?? totals.total, doc.currency, { symbol: false })
      : i === firstText
        ? 'TOTAL'
        : '',
  )

  // A colon belongs after the money and nowhere else: it reads as "this much,
  // for this". Between two prose columns it would read as a typo.
  const separators =
    style === 'grid' || cols.length < 2
      ? undefined
      : cols.slice(0, -1).map((col, i) => (i === 0 && col.kind === 'amount' ? ' : ' : '  '))

  return layoutTable(columns, {
    maxWidth: options.maxWidth ?? 72,
    gap: 2,
    rule: !bare,
    separators,
    footer,
  })
}

/**
 * The header block every text export carries.
 *
 * The total is deliberately conditional. The grid below already carries one, on
 * its own rule and aligned under the money column, so printing it up here too
 * gave every mail two totals - and two of a number is one more than anybody
 * needs to read. It comes back only when the chosen columns contain no money
 * at all and the grid therefore has nothing to total.
 */
function summaryLines(doc: SheetDoc, includeTotal: boolean): string[] {
  const totals = computeTotals(doc)
  const period = periodText(doc)
  return [
    ...(period ? [`Period: ${period}`] : []),
    `Rows: ${totals.count}`,
    ...(includeTotal ? [`Total: ${formatMoney(totals.total, doc.currency)}`] : []),
  ]
}

/** Whether the grid will be able to print a total of its own. */
function gridHasMoney(doc: SheetDoc, columnIds?: string[]): boolean {
  return chosenColumns(doc, columnIds).some((c) => c.kind === 'amount')
}

/** What "Copy" puts on the clipboard: the summary, then the grid. */
export function toPlainText(doc: SheetDoc, options: ExportOptions = {}): string {
  const grid = buildGrid(doc, options)
  const summary = summaryLines(doc, !gridHasMoney(doc, options.columnIds))
  return [doc.name, '='.repeat(Math.min(Math.max(1, displayWidth(doc.name)), 60)), ...summary, '', ...grid].join('\n')
}

/**
 * The mail draft.
 *
 * Same grid as the clipboard, at a width a mail client will not fold. The
 * caller picks the columns: a file with a receipt column and three custom
 * fields does not want all of them in a mail to an accountant, and a table that
 * is too wide is the one thing that reliably destroys the alignment, because
 * the client re-wraps it wherever it likes.
 */
export function toEmail(doc: SheetDoc, options: ExportOptions = {}): { subject: string; body: string } {
  const period = periodText(doc)
  const grid = buildGrid(doc, { ...options, maxWidth: options.maxWidth ?? 72 })

  const body = [
    doc.name,
    '',
    ...summaryLines(doc, !gridHasMoney(doc, options.columnIds)),
    '',
    ...(grid.length ? grid : ['No rows yet.']),
    '',
    'made from HisaabhKitaabh',
  ].join('\n')

  return { subject: `${doc.name}${period ? ` (${period})` : ''}`, body }
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
          ? `<td style="text-align:right" class="num">${esc(formatMoney(totals.total, doc.currency))}</td>`
          : `<td>${i === 1 ? 'Total' : ''}</td>`,
      )
      .join('')}</tr></tfoot>
  </table>
  <p class="foot">made from HisaabhKitaabh</p>
  </body></html>`
}
