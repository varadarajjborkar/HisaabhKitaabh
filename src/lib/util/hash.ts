import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Server-only. Password hashing and real digests; see util/stable.ts for the isomorphic pair. */

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

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export { stableStringify, contentHash } from './stable'
