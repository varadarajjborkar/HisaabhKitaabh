import type { SheetDoc } from '../model/types'
import { computeTotals, liveRows, numeric } from '../crdt/doc'
import { cellText, matchStrength } from '../search/rank'
import { formatDate } from '../util/format'

/**
 * Charts the assistant can draw, and the arithmetic behind them.
 *
 * The division of labour is the point. The model decides *what* to compare -
 * which files, which rows count as "travel", what the bars should be grouped
 * by - and this decides what the numbers are. A model that returns its own
 * figures returns figures nobody can check, computed from rows it half
 * remembers; a model that returns a question about the data gets an answer
 * drawn from the data itself.
 *
 * Every chart carries a note saying which files it read, which terms selected
 * the rows, and how many rows those terms found. A comparison of travel spend
 * is only worth anything if you can see what it decided travel was.
 */

export type ChartKind = 'bar' | 'line' | 'donut'
export type ChartMetric = 'sum' | 'count' | 'average'
export type ChartGroup = 'file' | 'folder' | 'category' | 'column' | 'day'

export type ChartPoint = { key: string; total: number; count: number }

export type ChartSpec = {
  kind: ChartKind
  title: string
  subtitle?: string
  /** Null when the files disagree, so the figures print without a symbol. */
  currency: string | null
  metric: ChartMetric
  points: ChartPoint[]
  /** What this chart actually looked at. Shown under it, not hidden in a tooltip. */
  note: string
  matchedRows: number
  scannedRows: number
}

/** A row counts if any term lands anywhere in it. No terms means every row counts. */
function rowMatches(doc: SheetDoc, row: SheetDoc['rows'][number], terms: string[]): boolean {
  if (terms.length === 0) return true
  for (const col of doc.columns) {
    const text = cellText(row.cells[col.id], col, doc.currency)
    if (!text) continue
    for (const term of terms) if (matchStrength(text, term) > 0) return true
  }
  return false
}

function amountOf(doc: SheetDoc, row: SheetDoc['rows'][number]): number {
  const col = doc.columns.find((c) => c.system && c.kind === 'amount') ?? doc.columns.find((c) => c.kind === 'amount')
  if (!col) return 0
  return numeric(row.cells[col.id])
}

/**
 * What a row is filed under, for the axis.
 *
 * "Category" means the first column a user made that holds words - the one they
 * are actually using to sort their spending - rather than a fixed field, which
 * this app does not have. Rows with nothing in it are grouped together and
 * labelled as such rather than dropped, because a chart that quietly omits half
 * the money is worse than one that shows an Uncategorised bar.
 */
function groupKey(doc: SheetDoc, row: SheetDoc['rows'][number], group: ChartGroup, columnName: string | undefined, folderName: string): string {
  if (group === 'file') return doc.name
  if (group === 'folder') return folderName
  if (group === 'day') {
    const dateCol = doc.columns.find((c) => c.kind === 'date')
    const raw = dateCol ? String(row.cells[dateCol.id] ?? '') : ''
    const iso = raw || new Date(row.createdAt).toISOString().slice(0, 10)
    return iso.slice(0, 10)
  }
  const named = columnName
    ? doc.columns.find((c) => c.name.toLowerCase() === columnName.toLowerCase())
    : doc.columns.find((c) => !c.system && (c.kind === 'select' || c.kind === 'text'))
      ?? doc.columns.find((c) => c.kind === 'select' || (c.kind === 'text' && !c.system))
  if (!named) return 'Uncategorised'
  const value = String(row.cells[named.id] ?? '').trim()
  return value || 'Uncategorised'
}

