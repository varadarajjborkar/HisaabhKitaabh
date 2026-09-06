/**
 * What a chart is, as data.
 *
 * A spec is the contract between the three layers: the aggregator fills one
 * in from rows, the plot builder turns one into geometry, and the assistant
 * stores one in the conversation so a chart survives the turn that drew it.
 * Nothing here knows about SVG or about React.
 *
 * Two shapes of data live in it. `points` is one number per bucket, which is
 * what most charts want. `parts` is that bucket broken down a second way -
 * Goa's spend split into cabs, flights and food - and it is the field that
 * makes grouped, stacked and heatmap charts possible at all. A renderer that
 * wants a breakdown and finds none falls back to the flat form rather than
 * failing, so an old chart stored before any of this existed still draws.
 */

export type ChartMetric = 'sum' | 'count' | 'average'
export type ChartGroup = 'file' | 'folder' | 'category' | 'column' | 'day'

export type ChartKind =
  | 'bar'        // horizontal bars, ranked. The original, and still the default.
  | 'column'     // vertical bars
  | 'line'
  | 'area'
  | 'donut'
  | 'pie'
  | 'grouped'
  | 'stacked'
  | 'stacked100'
  | 'scatter'
  | 'bubble'
  | 'histogram'
  | 'heatmap'
  | 'treemap'
  | 'waterfall'
  | 'pareto'

export type ChartPoint = {
  key: string
  total: number
  count: number
  /** The bucket split a second way. Present only when the chart asked for it. */
  parts?: Record<string, number>
}

export type ChartSpec = {
  kind: ChartKind
  title: string
  subtitle?: string
  /** Null when the files disagree, so the figures print without a symbol. */
  currency: string | null
  metric: ChartMetric
  points: ChartPoint[]
  /** Every series name across every point, in a stable order. */
  series?: string[]
  /**
   * Individual row amounts, capped.
   *
   * Aggregates cannot answer questions about spread: a histogram of bucket
   * totals is a histogram of the wrong thing. This is what makes "most of my
   * spends are small, with three big ones" a chart rather than a guess.
   */
  values?: number[]
  /** What this chart actually looked at. Shown under it, not hidden in a tooltip. */
  note: string
  matchedRows: number
  scannedRows: number
}

export type KindInfo = {
  value: ChartKind
  label: string
  hint: string
  /** Reads the second breakdown. Without one it degrades, it does not break. */
  usesSeries: boolean
  /** Only worth offering when the chart has a breakdown to show. */
  needsSeries: boolean
  /** Ordered along an axis rather than ranked by size. */
  sequential: boolean
}

/**
 * The kinds on offer, and what each is for.
 *
 * Deliberately not every chart a plotting library can draw. Contour plots,
 * quiver fields and violin plots have no honest reading over a table of
 * expenses, and offering them would make the list harder to choose from
 * without making any question easier to answer. Everything here answers a
 * question somebody actually asks about money.
 */
export const KINDS: KindInfo[] = [
  { value: 'bar', label: 'Bar', hint: 'Ranked, horizontal', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'column', label: 'Column', hint: 'Ranked, vertical', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'line', label: 'Line', hint: 'A trend over time', usesSeries: true, needsSeries: false, sequential: true },
  { value: 'area', label: 'Area', hint: 'A trend, with volume', usesSeries: true, needsSeries: false, sequential: true },
  { value: 'donut', label: 'Donut', hint: 'Share of one total', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'pie', label: 'Pie', hint: 'Share of one total', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'grouped', label: 'Grouped', hint: 'Side by side', usesSeries: true, needsSeries: true, sequential: false },
  { value: 'stacked', label: 'Stacked', hint: 'Parts of each total', usesSeries: true, needsSeries: true, sequential: false },
  { value: 'stacked100', label: 'Stacked %', hint: 'Composition, normalised', usesSeries: true, needsSeries: true, sequential: false },
  { value: 'scatter', label: 'Scatter', hint: 'Rows against amount', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'bubble', label: 'Bubble', hint: 'Scatter, sized by share', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'histogram', label: 'Histogram', hint: 'How amounts are spread', usesSeries: false, needsSeries: false, sequential: true },
  { value: 'heatmap', label: 'Heatmap', hint: 'A grid of intensity', usesSeries: true, needsSeries: true, sequential: false },
  { value: 'treemap', label: 'Treemap', hint: 'Share, by area', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'waterfall', label: 'Waterfall', hint: 'How the total builds up', usesSeries: false, needsSeries: false, sequential: false },
  { value: 'pareto', label: 'Pareto', hint: 'Bars plus running share', usesSeries: false, needsSeries: false, sequential: false },
]

const BY_VALUE = new Map(KINDS.map((k) => [k.value, k]))

export function kindInfo(kind: ChartKind): KindInfo {
  return BY_VALUE.get(kind) ?? KINDS[0]
}

/** Whether the spec carries a second breakdown worth drawing. */
export function hasSeries(spec: ChartSpec): boolean {
  return (spec.series?.length ?? 0) > 1 && spec.points.some((p) => p.parts && Object.keys(p.parts).length > 0)
}

/**
 * The kinds worth offering for this particular chart.
 *
 * A grouped bar chart of data with nothing to group by is a plain bar chart
 * with extra steps, so it is not offered rather than offered and disappointing.
 */
export function availableKinds(spec: ChartSpec): KindInfo[] {
  const split = hasSeries(spec)
  return KINDS.filter((k) => (k.needsSeries ? split : true))
}

/** Series order, oldest-first for stacking, derived if the spec omits it. */
export function seriesOf(spec: ChartSpec): string[] {
  if (spec.series?.length) return spec.series
  const seen = new Set<string>()
  for (const p of spec.points) for (const k of Object.keys(p.parts ?? {})) seen.add(k)
  return [...seen]
}

/** Whether there is anything worth drawing. */
export function chartIsEmpty(spec: ChartSpec): boolean {
  return spec.points.length === 0 || spec.points.every((p) => p.total === 0)
}
