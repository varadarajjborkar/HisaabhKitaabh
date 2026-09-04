import type { SheetDoc } from '../model/types'
import { computeTotals, liveRows, numeric } from '../crdt/doc'
import { formatDate, formatINR } from './format'
import { toDelimited } from './table'

/**
 * Export renderers.
 *
 * Every format carries the same header block — name, period, row count, total —
 * because a table of numbers with no total is not something anyone can act on
 * at the other end.
 */

function header(doc: SheetDoc): { title: string; lines: string[]; totals: ReturnType<typeof computeTotals> } {
  const totals = computeTotals(doc)
  const lines = [`Rows: ${totals.count}`, `Total: ${formatINR(totals.total)}`]
  if (doc.duration.enabled && (doc.duration.from || doc.duration.to)) {
    lines.unshift(`Period: ${formatDate(doc.duration.from ?? '')} — ${formatDate(doc.duration.to ?? '')}`)
  }
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
    ...rows.map((r) => `| ${cols.map((c) => cellText(doc, r.id, c.id) || '—').join(' | ')} |`),
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

/** Plain-text layout with aligned columns — what "Copy" puts on the clipboard. */
export function toPlainText(doc: SheetDoc): string {
  const { title, lines } = header(doc)
  const rows = liveRows(doc)
  const cols = doc.columns
  const grid = [cols.map((c) => c.name), ...rows.map((r) => cols.map((c) => cellText(doc, r.id, c.id) || '—'))]
  const widths = cols.map((_, i) => Math.max(...grid.map((r) => (r[i] ?? '').length)))
  const numericCol = cols.map((c) => c.kind === 'amount' || c.kind === 'number')

  const line = (cells: string[]) =>
    cells.map((cell, i) => (numericCol[i] ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ').trimEnd()

  const totals = computeTotals(doc)
  return [
    title,
    '='.repeat(title.length),
    ...lines,
    '',
    line(grid[0]),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...grid.slice(1).map(line),
    widths.map((w) => '-'.repeat(w)).join('  '),
    line(cols.map((c, i) => (c.kind === 'amount' ? formatINR(totals.total, { symbol: false }) : i === 1 ? 'TOTAL' : ''))),
  ].join('\n')
}

export function toEmail(doc: SheetDoc): { subject: string; body: string } {
  const { title, lines } = header(doc)
  const period = doc.duration.enabled && doc.duration.from ? ` (${formatDate(doc.duration.from)}${doc.duration.to ? ` — ${formatDate(doc.duration.to)}` : ''})` : ''
  return {
    subject: `${title}${period}`,
    body: [`${title}`, '', ...lines, '', toPlainText(doc).split('\n').slice(lines.length + 3).join('\n'), '', '— sent from Khata'].join('\n'),
  }
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
  </table></body></html>`
}
