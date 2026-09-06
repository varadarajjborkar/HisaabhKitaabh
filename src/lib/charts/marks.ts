/**
 * Marks: what to draw, with no idea how to draw it.
 *
 * Every chart type in this engine compiles down to a list of these. That is
 * the whole trick, and the reason a new chart type costs twenty lines rather
 * than two hundred: a waterfall is rectangles and connector lines, a pareto is
 * rectangles plus a path, a treemap is rectangles with labels inside them. The
 * SVG writer knows five shapes and nothing about charts; the plot builder
 * knows about charts and nothing about SVG.
 *
 * It also makes the geometry testable without rendering. "The bar for 18,735
 * is 41.6 times the height of the bar for 450" is an assertion about this
 * array, which is plain data.
 */

export type Anchor = 'start' | 'middle' | 'end'
export type Baseline = 'auto' | 'middle' | 'hanging'

export type Mark =
  | { m: 'rect'; x: number; y: number; w: number; h: number; fill: string; rx?: number; opacity?: number; stroke?: string; title?: string }
  | { m: 'path'; d: string; fill?: string; stroke?: string; width?: number; opacity?: number; dash?: string; join?: 'round' | 'miter' }
  | { m: 'circle'; cx: number; cy: number; r: number; fill: string; stroke?: string; width?: number; opacity?: number; title?: string }
  | { m: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; width?: number; dash?: string; opacity?: number }
  | { m: 'text'; x: number; y: number; s: string; size: number; fill: string; weight?: number; anchor?: Anchor; baseline?: Baseline; opacity?: number; tnum?: boolean; rotate?: number; title?: string }

/** A rounded-top rectangle, for bars that should not look like bricks. */
export function barPath(x: number, y: number, w: number, h: number, r: number, up = true): string {
  const radius = Math.max(0, Math.min(r, w / 2, Math.abs(h)))
  if (radius < 0.5) return `M${x} ${y}h${w}v${h}h${-w}Z`
  return up
    ? `M${x} ${y + h}V${y + radius}a${radius} ${radius} 0 0 1 ${radius} ${-radius}h${w - radius * 2}a${radius} ${radius} 0 0 1 ${radius} ${radius}V${y + h}Z`
    : `M${x} ${y}V${y + h - radius}a${radius} ${radius} 0 0 0 ${radius} ${radius}h${w - radius * 2}a${radius} ${radius} 0 0 0 ${radius} ${-radius}V${y}Z`
}

/** A horizontal bar with its right end rounded. */
export function hBarPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.max(0, Math.min(r, h / 2, Math.abs(w)))
  if (radius < 0.5) return `M${x} ${y}h${w}v${h}h${-w}Z`
  return `M${x} ${y}h${w - radius}a${radius} ${radius} 0 0 1 ${radius} ${radius}v${h - radius * 2}a${radius} ${radius} 0 0 1 ${-radius} ${radius}h${-(w - radius)}Z`
}

/** An annular segment, for donuts and pies. `inner` of 0 gives a pie. */
export function arcPath(cx: number, cy: number, outer: number, inner: number, from: number, to: number): string {
  // A full circle cannot be drawn as one arc: the start and end points
  // coincide and the path collapses. Two half arcs, or nothing renders.
  const sweep = to - from
  if (sweep >= Math.PI * 2 - 1e-6) {
    const mid = from + Math.PI
    return [arcPath(cx, cy, outer, inner, from, mid), arcPath(cx, cy, outer, inner, mid, from + Math.PI * 2)].join(' ')
  }
  const large = sweep > Math.PI ? 1 : 0
  const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`
  if (inner <= 0) {
    return `M${cx.toFixed(2)} ${cy.toFixed(2)}L${p(outer, from)}A${outer} ${outer} 0 ${large} 1 ${p(outer, to)}Z`
  }
  return `M${p(outer, from)}A${outer} ${outer} 0 ${large} 1 ${p(outer, to)}L${p(inner, to)}A${inner} ${inner} 0 ${large} 0 ${p(inner, from)}Z`
}

/** A polyline through points, optionally closed down to a baseline. */
export function linePath(points: Array<[number, number]>, baseline?: number): string {
  if (points.length === 0) return ''
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('')
  if (baseline == null) return d
  const first = points[0]
  const last = points[points.length - 1]
  return `${d}L${last[0].toFixed(2)} ${baseline.toFixed(2)}L${first[0].toFixed(2)} ${baseline.toFixed(2)}Z`
}

/**
 * A smoothed polyline, using a monotone cubic fit.
 *
 * Chosen over a plain Catmull-Rom because monotone interpolation cannot
 * overshoot: a spending line that never went below zero must not dip under it
 * between two points just because the curve looked nicer that way.
 */
export function smoothPath(points: Array<[number, number]>, baseline?: number): string {
  const n = points.length
  if (n < 3) return linePath(points, baseline)

  const slope: number[] = []
  const dx: number[] = []
  const dy: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1][0] - points[i][0]
    dy[i] = points[i + 1][1] - points[i][1]
    slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i]
  }

  const m: number[] = [slope[0]]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) { m[i] = 0; continue }
    const w1 = 2 * dx[i] + dx[i - 1]
    const w2 = dx[i] + 2 * dx[i - 1]
    m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i])
  }
  m[n - 1] = slope[n - 2]

  let d = `M${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[i + 1]
    const t = dx[i] / 3
    d += `C${(x0 + t).toFixed(2)} ${(y0 + m[i] * t).toFixed(2)} ${(x1 - t).toFixed(2)} ${(y1 - m[i + 1] * t).toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`
  }
  if (baseline == null) return d
  return `${d}L${points[n - 1][0].toFixed(2)} ${baseline.toFixed(2)}L${points[0][0].toFixed(2)} ${baseline.toFixed(2)}Z`
}