export function buildChart(input: {
  kind: ChartKind
  title: string
  docs: SheetDoc[]
  folderName: (folderId: string) => string
  match: string[]
  group: ChartGroup
  column?: string
  metric: ChartMetric
  maxPoints?: number
}): ChartSpec {
  const { kind, title, docs, folderName, match, group, column, metric } = input
  const maxPoints = input.maxPoints ?? 12

  const buckets = new Map<string, { total: number; count: number }>()
  let matched = 0
  let scanned = 0

  for (const doc of docs) {
    for (const row of liveRows(doc)) {
      scanned++
      if (!rowMatches(doc, row, match)) continue
      matched++
      const key = groupKey(doc, row, group, column, folderName(doc.folderId))
      const bucket = buckets.get(key) ?? { total: 0, count: 0 }
      bucket.total += amountOf(doc, row)
      bucket.count += 1
      buckets.set(key, bucket)
    }
  }

  let points: ChartPoint[] = [...buckets.entries()].map(([key, b]) => ({
    key,
    total: metric === 'count' ? b.count : metric === 'average' ? (b.count ? b.total / b.count : 0) : b.total,
    count: b.count,
  }))

  // A day axis is a sequence; everything else is a ranking.
  points = group === 'day' ? points.sort((a, b) => a.key.localeCompare(b.key)) : points.sort((a, b) => b.total - a.total)

  /*
   * Too many bars is not a chart. Past the cap the tail is folded into one
   * "everything else" bar rather than dropped, so the figures on screen still
   * add up to the total the user could work out for themselves.
   */
  if (points.length > maxPoints && group !== 'day') {
    const kept = points.slice(0, maxPoints - 1)
    const rest = points.slice(maxPoints - 1)
    kept.push({
      key: `${rest.length} more`,
      total: metric === 'average'
        ? rest.reduce((s, p) => s + p.total * p.count, 0) / Math.max(1, rest.reduce((s, p) => s + p.count, 0))
        : rest.reduce((s, p) => s + p.total, 0),
      count: rest.reduce((s, p) => s + p.count, 0),
    })
    points = kept
  }

  if (group === 'day') {
    points = points.map((p) => ({ ...p, key: formatDate(p.key) }))
  }

  // A total across two currencies has no symbol that would be true.
  const codes = new Set(docs.map((d) => (d.currency || 'INR').toUpperCase()))
  const currency = codes.size === 1 ? [...codes][0] : null

  const where = docs.length === 1 ? `"${docs[0].name}"` : `${docs.length} files`
  const selection = match.length
    ? `${matched} of ${scanned} rows matching ${match.map((m) => `"${m}"`).join(', ')}`
    : `all ${scanned} rows`
  const measured = metric === 'count' ? 'row counts' : metric === 'average' ? 'average amounts' : 'totals'

  return {
    kind,
    title,
    currency,
    metric,
    points,
    matchedRows: matched,
    scannedRows: scanned,
    note: `${measured} from ${where}, ${selection}, grouped by ${group === 'column' ? (column ?? 'a column') : group}.`,
    subtitle: codes.size > 1 ? 'Mixed currencies, so figures are shown without a symbol' : undefined,
  }
}

/**
 * The chart, as one line of text.
 *
 * This is the only form of a chart that survives the turn it was drawn in. A
 * picture is not something the model can look at again, and the conversation
 * that follows one is usually *about* it: which bar was biggest, why is that
 * one higher, add flights to it. Without this, the next turn has the user
 * saying "that chart" and nothing to attach it to - and would have to guess,
 * or silently answer about something else.
 *
 * So it carries the definition as well as the result. Which files, which terms
 * selected the rows, what the bars were grouped by: that is what "add flights
 * to it" needs, and none of it is recoverable from the figures alone.
 *
 * Bounded on purpose. Eight buckets is enough to answer a follow-up and short
 * enough that a conversation with several charts in it does not spend its whole
 * context replaying them.
 */
export function describeChart(spec: ChartSpec): string {
  const shown = spec.points.slice(0, 8)
  const top = shown.map((p) => `${p.key}: ${Math.round(p.total)}`).join('; ')
  const more = spec.points.length > shown.length ? ` (+${spec.points.length - shown.length} more groups)` : ''
  return `"${spec.title}", ${spec.kind} chart of ${spec.points.length} groups. ${spec.note} ${top}${more}`
}

/** The same line, marked as a record of something already on the user's screen. */
export function chartRecord(spec: ChartSpec): string {
  return `[chart drawn] ${describeChart(spec)}`
}

/** Whether there is anything worth drawing. */
export function chartIsEmpty(spec: ChartSpec): boolean {
  return spec.points.length === 0 || spec.points.every((p) => p.total === 0)
}

export { computeTotals }
