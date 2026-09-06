import { formatMoney, compactMoney } from '../util/format'
import { textWidth, truncate, wrap } from './measure'
import { band, extent, linear, niceTicks, type Band, type Linear } from './scale'
import { arcPath, barPath, hBarPath, linePath, smoothPath, type Mark } from './marks'
import { fade, readableOn, mix, themeFor, type ChartTheme } from './theme'
import { hasSeries, kindInfo, seriesOf, type ChartPoint, type ChartSpec } from './spec'

/**
 * Charts, compiled to geometry.
 *
 * Nothing in this file writes SVG and nothing in it reads a DOM. A spec goes
 * in, an array of marks comes out, and the result can be asserted against
 * directly - that a bar's height is exactly proportional to its value, that
 * two slices of a donut sum to a full turn - without rendering a pixel.
 *
 * The layout is computed rather than assumed. Label gutters are measured from
 * the labels, not guessed at with a constant, because "Lama Max subscription"
 * and "UPI" do not need the same amount of room and a fixed gutter is either
 * wasteful for one or clipping for the other.
 */

export type PlotOptions = {
  width?: number
  height?: number
  dark?: boolean
  theme?: ChartTheme
  /** Draw the title into the chart. Off inline, where the panel prints it. */
  showTitle?: boolean
  /** Draw the note under the chart. Off inline, for the same reason. */
  showNote?: boolean
  padding?: number
  /** Cap on drawn buckets; the tail folds into one "others" mark. */
  maxPoints?: number
}

export type Plot = {
  width: number
  height: number
  marks: Mark[]
  theme: ChartTheme
}

type Box = { x: number; y: number; w: number; h: number }

type Ctx = {
  spec: ChartSpec
  theme: ChartTheme
  points: ChartPoint[]
  series: string[]
  split: boolean
  /** A full figure, for direct labels. */
  fmt: (v: number) => string
  /** A short figure, for axis ticks where room is scarce. */
  brief: (v: number) => string
  colour: (i: number) => string
  push: (...m: Mark[]) => void
}

const TITLE_SIZE = 15
const LABEL_SIZE = 11.5
const TICK_SIZE = 10.5
const NOTE_SIZE = 11
const VALUE_SIZE = 11.5
const LEGEND_SIZE = 11.5

export function buildPlot(spec: ChartSpec, opts: PlotOptions = {}): Plot {
  const theme = opts.theme ?? themeFor(opts.dark ?? false)
  const width = Math.max(240, opts.width ?? 720)
  const pad = opts.padding ?? 16
  const marks: Mark[] = []
  const push = (...m: Mark[]) => marks.push(...m)

  const info = kindInfo(spec.kind)
  const split = hasSeries(spec) && info.usesSeries
  const series = split ? seriesOf(spec) : []
  const points = capPoints(spec, opts.maxPoints ?? defaultCap(spec.kind), info.sequential)

  const currency = spec.currency
  const money = spec.metric === 'count'
  const fmt = (v: number) =>
    money ? String(Math.round(v)) : formatMoney(v, currency ?? 'INR', { decimals: false, symbol: !!currency })
  const brief = (v: number) =>
    money ? String(Math.round(v)) : compactMoney(v, currency ?? 'INR').replace(/^[^\d\-]+/, currency ? '' : '')

  const ctx: Ctx = {
    spec, theme, points, series, split, fmt, brief,
    colour: (i) => theme.series[i % theme.series.length],
    push,
  }

  let top = pad

  if (opts.showTitle && spec.title) {
    const lines = wrap(spec.title, width - pad * 2, TITLE_SIZE, 600, 2)
    for (const line of lines) {
      top += TITLE_SIZE
      push({ m: 'text', x: pad, y: top, s: line, size: TITLE_SIZE, weight: 600, fill: theme.ink })
      top += 4
    }
    top += 6
  }

  // A legend is only earned by a chart whose colours carry identity.
  const legendItems = legendFor(spec, points, series, split)
  let legendHeight = 0
  if (legendItems.length > 1) {
    legendHeight = measureLegend(legendItems, width - pad * 2)
  }

  // The note is laid out first because it decides how much height is left.
  const noteLines = opts.showNote && spec.note ? wrap(noteText(spec), width - pad * 2, NOTE_SIZE, 400, 3) : []
  const noteHeight = noteLines.length ? noteLines.length * (NOTE_SIZE + 3) + 8 : 0

  const height = Math.max(160, opts.height ?? defaultHeight(spec, points.length, series.length))
  const bodyTop = top
  const bodyBottom = height - pad - noteHeight - legendHeight
  const box: Box = { x: pad, y: bodyTop, w: width - pad * 2, h: Math.max(60, bodyBottom - bodyTop) }

  drawBody(spec.kind, box, ctx)

  if (legendItems.length > 1) {
    drawLegend(legendItems, { x: pad, y: bodyBottom + 10, w: width - pad * 2, h: legendHeight }, ctx)
  }

  let ny = height - pad - noteHeight + 8
  for (const line of noteLines) {
    ny += NOTE_SIZE
    push({ m: 'text', x: pad, y: ny, s: line, size: NOTE_SIZE, fill: theme.faint })
    ny += 3
  }

  return { width, height, marks, theme }
}

