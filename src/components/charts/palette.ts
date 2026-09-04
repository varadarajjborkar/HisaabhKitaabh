/**
 * Chart palette.
 *
 * These eight hues and their dark-mode steps are the validated reference set:
 * every adjacent pair clears the CVD separation and normal-vision floors in
 * both light and dark. The *order* is the safety mechanism, not decoration —
 * assign slots in sequence and never cycle past eight. A ninth series folds
 * into "Other".
 *
 * Three light-mode slots sit under 3:1 against a white surface, so every chart
 * here ships direct labels and a legend; identity is never carried by colour
 * alone.
 */

export const SERIES_LIGHT = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const

export const SERIES_DARK = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#008300',
  '#9085e9',
  '#e66767',
] as const

export const MAX_SERIES = SERIES_LIGHT.length

/** Sequential blue ramp, light → dark. For magnitude, never for identity. */
export const SEQUENTIAL = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#2a78d6', '#256abf', '#184f95', '#0d366b'] as const

export function seriesColor(index: number, dark: boolean): string {
  const set = dark ? SERIES_DARK : SERIES_LIGHT
  return set[index % set.length]
}

/**
 * Group a list into at most `max` slices, everything else summed into "Other".
 * Colour follows the entity's position in the sorted list, so filtering the
 * chart never repaints the survivors.
 */
export function withOther<T extends { key: string; total: number }>(
  items: T[],
  max = MAX_SERIES - 1,
): Array<{ key: string; total: number; isOther: boolean }> {
  // Merge repeats first. Two rows both titled "Coffee" are one slice of the
  // composition, not two identical legend entries competing for the same colour.
  const merged = new Map<string, number>()
  for (const item of items) merged.set(item.key, (merged.get(item.key) ?? 0) + item.total)

  const sorted = [...merged.entries()]
    .map(([key, total]) => ({ key, total }))
    .sort((a, b) => b.total - a.total)

  if (sorted.length <= max + 1) return sorted.map((s) => ({ ...s, isOther: false }))

  const head = sorted.slice(0, max).map((s) => ({ ...s, isOther: false }))
  const rest = sorted.slice(max)
  return [...head, { key: `Other (${rest.length})`, total: rest.reduce((s, r) => s + r.total, 0), isOther: true }]
}

/** Axis ticks on clean round numbers. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const ticks: number[] = []
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100)
  return ticks
}
