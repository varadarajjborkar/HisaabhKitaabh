/**
 * Scales: the map from data to pixels.
 *
 * This is the layer that makes a chart honest. A bar is the right height
 * because a linear scale put it there, not because a drawing function did
 * arithmetic inline and got it right that time. Every mark in every chart type
 * goes through one of these, so "the bars are proportional to the values" is a
 * property of forty lines that can be tested on their own rather than a claim
 * about each renderer.
 */

export type Linear = {
  kind: 'linear'
  domain: [number, number]
  range: [number, number]
  map: (v: number) => number
  invert: (p: number) => number
  ticks: (count?: number) => number[]
}

export type Band = {
  kind: 'band'
  domain: string[]
  range: [number, number]
  map: (v: string) => number
  bandwidth: number
  step: number
  centre: (v: string) => number
}

export function linear(domain: [number, number], range: [number, number]): Linear {
  const [d0, d1] = domain
  const [r0, r1] = range
  // A flat series still has to draw. Without this a single-value chart divides
  // by zero and every mark lands on the same pixel.
  const span = d1 - d0 || 1
  return {
    kind: 'linear',
    domain,
    range,
    map: (v) => r0 + ((v - d0) / span) * (r1 - r0),
    invert: (p) => d0 + ((p - r0) / (r1 - r0 || 1)) * span,
    ticks: (count = 5) => niceTicks(d0, d1, count),
  }
}

export function band(domain: string[], range: [number, number], padding = 0.2): Band {
  const [r0, r1] = range
  const n = Math.max(domain.length, 1)
  const step = (r1 - r0) / n
  const bandwidth = step * (1 - padding)
  const offset = (step - bandwidth) / 2
  const index = new Map(domain.map((d, i) => [d, i]))
  const at = (v: string) => r0 + (index.get(v) ?? 0) * step + offset
  return { kind: 'band', domain, range, map: at, bandwidth, step, centre: (v) => at(v) + bandwidth / 2 }
}

/**
 * Round numbers covering [lo, hi].
 *
 * An axis labelled 0, 4271, 8542 is arithmetically correct and useless. The
 * step is snapped to 1, 2, 2.5, 5 or 10 times a power of ten, which is the set
 * a reader can do mental division by.
 */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!isFinite(lo) || !isFinite(hi) || hi === lo) return [lo]
  const raw = (hi - lo) / Math.max(count, 1)
  const mag = 10 ** Math.floor(Math.log10(Math.abs(raw) || 1))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const start = Math.ceil(lo / step) * step
  const out: number[] = []
  for (let v = start; v <= hi + step * 1e-6; v += step) {
    // Floating point leaves 0.30000000000000004 on an axis otherwise.
    out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)))
  }
  return out.length ? out : [lo, hi]
}

/**
 * A domain that includes zero and ends on a round number.
 *
 * Bars measure from zero or they lie about ratios, so the floor is pinned
 * there for any series that does not go negative.
 */
export function extent(values: number[], { zero = true }: { zero?: boolean } = {}): [number, number] {
  if (values.length === 0) return [0, 1]
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0) }
  if (lo === hi) { hi = lo + Math.abs(lo || 1); }
  const ticks = niceTicks(lo, hi, 5)
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : Math.abs(hi - lo) || 1
  return [zero && lo >= 0 ? 0 : Math.floor(lo / step) * step, Math.ceil(hi / step) * step]
}