function noteText(spec: ChartSpec): string {
  return spec.subtitle ? `${spec.subtitle}. ${spec.note}` : spec.note
}

function defaultCap(kind: ChartSpec['kind']): number {
  if (kind === 'treemap' || kind === 'heatmap') return 16
  if (kind === 'donut' || kind === 'pie') return 8
  if (kind === 'line' || kind === 'area' || kind === 'histogram') return 60
  return 12
}

function defaultHeight(spec: ChartSpec, n: number, seriesCount: number): number {
  switch (spec.kind) {
    case 'bar':
      return 90 + n * 30
    case 'waterfall':
    case 'pareto':
      return 340
    case 'donut':
    case 'pie':
      return 300 + Math.ceil(n / 3) * 18
    case 'treemap':
      return 340
    case 'heatmap':
      return 110 + n * 26
    default:
      return 320 + (seriesCount > 4 ? 20 : 0)
  }
}

/**
 * Cap the drawn buckets, folding the tail into one.
 *
 * Past a dozen bars a chart is a texture, not a comparison. The remainder is
 * summed into a single labelled mark rather than dropped, so the figures on
 * screen still add up to the total the user could work out themselves.
 */
function capPoints(spec: ChartSpec, cap: number, sequential: boolean): ChartPoint[] {
  const points = spec.points
  if (points.length <= cap || sequential) return points
  const kept = points.slice(0, cap - 1)
  const rest = points.slice(cap - 1)
  const parts: Record<string, number> = {}
  for (const p of rest) for (const [k, v] of Object.entries(p.parts ?? {})) parts[k] = (parts[k] ?? 0) + v
  return [
    ...kept,
    {
      key: `${rest.length} others`,
      total: rest.reduce((s, p) => s + p.total, 0),
      count: rest.reduce((s, p) => s + p.count, 0),
      parts: Object.keys(parts).length ? parts : undefined,
    },
  ]
}

// ------------------------------------------------------------------- legend

type LegendItem = { label: string; colour: string }

function legendFor(spec: ChartSpec, points: ChartPoint[], series: string[], split: boolean): LegendItem[] {
  const theme = themeFor(false)
  const colour = (i: number) => theme.series[i % theme.series.length]
  // A heatmap names its series along the top and colours by intensity of one
  // hue, so a legend of eight different hues would describe a chart that is
  // not on the screen.
  if (spec.kind === 'heatmap') return []
  if (split) return series.map((s, i) => ({ label: s, colour: colour(i) }))
  if (spec.kind === 'donut' || spec.kind === 'pie' || spec.kind === 'treemap') {
    return points.map((p, i) => ({ label: p.key, colour: colour(i) }))
  }
  return []
}

const SWATCH = 9
const LEGEND_GAP = 14
const LEGEND_ROW = 19

/**
 * Legend entries, wrapped into rows and cut to fit.
 *
 * A key long enough to be its own sentence is cut rather than allowed to run
 * off the side: a legend that leaves the canvas names nothing at all, and half
 * a name plus an ellipsis is still a name.
 */
function legendRows(items: LegendItem[], width: number): LegendItem[][] {
  const cap = Math.max(40, width - SWATCH - 5 - LEGEND_GAP)
  const fitted = items.map((item) => ({ ...item, label: truncate(item.label, cap, LEGEND_SIZE) }))
  const rows: LegendItem[][] = []
  let row: LegendItem[] = []
  let used = 0
  for (const item of fitted) {
    const w = SWATCH + 5 + textWidth(item.label, LEGEND_SIZE) + LEGEND_GAP
    if (used + w > width && row.length) { rows.push(row); row = []; used = 0 }
    row.push(item)
    used += w
  }
  if (row.length) rows.push(row)
  return rows
}

function measureLegend(items: LegendItem[], width: number): number {
  return legendRows(items, width).length * LEGEND_ROW + 6
}

