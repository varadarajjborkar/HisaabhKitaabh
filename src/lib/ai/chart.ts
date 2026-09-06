import type { SheetDoc } from '../model/types'
import type { ChartGroup, ChartKind, ChartMetric, ChartPoint, ChartSpec } from '../charts/spec'
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

/*
 * The shapes live in src/lib/charts, and are re-exported here so the many
 * callers that reached for them through the assistant keep working. The
 * direction matters: charting is the domain, and the assistant is one of its
 * callers, not the other way round.
 */
export type { ChartKind, ChartMetric, ChartGroup, ChartPoint, ChartSpec } from '../charts/spec'
export { chartIsEmpty, KINDS, kindInfo, availableKinds, hasSeries, seriesOf } from '../charts/spec'

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

/** How many individual amounts a spec will carry for distribution charts. */
const MAX_VALUES = 500

/** How many distinct series a breakdown may have before the tail is folded in. */
const MAX_SERIES = 8

export function buildChart(input: {
  kind: ChartKind
  title: string
  docs: SheetDoc[]
  folderName: (folderId: string) => string
  match: string[]
  group: ChartGroup
  column?: string
  /** A second grouping, breaking each bucket down again. */
  splitBy?: ChartGroup
  splitColumn?: string
  metric: ChartMetric
  maxPoints?: number
}): ChartSpec {
  const { kind, title, docs, folderName, match, group, column, splitBy, splitColumn, metric } = input
  const maxPoints = input.maxPoints ?? 12

  const buckets = new Map<string, { total: number; count: number; parts: Map<string, number> }>()
  const seriesTotals = new Map<string, number>()
  const values: number[] = []
  let matched = 0
  let scanned = 0

  for (const doc of docs) {
    for (const row of liveRows(doc)) {
      scanned++
      if (!rowMatches(doc, row, match)) continue
      matched++
      const key = groupKey(doc, row, group, column, folderName(doc.folderId))
      const bucket = buckets.get(key) ?? { total: 0, count: 0, parts: new Map<string, number>() }
      const amount = amountOf(doc, row)
      bucket.total += amount
      bucket.count += 1
      if (values.length < MAX_VALUES) values.push(amount)

      // The second dimension. Collected whether or not this chart kind uses
      // it, because the user can switch the kind afterwards and re-running the
      // whole aggregation to answer that would mean going back to the files.
      if (splitBy) {
        const part = groupKey(doc, row, splitBy, splitColumn, folderName(doc.folderId))
        const measured = metric === 'count' ? 1 : amount
        bucket.parts.set(part, (bucket.parts.get(part) ?? 0) + measured)
        seriesTotals.set(part, (seriesTotals.get(part) ?? 0) + Math.abs(measured))
      }
      buckets.set(key, bucket)
    }
  }

  // Series are ordered by size and capped, so a breakdown with sixty distinct
  // values does not produce sixty indistinguishable stack segments.
  const series = [...seriesTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SERIES).map(([k]) => k)
  const kept = new Set(series)
  const foldedTail = seriesTotals.size > series.length
  if (foldedTail) series.push('Other')

  let points: ChartPoint[] = [...buckets.entries()].map(([key, b]) => ({
    key,
    total: metric === 'count' ? b.count : metric === 'average' ? (b.count ? b.total / b.count : 0) : b.total,
    count: b.count,
    parts: splitBy ? foldParts(b.parts, kept, foldedTail, metric, b.count) : undefined,
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
    series: splitBy ? series : undefined,
    values: values.length ? values : undefined,
    matchedRows: matched,
    scannedRows: scanned,
    note:
      `${measured} from ${where}, ${selection}, grouped by ${group === 'column' ? (column ?? 'a column') : group}` +
      `${splitBy ? `, split by ${splitBy === 'column' ? (splitColumn ?? 'a column') : splitBy}` : ''}.`,
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
  const top = shown
    .map((p) => {
      const parts = p.parts ? Object.entries(p.parts).filter(([, v]) => v !== 0) : []
      const breakdown = parts.length ? ` (${parts.map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')})` : ''
      return `${p.key}: ${Math.round(p.total)}${breakdown}`
    })
    .join('; ')
  const more = spec.points.length > shown.length ? ` (+${spec.points.length - shown.length} more groups)` : ''
  return `"${spec.title}", ${spec.kind} chart of ${spec.points.length} groups. ${spec.note} ${top}${more}`
}

/** The same line, marked as a record of something already on the user's screen. */
export function chartRecord(spec: ChartSpec): string {
  return `[chart drawn] ${describeChart(spec)}`
}

/** Series past the cap are summed into one "Other" entry rather than dropped. */
function foldParts(
  parts: Map<string, number>,
  kept: Set<string>,
  foldedTail: boolean,
  metric: ChartMetric,
  count: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  let other = 0
  for (const [k, v] of parts) {
    if (kept.has(k)) out[k] = metric === 'average' ? (count ? v / count : 0) : v
    else other += v
  }
  if (foldedTail && other !== 0) out.Other = metric === 'average' ? (count ? other / count : 0) : other
  return out
}

export { computeTotals }
