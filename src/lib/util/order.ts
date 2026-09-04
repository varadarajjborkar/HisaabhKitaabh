/**
 * Fractional indexing (LexoRank-style) for row order.
 *
 * Rows carry an order *string* rather than an integer index so that inserting a
 * row between two others is a single-key write that never renumbers siblings.
 * Two clients inserting at the same slot get different keys (the random suffix)
 * and both survive — no lost insert, no reshuffle storm.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'
const BASE = DIGITS.length

function digit(c: string): number {
  const i = DIGITS.indexOf(c)
  return i < 0 ? 0 : i
}

/** Midpoint key strictly between `a` and `b` (either may be null = open end). */
export function orderBetween(a: string | null, b: string | null): string {
  const lo = a ?? ''
  const hi = b ?? ''
  if (lo && hi && lo >= hi) throw new Error(`orderBetween: bounds out of order (${lo} >= ${hi})`)

  let prefix = ''
  let i = 0
  for (;;) {
    const dl = i < lo.length ? digit(lo[i]) : 0
    const dh = i < hi.length ? digit(hi[i]) : BASE
    if (dh - dl > 1) {
      const mid = dl + Math.floor((dh - dl) / 2)
      return prefix + DIGITS[mid] + jitter()
    }
    // Digits are adjacent: descend, keeping the low bound's digit.
    prefix += DIGITS[dl]
    i++
    if (i > 64) return prefix + DIGITS[Math.floor(BASE / 2)] + jitter()
  }
}

/** A small random tail so concurrent inserts at the same slot never collide. */
function jitter(): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += DIGITS[Math.floor(Math.random() * BASE)]
  return s
}

export function orderAfter(last: string | null): string {
  return orderBetween(last, null)
}

export function sortByOrder<T extends { order: string; id: string }>(items: T[]): T[] {
  return [...items].sort((x, y) => (x.order === y.order ? (x.id < y.id ? -1 : 1) : x.order < y.order ? -1 : 1))
}