function drawLegend(items: LegendItem[], box: Box, ctx: Ctx): void {
  const rows = legendRows(items, box.w)
  let y = box.y
  let index = 0
  for (const row of rows) {
    let x = box.x
    for (const item of row) {
      const colour = ctx.colour(index++)
      ctx.push(
        { m: 'rect', x, y: y - SWATCH + 1, w: SWATCH, h: SWATCH, rx: 2.5, fill: colour },
        { m: 'text', x: x + SWATCH + 5, y, s: item.label, size: LEGEND_SIZE, fill: ctx.theme.muted },
      )
      x += SWATCH + 5 + textWidth(item.label, LEGEND_SIZE) + LEGEND_GAP
    }
    y += LEGEND_ROW
  }
}

// --------------------------------------------------------------------- axes

/** A y axis with gridlines, returning the plot box left of its labels. */
function yAxis(box: Box, scale: Linear, ctx: Ctx, format: (v: number) => string): Box {
  const ticks = scale.ticks(5)
  const gutter = Math.max(...ticks.map((t) => textWidth(format(t), TICK_SIZE))) + 8
  const inner: Box = { x: box.x + gutter, y: box.y, w: box.w - gutter, h: box.h }
  for (const t of ticks) {
    const y = scale.map(t)
    ctx.push(
      { m: 'line', x1: inner.x, y1: y, x2: inner.x + inner.w, y2: y, stroke: ctx.theme.line, width: 1, opacity: t === 0 ? 1 : 0.6 },
      { m: 'text', x: inner.x - 6, y: y + 3.5, s: format(t), size: TICK_SIZE, fill: ctx.theme.faint, anchor: 'end', tnum: true },
    )
  }
  return inner
}

/*
 * Rotated labels run down and to the LEFT of their anchor.
 *
 * A label ending at (x, y) turned by -45 degrees reaches back to
 * x - w/root2 and down to y + w/root2. Both of those are ways to leave the
 * canvas, and the left one bites first: the first category sits close to the
 * axis, so its label is the one that runs off the edge. Every budget below is
 * therefore the smaller of the room under the plot and the room to the left of
 * that particular label.
 */
const ROT = Math.SQRT1_2

/**
 * Category labels under a band axis.
 *
 * Rotated to 45 degrees only when horizontal ones would collide, because
 * rotated text is harder to read and a chart that does it unnecessarily has
 * made itself worse for no gain.
 */
function xLabels(box: Box, scale: Band, ctx: Ctx, height: number, leftEdge = 2): void {
  const labels = scale.domain
  const widest = Math.max(0, ...labels.map((l) => textWidth(l, TICK_SIZE)))
  const y = box.y + box.h

  if (widest <= scale.step - 4) {
    for (const label of labels) {
      ctx.push({ m: 'text', x: scale.centre(label), y: y + 14, s: label, size: TICK_SIZE, fill: ctx.theme.faint, anchor: 'middle' })
    }
    return
  }

  const below = Math.max(12, (height - 10) / ROT)
  for (const label of labels) {
    const x = scale.centre(label)
    const leftRoom = Math.max(12, (x - leftEdge) / ROT)
    const cut = truncate(label, Math.min(below, leftRoom), TICK_SIZE)
    // Rotation lives on the mark rather than in a wrapping group, so the SVG
    // writer stays a flat translation of marks to elements.
    ctx.push({ m: 'text', x, y: y + 12, s: cut, size: TICK_SIZE, fill: ctx.theme.faint, anchor: 'end', rotate: -45 })
  }
}

/** How much room the x labels will want under the plot. */
function xLabelHeight(labels: string[], step: number): number {
  const widest = Math.max(0, ...labels.map((l) => textWidth(l, TICK_SIZE)))
  if (widest <= step - 4) return 20
  return Math.min(Math.ceil(widest * ROT) + 14, 84)
}

// ------------------------------------------------------------------- bodies

function drawBody(kind: ChartSpec['kind'], box: Box, ctx: Ctx): void {
  switch (kind) {
    case 'bar': return drawBar(box, ctx)
    case 'column': return drawColumns(box, ctx, 'plain')
    case 'grouped': return drawColumns(box, ctx, 'grouped')
    case 'stacked': return drawColumns(box, ctx, 'stacked')
    case 'stacked100': return drawColumns(box, ctx, 'stacked100')
    case 'line': return drawLine(box, ctx, false)
    case 'area': return drawLine(box, ctx, true)
    case 'donut': return drawRadial(box, ctx, 0.62)
    case 'pie': return drawRadial(box, ctx, 0)
    case 'scatter': return drawScatter(box, ctx, false)
    case 'bubble': return drawScatter(box, ctx, true)
    case 'histogram': return drawHistogram(box, ctx)
    case 'heatmap': return drawHeatmap(box, ctx)
    case 'treemap': return drawTreemap(box, ctx)
    case 'waterfall': return drawWaterfall(box, ctx)
    case 'pareto': return drawPareto(box, ctx)
  }
}

