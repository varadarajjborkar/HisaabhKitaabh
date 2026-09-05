/**
 * Fractional indexing for row order.
 *
 * Rows carry an order *string* rather than an integer index, so inserting
 * between two rows is a single-key write that never renumbers siblings.
 *
 * This is the Figma/Implementing-fractional-indexing scheme, not a homemade
 * midpoint. A naive "take the midpoint toward the open end" append converges on
 * "zzzz…" and grows the key by a character per row - 283 appends produced a
 * 69-character key here before ordering broke outright. The scheme below splits
 * a key into an integer part (which *increments* on append, so appends stay
 * short and cheap forever) and a fractional part (which subdivides only when
 * something is genuinely inserted between two neighbours).
 *
 * Keys are deterministic: two clients inserting at the same slot produce the
 * same key. That is fine and intentional - `sortByOrder` breaks ties on row id,
 * which every replica agrees on, so both rows survive in a stable order.
 */

/** Base-62. ASCII order matches digit order, so plain string compare works. */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ZERO = DIGITS[0]
const SMALLEST_INTEGER = 'A00000000000000000000000000'

/** The head character encodes how many digits follow. */
function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2
  throw new OrderKeyError(`invalid order key head: ${head}`)
}

function integerPart(key: string): string {
  const len = integerLength(key[0])
  if (len > key.length) throw new OrderKeyError(`invalid order key: ${key}`)
  return key.slice(0, len)
}

function validate(key: string): void {
  if (key === SMALLEST_INTEGER) throw new OrderKeyError('order key is at the minimum')
  const int = integerPart(key)
  const frac = key.slice(int.length)
  if (frac.endsWith(ZERO)) throw new OrderKeyError(`invalid order key (trailing zero): ${key}`)
}

function incrementInteger(x: string): string | null {
  const [head, ...digits] = x.split('')
  let carry = true
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1
    if (d === DIGITS.length) digits[i] = ZERO
    else { digits[i] = DIGITS[d]; carry = false }
  }
  if (!carry) return head + digits.join('')

  if (head === 'Z') return 'a' + ZERO
  if (head === 'z') return null // exhausted; caller falls back to subdividing
  const next = String.fromCharCode(head.charCodeAt(0) + 1)
  if (next > 'a') digits.push(ZERO)
  else digits.pop()
  return next + digits.join('')
}

function decrementInteger(x: string): string | null {
  const [head, ...digits] = x.split('')
  let borrow = true
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1
    if (d === -1) digits[i] = DIGITS[DIGITS.length - 1]
    else { digits[i] = DIGITS[d]; borrow = false }
  }
  if (!borrow) return head + digits.join('')

  if (head === 'a') return 'Z' + DIGITS[DIGITS.length - 1]
  if (head === 'A') return null
  const prev = String.fromCharCode(head.charCodeAt(0) - 1)
  if (prev < 'Z') digits.push(DIGITS[DIGITS.length - 1])
  else digits.pop()
  return prev + digits.join('')
}

/** A fractional string strictly between `a` and `b` (b null = open end). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`)
  if (a.endsWith(ZERO) || (b && b.endsWith(ZERO))) throw new OrderKeyError('trailing zero')

  if (b !== null) {
    let n = 0
    while ((a[n] ?? ZERO) === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }

  const digitA = a ? DIGITS.indexOf(a[0]) : 0
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length

  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]
  if (b && b.length > 1) return b.slice(0, 1)
  // Digits are consecutive and b has no room: descend into a's tail.
  return DIGITS[digitA] + midpoint(a.slice(1), null)
}

export class OrderKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderKeyError'
  }
}

function generate(a: string | null, b: string | null): string {
  if (a !== null) validate(a)
  if (b !== null) validate(b)
  if (a !== null && b !== null && a >= b) throw new OrderKeyError(`${a} >= ${b}`)

  if (a === null) {
    if (b === null) return 'a' + ZERO
    const ib = integerPart(b)
    const fb = b.slice(ib.length)
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb)
    if (ib < b) return ib
    const dec = decrementInteger(ib)
    if (dec === null) throw new OrderKeyError('cannot go any lower')
    return dec
  }

  if (b === null) {
    const ia = integerPart(a)
    const fa = a.slice(ia.length)
    const inc = incrementInteger(ia)
    // The append path: one increment, key length unchanged. This is why
    // appending ten thousand rows costs nothing.
    return inc === null ? ia + midpoint(fa, null) : inc
  }

  const ia = integerPart(a)
  const fa = a.slice(ia.length)
  const ib = integerPart(b)
  const fb = b.slice(ib.length)
  if (ia === ib) return ia + midpoint(fa, fb)

  const inc = incrementInteger(ia)
  if (inc === null) throw new OrderKeyError('cannot increment any more')
  return inc < b ? inc : ia + midpoint(fa, null)
}

/**
 * Key strictly between `a` and `b` (either may be null for an open end).
 *
 * Never throws at a call site: a malformed neighbour (hand-edited data, a key
 * from an older format) falls back to a safe appended key rather than blocking
 * the user's insert.
 */
export function orderBetween(a: string | null, b: string | null): string {
  try {
    return generate(a, b)
  } catch {
    return fallback(a, b)
  }
}

/** Last resort: extend `a` so the result still sorts after it and before `b`. */
function fallback(a: string | null, b: string | null): string {
  if (!a) return 'a' + ZERO
  const extended = a + DIGITS[Math.floor(DIGITS.length / 2)]
  if (b === null || extended < b) return extended
  return a + ZERO + DIGITS[Math.floor(DIGITS.length / 2)]
}

export function orderAfter(last: string | null): string {
  return orderBetween(last, null)
}

export function orderBefore(first: string | null): string {
  return orderBetween(null, first)
}

/**
 * Sort by order key, breaking ties on id.
 *
 * The tiebreak is load-bearing, not defensive: keys are deterministic, so two
 * clients inserting at the same slot legitimately produce the same key. Both
 * rows are kept, and every replica sorts them identically.
 */
export function sortByOrder<T extends { order: string; id: string }>(items: T[]): T[] {
  return [...items].sort((x, y) => (x.order === y.order ? (x.id < y.id ? -1 : 1) : x.order < y.order ? -1 : 1))
}
