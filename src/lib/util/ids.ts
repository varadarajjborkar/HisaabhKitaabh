import { randomBytes, randomUUID } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * ULID: 48-bit timestamp + 80 bits of randomness, lexicographically sortable.
 * IDs are minted by whoever *originates* a row (browser or agent), which is what
 * makes row creation idempotent — a retried "add row" carries the same id and
 * collapses instead of producing a duplicate.
 */
export function ulid(now = Date.now()): string {
  let ts = ''
  let t = now
  for (let i = 9; i >= 0; i--) {
    ts = CROCKFORD[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const bytes = randomBytes(16)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32]
  return ts + rand
}

export function uuid(): string {
  return randomUUID()
}

export function shortId(n = 8): string {
  const b = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += CROCKFORD[b[i] % 32]
  return s
}