/**
 * Horizontal bars, ranked.
 *
 * The label gutter is measured, then capped at 38% of the width: past that a
 * chart is mostly text and the bars have no room left to be compared, which is
 * the one thing they are for.
 */
function drawBar(box: Box, ctx: Ctx): void {
  const { points, theme } = ctx
  const max = Math.max(...points.map((p) => Math.abs(p.total)), 1)
  const widestLabel = Math.max(0, ...points.map((p) => textWidth(p.key, LABEL_SIZE)))
  const gutter = Math.min(widestLabel + 10, box.w * 0.38)
  const widestValue = Math.max(0, ...points.map((p) => textWidth(ctx.fmt(p.total), VALUE_SIZE, 500)))
  const track = box.w - gutter - widestValue - 10
  const rows = band(points.map((p) => p.key), [box.y, box.y + box.h], 0.35)
  const h = Math.min(rows.bandwidth, 26)

  points.forEach((p, i) => {
    const y = rows.centre(p.key) - h / 2
    const w = Math.max((Math.abs(p.total) / max) * track, 2)
    ctx.push(
      { m: 'text', x: box.x, y: y + h / 2 + 4, s: truncate(p.key, gutter - 10, LABEL_SIZE), size: LABEL_SIZE, fill: theme.ink },
      { m: 'rect', x: box.x + gutter, y, w: track, h, rx: 4, fill: theme.raised },
      { m: 'path', d: hBarPath(box.x + gutter, y, w, h, 4), fill: ctx.colour(i) },
      { m: 'text', x: box.x + gutter + w + 7, y: y + h / 2 + 4, s: ctx.fmt(p.total), size: VALUE_SIZE, weight: 500, fill: theme.muted, tnum: true },
    )
  })
}

type ColumnMode = 'plain' | 'grouped' | 'stacked' | 'stacked100'

/** Vertical bars, in all four of their arrangements. */
function drawColumns(box: Box, ctx: Ctx, mode: ColumnMode): void {
  const { points, theme, series, split } = ctx
  const stacked = mode === 'stacked' || mode === 'stacked100'
  const useSeries = split && mode !== 'plain'
  /*
   * Only normalise when there is a breakdown to normalise. Without one,
   * stacked100 degrades to a plain column chart - and a plain column chart
   * plotted against a 0-to-1 axis puts a bar for 500 about a hundred thousand
   * pixels above the canvas.
   */
  const normalise = mode === 'stacked100' && useSeries

  const totals = points.map((p) =>
    useSeries && stacked
      ? series.reduce((s, k) => s + Math.max(0, p.parts?.[k] ?? 0), 0)
      : useSeries && mode === 'grouped'
        ? Math.max(...series.map((k) => p.parts?.[k] ?? 0), 0)
        : p.total,
  )

  const labelHeight = xLabelHeight(points.map((p) => p.key), (box.w - 44) / Math.max(points.length, 1))
  const plotH = box.h - labelHeight
  const domain: [number, number] = normalise ? [0, 1] : extent(totals)
  const y = linear(domain, [box.y + plotH, box.y])
  const format = normalise ? (v: number) => `${Math.round(v * 100)}%` : ctx.brief
  const inner = yAxis({ ...box, h: plotH }, y, ctx, format)
  const x = band(points.map((p) => p.key), [inner.x, inner.x + inner.w], 0.28)

  points.forEach((p, i) => {
    const left = x.map(p.key)
    if (!useSeries) {
      const top = y.map(Math.max(p.total, 0))
      const zero = y.map(0)
      ctx.push({ m: 'path', d: barPath(left, top, x.bandwidth, zero - top, 4), fill: ctx.colour(i) })
      // A figure over every column, so the chart can be read without the axis.
      if (x.bandwidth > textWidth(ctx.brief(p.total), TICK_SIZE) - 2) {
        ctx.push({ m: 'text', x: left + x.bandwidth / 2, y: top - 6, s: ctx.brief(p.total), size: TICK_SIZE, fill: theme.muted, anchor: 'middle', tnum: true })
      }
      return
    }

    if (mode === 'grouped') {
      const slot = band(series, [left, left + x.bandwidth], 0.12)
      series.forEach((k, si) => {
        const v = p.parts?.[k] ?? 0
        const top = y.map(Math.max(v, 0))
        const zero = y.map(0)
        if (zero - top < 0.5) return
        ctx.push({ m: 'path', d: barPath(slot.map(k), top, slot.bandwidth, zero - top, 2.5), fill: ctx.colour(si) })
      })
      return
    }

    const sum = series.reduce((s, k) => s + Math.max(0, p.parts?.[k] ?? 0), 0) || 1
    let acc = 0
    series.forEach((k, si) => {
      const raw = Math.max(0, p.parts?.[k] ?? 0)
      if (raw === 0) return
      const v = normalise ? raw / sum : raw
      const from = y.map(acc)
      const to = y.map(acc + v)
      acc += v
      ctx.push({ m: 'rect', x: left, y: to, w: x.bandwidth, h: from - to, fill: ctx.colour(si) })
    })
  })

  xLabels({ ...inner, h: plotH }, x, ctx, labelHeight)
}

