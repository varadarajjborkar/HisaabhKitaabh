import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384, r = 8, p = 1, KEYLEN = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, KEYLEN, { N, r, p })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, rr, pp, saltB64, keyB64] = stored.split('$')
    if (scheme !== 'scrypt') return false
    const salt = Buffer.from(saltB64, 'base64url')
    const expected = Buffer.from(keyB64, 'base64url')
    const actual = scryptSync(password, salt, expected.length, { N: Number(n), r: Number(rr), p: Number(pp) })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Stable content hash — used as the ETag / dedupe key for documents. */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('base64url').slice(0, 22)
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Deterministic JSON: key order can't change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}
