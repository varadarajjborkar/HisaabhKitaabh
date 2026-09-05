import { K, kv } from '../redis'
import { shortId } from '../util/ids'

/**
 * Mutex + idempotency primitives.
 *
 * Every write to a document goes: acquire lock -> read -> apply -> write -> release.
 * The lock keeps two writers (a human tab and the AI agent, say) from
 * interleaving read-modify-write cycles on the same doc, which is the classic
 * way one of them silently loses their edit.
 *
 * The lock is an optimisation, not the safety net: correctness still comes from
 * the revision check inside the document itself (see crdt/doc.ts). If Redis is
 * unavailable the lock degrades to a no-op and the rev check still refuses a
 * stale write.
 */

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

export type Lock = { key: string; token: string; release: () => Promise<void> }

export async function acquireLock(
  scope: string,
  { ttlMs = 10_000, waitMs = 5_000 }: { ttlMs?: number; waitMs?: number } = {},
): Promise<Lock | null> {
  const store = kv()
  const key = K.lock(scope)
  const token = shortId(16)
  const deadline = Date.now() + waitMs
  let delay = 25

  for (;;) {
    const got = await store.set(key, token, { nx: true, ex: Math.ceil(ttlMs / 1000) })
    if (got) {
      return {
        key,
        token,
        release: async () => {
          try {
            if (store.durable) await store.eval(RELEASE_SCRIPT, [key], [token])
            else if ((await store.get<string>(key)) === token) await store.del(key)
          } catch {
            /* lease expires on its own */
          }
        },
      }
    }
    if (Date.now() >= deadline) return null
    await sleep(delay + Math.random() * delay) // jittered backoff, avoids thundering herd
    delay = Math.min(delay * 2, 400)
  }
}

/** Run `fn` while holding `scope`. Throws LockTimeout if the lock can't be had. */
export async function withLock<T>(scope: string, fn: () => Promise<T>, opts?: { ttlMs?: number; waitMs?: number }): Promise<T> {
  const lock = await acquireLock(scope, opts)
  if (!lock) throw new LockTimeoutError(scope)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

export class LockTimeoutError extends Error {
  constructor(scope: string) {
    super(`Could not acquire lock for ${scope} - another write is in flight`)
    this.name = 'LockTimeoutError'
  }
}

/**
 * Idempotency: replay the stored result instead of performing the effect twice.
 * A retried request (flaky network, double-tap, agent retry) carries the same
 * key and gets the original answer back rather than creating a second row.
 */
export async function once<T>(userId: string, key: string, fn: () => Promise<T>, ttlSec = 60 * 60 * 24): Promise<{ result: T; replayed: boolean }> {
  const store = kv()
  const cacheKey = K.idem(userId, key)
  const prior = await store.get<{ v: T }>(cacheKey)
  if (prior) return { result: prior.v, replayed: true }

  // Claim the key first so a concurrent duplicate waits rather than racing us.
  const claimed = await store.set(cacheKey + ':claim', '1', { nx: true, ex: 120 })
  if (!claimed) {
    for (let i = 0; i < 40; i++) {
      await sleep(50)
      const done = await store.get<{ v: T }>(cacheKey)
      if (done) return { result: done.v, replayed: true }
    }
  }

  const result = await fn()
  await store.set(cacheKey, { v: result }, { ex: ttlSec })
  await store.del(cacheKey + ':claim')
  return { result, replayed: false }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Fixed-window rate limit. Cheap, and good enough to keep an agent loop honest. */
export async function rateLimit(userId: string, bucket: string, limit: number, windowSec: number): Promise<{ ok: boolean; remaining: number }> {
  const store = kv()
  const n = await store.incr(rateKey(userId, bucket, windowSec))
  if (n === 1) await store.expire(rateKey(userId, bucket, windowSec), windowSec)
  return { ok: n <= limit, remaining: Math.max(0, limit - n) }
}

function rateKey(userId: string, bucket: string, windowSec: number): string {
  return K.rate(userId, `${bucket}:${Math.floor(Date.now() / 1000 / windowSec)}`)
}

/**
 * Read a counter without touching it.
 *
 * Sign-in uses this so that only *failed* attempts count toward a lockout. A
 * counter that also ticks on success punishes the person with four devices and
 * a browser that re-authenticates, which is not who the limit is for.
 */
export async function rateCheck(userId: string, bucket: string, limit: number, windowSec: number): Promise<{ ok: boolean; remaining: number }> {
  const n = Number((await kv().get<number>(rateKey(userId, bucket, windowSec))) ?? 0)
  return { ok: n < limit, remaining: Math.max(0, limit - n) }
}

/** Record one failed attempt against the window. */
export async function rateNote(userId: string, bucket: string, windowSec: number): Promise<void> {
  const store = kv()
  const key = rateKey(userId, bucket, windowSec)
  const n = await store.incr(key)
  if (n === 1) await store.expire(key, windowSec)
}