/** A trend. One line without a breakdown, one per series with it. */
function drawLine(box: Box, ctx: Ctx, filled: boolean): void {
  const { points, theme, series, split } = ctx
  const keys = points.map((p) => p.key)
  const labelHeight = xLabelHeight(keys, (box.w - 44) / Math.max(keys.length, 1))
  const plotH = box.h - labelHeight

  const all = split ? points.flatMap((p) => series.map((k) => p.parts?.[k] ?? 0)) : points.map((p) => p.total)
  const y = linear(extent(all), [box.y + plotH, box.y])
  const inner = yAxis({ ...box, h: plotH }, y, ctx, ctx.brief)
  const x = band(keys, [inner.x, inner.x + inner.w], 0)
  const at = (key: string) => x.centre(key)

  const lines: Array<{ colour: string; pts: Array<[number, number]> }> = split
    ? series.map((k, si) => ({ colour: ctx.colour(si), pts: points.map((p) => [at(p.key), y.map(p.parts?.[k] ?? 0)] as [number, number]) }))
    : [{ colour: ctx.colour(0), pts: points.map((p) => [at(p.key), y.map(p.total)] as [number, number]) }]

  for (const { colour, pts } of lines) {
    if (filled) ctx.push({ m: 'path', d: smoothPath(pts, y.map(y.domain[0])), fill: colour, opacity: split ? 0.22 : 0.16 })
    ctx.push({ m: 'path', d: smoothPath(pts), stroke: colour, width: 2, join: 'round' })
    // Dots only when they will not merge into a bead chain.
    if (pts.length <= 24) for (const [px, py] of pts) ctx.push({ m: 'circle', cx: px, cy: py, r: 2.6, fill: theme.surface, stroke: colour, width: 1.8 })
  }

  xLabels({ ...inner, h: plotH }, thinned(x, inner.w), ctx, labelHeight)
}

/** A band scale showing only as many labels as will fit without colliding. */
function thinned(scale: Band, width: number): Band {
  const widest = Math.max(0, ...scale.domain.map((d) => textWidth(d, TICK_SIZE)))
  const fits = Math.max(1, Math.floor(width / (widest + 12)))
  if (fits >= scale.domain.length) return scale
  const every = Math.ceil(scale.domain.length / fits)
  const kept = scale.domain.filter((_, i) => i % every === 0)
  return { ...scale, domain: kept }
}

/** Donut or pie, by inner radius. */
function drawRadial(box: Box, ctx: Ctx, innerRatio: number): void {
  const { points, theme } = ctx
  const total = points.reduce((s, p) => s + Math.abs(p.total), 0) || 1
  const r = Math.min(box.w, box.h) / 2 - 4
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const inner = r * innerRatio

  let angle = -Math.PI / 2
  points.forEach((p, i) => {
    const sweep = (Math.abs(p.total) / total) * Math.PI * 2
    if (sweep <= 0) return
    ctx.push({ m: 'path', d: arcPath(cx, cy, r, inner, angle, angle + sweep), fill: ctx.colour(i), stroke: theme.surface })
    // A share is printed on the slice when the slice can hold it.
    const share = Math.abs(p.total) / total
    if (share > 0.06) {
      const mid = angle + sweep / 2
      const lr = inner > 0 ? (r + inner) / 2 : r * 0.62
      ctx.push({
        m: 'text', x: cx + lr * Math.cos(mid), y: cy + lr * Math.sin(mid) + 4,
        s: `${Math.round(share * 100)}%`, size: TICK_SIZE, weight: 600,
        fill: readableOn(ctx.colour(i)), anchor: 'middle',
      })
    }
    angle += sweep
  })

  if (inner > 0) {
    ctx.push(
      { m: 'text', x: cx, y: cy - 1, s: ctx.fmt(total), size: Math.min(19, (inner * 1.7) / Math.max(ctx.fmt(total).length * 0.5, 1)), weight: 600, fill: theme.ink, anchor: 'middle', tnum: true },
      { m: 'text', x: cx, y: cy + 15, s: `${ctx.spec.matchedRows} rows`, size: TICK_SIZE, fill: theme.faint, anchor: 'middle' },
    )
  }
}

