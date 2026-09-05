import { Redis } from '@upstash/redis'
import { env } from '../env'
import type { KV } from './kv'

/**
 * Upstash Redis, over HTTP.
 *
 * HTTP rather than a socket is the whole reason this works from a serverless
 * function: there is no connection to pool and none to leak when an instance is
 * frozen mid-request.
 *
 * Redis is optional. When a Postgres URL is configured Redis carries only the
 * disposable tier - caches, locks, rate limits - and losing all of it costs a
 * few slow page loads. When Postgres is absent it is the durable store instead,
 * which works but is a poor fit for attachments; see src/lib/db/sql.ts.
 */

const globalRedis = globalThis as typeof globalThis & { __hisaabRedis?: Redis }

function client(): Redis {
  if (!env.redis.enabled) throw new Error('Redis is not configured')
  return (globalRedis.__hisaabRedis ??= new Redis({ url: env.redis.url!, token: env.redis.token! }))
}

/** Delete a key only if it still holds the value we wrote. One round trip. */
const COMPARE_DEL = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`

export function redisKV(): KV {
  const r = client()
  return {
    durable: true,
    get: <T>(key: string) => r.get<T>(key).then((v) => v ?? null),
    async set(key, value, opts) {
      const args: Record<string, unknown> = {}
      if (opts?.ex) args.ex = opts.ex
      if (opts?.nx) args.nx = true
      const res = await r.set(key, value as never, args as never)
      return res === 'OK'
    },
    del: (...keys) => r.del(...keys),
    async compareDel(key, expected) {
      // The script compares the raw stored string, so the expected value has to
      // be encoded the same way the client encoded it on the way in.
      const encoded = typeof expected === 'string' ? expected : JSON.stringify(expected)
      const n = await r.eval(COMPARE_DEL, [key], [encoded])
      return Number(n) > 0
    },
    incr: (key) => r.incr(key),
    expire: async (key, s) => { await r.expire(key, s) },
    lpush: (key, ...values) => r.lpush(key, ...(values as never[])),
    lrange: <T>(key: string, start: number, stop: number) => r.lrange<T>(key, start, stop),
    ltrim: async (key, start, stop) => { await r.ltrim(key, start, stop) },
    sadd: (key, ...m) => r.sadd(key, ...(m as [string, ...string[]])),
    srem: (key, ...m) => r.srem(key, ...(m as [string, ...string[]])),
    smembers: (key) => r.smembers(key),
    hset: async (key, field, value) => { await r.hset(key, { [field]: value as never }) },
    hget: <T>(key: string, field: string) => r.hget<T>(key, field).then((v) => v ?? null),
    hgetall: <T>(key: string) =>
      r.hgetall<Record<string, T>>(key).then((v) => (v ?? {}) as Record<string, T>),
    hdel: async (key, ...fields) => { await r.hdel(key, ...fields) },
    zadd: async (key, score, member) => { await r.zadd(key, { score, member }) },
    zrange: <T = string>(key: string, start: number, stop: number, rev?: boolean) =>
      r.zrange<T[]>(key, start, stop, rev ? { rev: true } : undefined) as Promise<T[]>,
    zrem: async (key, ...members) => { await r.zrem(key, ...members) },
    keys: (pattern) => r.keys(pattern),
  }
}