/**
 * Rows against amount.
 *
 * The one chart here with two real quantities on it: how many rows a bucket
 * holds against what it cost. It separates "many small purchases" from "one
 * large one", which no single-value chart can show.
 */
function drawScatter(box: Box, ctx: Ctx, sized: boolean): void {
  const { points, theme } = ctx
  const plotH = box.h - 26
  const y = linear(extent(points.map((p) => p.total)), [box.y + plotH, box.y])
  const inner = yAxis({ ...box, h: plotH }, y, ctx, ctx.brief)
  const counts = points.map((p) => p.count)
  const x = linear(extent(counts), [inner.x + 6, inner.x + inner.w - 6])
  const maxTotal = Math.max(...points.map((p) => Math.abs(p.total)), 1)

  for (const t of x.ticks(5)) {
    ctx.push({ m: 'text', x: x.map(t), y: box.y + plotH + 15, s: String(Math.round(t)), size: TICK_SIZE, fill: ctx.theme.faint, anchor: 'middle', tnum: true })
  }
  ctx.push({ m: 'text', x: inner.x + inner.w, y: box.y + plotH + 26, s: 'rows', size: TICK_SIZE, fill: theme.faint, anchor: 'end' })

  points.forEach((p, i) => {
    const r = sized ? 4 + Math.sqrt(Math.abs(p.total) / maxTotal) * 14 : 5
    const cx = x.map(p.count)
    const cy = y.map(p.total)
    ctx.push({ m: 'circle', cx, cy, r, fill: ctx.colour(i), opacity: 0.75, stroke: theme.surface, width: 1 })
    if (points.length <= 14) {
      // A centred label spends half its width on each side of the dot, so the
      // budget is twice the nearer margin - not the width of the plot.
      const room = Math.min(cx - box.x, box.x + box.w - cx) * 2
      const label = truncate(p.key, Math.min(110, room), TICK_SIZE)
      if (label) ctx.push({ m: 'text', x: cx, y: cy - r - 5, s: label, size: TICK_SIZE, fill: theme.muted, anchor: 'middle' })
    }
  })
}

/**
 * How amounts are spread.
 *
 * Binned from the individual row amounts, not from bucket totals - a histogram
 * of aggregates is a histogram of the wrong thing. Falls back to bucket totals
 * when a spec predates the raw values being carried.
 */
function drawHistogram(box: Box, ctx: Ctx): void {
  const raw = ctx.spec.values?.length ? ctx.spec.values : ctx.points.map((p) => p.total)
  const values = raw.filter((v) => isFinite(v))
  if (values.length === 0) return

  const lo = Math.min(...values, 0)
  const hi = Math.max(...values)
  // Freedman-Diaconis would be better with more data; Sturges is stable on the
  // handful of rows a real file holds and never asks for forty empty bins.
  const bins = Math.max(4, Math.min(18, Math.ceil(Math.log2(values.length) + 1) * 2))
  const width = (hi - lo) / bins || 1
  const counts = new Array(bins).fill(0)
  for (const v of values) counts[Math.min(bins - 1, Math.floor((v - lo) / width))]++

  const labels = counts.map((_, i) => ctx.brief(lo + i * width))
  const labelHeight = xLabelHeight(labels, (box.w - 44) / bins)
  const plotH = box.h - labelHeight
  const y = linear(extent(counts), [box.y + plotH, box.y])
  const inner = yAxis({ ...box, h: plotH }, y, ctx, (v) => String(Math.round(v)))
  const x = band(labels, [inner.x, inner.x + inner.w], 0.08)

  counts.forEach((c, i) => {
    const top = y.map(c)
    const zero = y.map(0)
    if (zero - top < 0.5) return
    ctx.push({ m: 'path', d: barPath(x.map(labels[i]), top, x.bandwidth, zero - top, 2), fill: ctx.colour(0), opacity: 0.9 })
  })
  xLabels({ ...inner, h: plotH }, thinned(x, inner.w), ctx, labelHeight)
}

/** Buckets down the side, series across, intensity in the cells. */
function drawHeatmap(box: Box, ctx: Ctx): void {
  const { points, series, theme } = ctx
  const gutter = Math.min(Math.max(0, ...points.map((p) => textWidth(p.key, LABEL_SIZE))) + 10, box.w * 0.34)
  const headHeight = 18
  const grid: Box = { x: box.x + gutter, y: box.y + headHeight, w: box.w - gutter, h: box.h - headHeight }
  const cols = band(series, [grid.x, grid.x + grid.w], 0.06)
  const rows = band(points.map((p) => p.key), [grid.y, grid.y + grid.h], 0.06)
  const max = Math.max(...points.flatMap((p) => series.map((k) => Math.abs(p.parts?.[k] ?? 0))), 1)
  const base = ctx.colour(0)

  series.forEach((k) => {
    ctx.push({ m: 'text', x: cols.centre(k), y: box.y + 11, s: truncate(k, cols.bandwidth, TICK_SIZE), size: TICK_SIZE, fill: theme.faint, anchor: 'middle' })
  })

  for (const p of points) {
    ctx.push({ m: 'text', x: box.x, y: rows.centre(p.key) + 4, s: truncate(p.key, gutter - 10, LABEL_SIZE), size: LABEL_SIZE, fill: theme.ink })
    for (const k of series) {
      const v = Math.abs(p.parts?.[k] ?? 0)
      const t = v / max
      const fill = v === 0 ? theme.raised : mix(theme.surface, base, 0.15 + t * 0.85)
      ctx.push({ m: 'rect', x: cols.map(k), y: rows.map(p.key), w: cols.bandwidth, h: rows.bandwidth, rx: 3, fill })
      if (v > 0 && cols.bandwidth > 42 && rows.bandwidth > 16) {
        ctx.push({
          m: 'text', x: cols.centre(k), y: rows.centre(p.key) + 3.5, s: ctx.brief(v), size: TICK_SIZE,
          fill: t > 0.55 ? readableOn(base) : theme.muted, anchor: 'middle', tnum: true,
        })
      }
    }
  }
}

/**
 * Share, by area.
 *
 * Squarified: at each step the algorithm keeps adding to the current row while
 * doing so improves the worst aspect ratio in it, then starts a new one. The
 * result is cells near enough to square to compare by eye, which is the only
 * reason to use area for a quantity at all.
 */
function drawTreemap(box: Box, ctx: Ctx): void {
  const { points, theme } = ctx
  const items = points.map((p, i) => ({ value: Math.abs(p.total), key: p.key, colour: ctx.colour(i), total: p.total })).filter((it) => it.value > 0)
  const sum = items.reduce((s, it) => s + it.value, 0) || 1
  const scale = (box.w * box.h) / sum

  let free: Box = { ...box }
  let queue = items.map((it) => ({ ...it, area: it.value * scale }))

  const worst = (row: number[], side: number): number => {
    const total = row.reduce((s, v) => s + v, 0)
    const max = Math.max(...row)
    const min = Math.min(...row)
    return Math.max((side * side * max) / (total * total), (total * total) / (side * side * min))
  }

  while (queue.length) {
    const side = Math.min(free.w, free.h)
    const row: typeof queue = []
    while (queue.length) {
      const next = [...row.map((r) => r.area), queue[0].area]
      if (row.length && worst(row.map((r) => r.area), side) < worst(next, side)) break
      row.push(queue.shift()!)
    }

    const rowArea = row.reduce((s, r) => s + r.area, 0)
    const thickness = rowArea / side
    let offset = 0
    const horizontal = free.w >= free.h

    for (const cell of row) {
      const length = cell.area / thickness
      const rect: Box = horizontal
        ? { x: free.x, y: free.y + offset, w: thickness, h: length }
        : { x: free.x + offset, y: free.y, w: length, h: thickness }
      offset += length
      ctx.push({ m: 'rect', x: rect.x + 1, y: rect.y + 1, w: Math.max(0, rect.w - 2), h: Math.max(0, rect.h - 2), rx: 3, fill: cell.colour })
      // Two thresholds, not one: a cell wide enough for a name is often not
      // tall enough for a name and a figure, and half a figure hanging off the
      // bottom edge of a tile is worse than no figure.
      const ink = readableOn(cell.colour)
      if (rect.w > 46 && rect.h > 26) {
        ctx.push({ m: 'text', x: rect.x + 7, y: rect.y + 17, s: truncate(cell.key, rect.w - 14, LABEL_SIZE, 500), size: LABEL_SIZE, weight: 500, fill: ink })
        if (rect.h > 42) {
          ctx.push({ m: 'text', x: rect.x + 7, y: rect.y + 32, s: truncate(ctx.fmt(cell.total), rect.w - 14, TICK_SIZE), size: TICK_SIZE, fill: ink, opacity: 0.78, tnum: true })
        }
      }
    }

    free = horizontal
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness }
    if (free.w < 1 || free.h < 1) break
  }
  void theme
}

/** How the total builds up, one bucket at a time. */
function drawWaterfall(box: Box, ctx: Ctx): void {
  const { points, theme } = ctx
  const labelHeight = xLabelHeight([...points.map((p) => p.key), 'Total'], (box.w - 44) / (points.length + 1))
  const plotH = box.h - labelHeight

  let running = 0
  const steps = points.map((p) => {
    const from = running
    running += p.total
    return { key: p.key, from, to: running, value: p.total }
  })
  const total = running

  const y = linear(extent([0, total, ...steps.flatMap((s) => [s.from, s.to])]), [box.y + plotH, box.y])
  const inner = yAxis({ ...box, h: plotH }, y, ctx, ctx.brief)
  const keys = [...steps.map((s) => s.key), 'Total']
  const x = band(keys, [inner.x, inner.x + inner.w], 0.3)

  steps.forEach((s, i) => {
    const top = y.map(Math.max(s.from, s.to))
    const bottom = y.map(Math.min(s.from, s.to))
    ctx.push({ m: 'rect', x: x.map(s.key), y: top, w: x.bandwidth, h: Math.max(bottom - top, 1.5), rx: 2.5, fill: ctx.colour(i) })
    // The connector is what makes it a waterfall rather than a row of bars.
    if (i < steps.length - 1) {
      const yy = y.map(s.to)
      ctx.push({ m: 'line', x1: x.map(s.key), y1: yy, x2: x.map(steps[i + 1].key) + x.bandwidth, y2: yy, stroke: theme.faint, width: 1, dash: '3 3', opacity: 0.7 })
    }
  })

  const tTop = y.map(Math.max(total, 0))
  const tZero = y.map(0)
  ctx.push({ m: 'path', d: barPath(x.map('Total'), tTop, x.bandwidth, tZero - tTop, 3), fill: theme.ink, opacity: 0.82 })
  xLabels({ ...inner, h: plotH }, x, ctx, labelHeight)
}

/**
 * Bars plus a running share.
 *
 * The chart that answers "where did most of it go" directly: bars descending,
 * a cumulative percentage line over them, and an 80% rule to read it against.
 */
function drawPareto(box: Box, ctx: Ctx): void {
  const { theme } = ctx
  const points = [...ctx.points].sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  const total = points.reduce((s, p) => s + Math.abs(p.total), 0) || 1
  const labelHeight = xLabelHeight(points.map((p) => p.key), (box.w - 88) / Math.max(points.length, 1))
  const plotH = box.h - labelHeight

  const y = linear(extent(points.map((p) => Math.abs(p.total))), [box.y + plotH, box.y])
  const right = 40
  const inner = yAxis({ ...box, w: box.w - right, h: plotH }, y, ctx, ctx.brief)
  const x = band(points.map((p) => p.key), [inner.x, inner.x + inner.w], 0.28)
  const pct = linear([0, 1], [box.y + plotH, box.y])

  for (const t of [0.25, 0.5, 0.75, 1]) {
    ctx.push({ m: 'text', x: inner.x + inner.w + 8, y: pct.map(t) + 3.5, s: `${t * 100}%`, size: TICK_SIZE, fill: theme.faint, tnum: true })
  }
  ctx.push({ m: 'line', x1: inner.x, y1: pct.map(0.8), x2: inner.x + inner.w, y2: pct.map(0.8), stroke: theme.faint, width: 1, dash: '4 3', opacity: 0.8 })

  let acc = 0
  const curve: Array<[number, number]> = []
  points.forEach((p, i) => {
    const top = y.map(Math.abs(p.total))
    const zero = y.map(0)
    ctx.push({ m: 'path', d: barPath(x.map(p.key), top, x.bandwidth, zero - top, 3), fill: ctx.colour(i), opacity: 0.9 })
    acc += Math.abs(p.total) / total
    curve.push([x.centre(p.key), pct.map(acc)])
  })

  ctx.push({ m: 'path', d: linePath(curve), stroke: theme.ink, width: 1.8, join: 'round' })
  for (const [cx, cy] of curve) ctx.push({ m: 'circle', cx, cy, r: 2.6, fill: theme.surface, stroke: theme.ink, width: 1.6 })
  xLabels({ ...inner, h: plotH }, x, ctx, labelHeight)
}
