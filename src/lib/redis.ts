import { Redis } from '@upstash/redis'
import { env } from './env'

/**
 * Redis access with a process-local fallback.
 *
 * Upstash is HTTP-based, so it works from serverless functions with no
 * connection pool to exhaust. When it isn't configured (local dev, first boot)
 * we fall back to an in-process map so nothing crashes — the fallback is NOT
 * durable and NOT shared across instances, which `kv.durable` reports.
 */

export type KV = {
  durable: boolean
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<boolean>
  del(...keys: string[]): Promise<number>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<void>
  lpush(key: string, ...values: unknown[]): Promise<number>
  lrange<T>(key: string, start: number, stop: number): Promise<T[]>
  ltrim(key: string, start: number, stop: number): Promise<void>
  sadd(key: string, ...members: string[]): Promise<number>
  srem(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  hset(key: string, field: string, value: unknown): Promise<void>
  hget<T>(key: string, field: string): Promise<T | null>
  hgetall<T>(key: string): Promise<Record<string, T>>
  hdel(key: string, ...fields: string[]): Promise<void>
  zadd(key: string, score: number, member: string): Promise<void>
  zrange<T = string>(key: string, start: number, stop: number, rev?: boolean): Promise<T[]>
  zrem(key: string, ...members: string[]): Promise<void>
  keys(pattern: string): Promise<string[]>
  eval<T>(script: string, keys: string[], args: (string | number)[]): Promise<T>
}

let upstash: Redis | null = null
function client(): Redis | null {
  if (!env.redis.enabled) return null
  if (!upstash) upstash = new Redis({ url: env.redis.url!, token: env.redis.token! })
  return upstash
}

// ---------------------------------------------------------------- memory shim
type Entry = { value: unknown; expiresAt?: number }

/**
 * The fallback map lives on globalThis, not in module scope.
 *
 * Next gives each route handler its own module registry, so a module-scoped Map
 * would be a *different map per route* — a folder written by POST /api/folders
 * would be invisible to GET /api/folders/[id], which 404s for no apparent
 * reason. Hanging it off globalThis makes one map per process, which is what
 * "in-memory" should mean.
 *
 * It is still per-process: nothing survives a restart, and nothing is shared
 * between serverless instances. That is what `kv().durable` reports and why
 * Upstash is the answer for anything real.
 */
const globalMem = globalThis as typeof globalThis & { __khataMem?: Map<string, Entry> }
const mem: Map<string, Entry> = (globalMem.__khataMem ??= new Map<string, Entry>())

function memGet(key: string): unknown | null {
  const e = mem.get(key)
  if (!e) return null
  if (e.expiresAt && e.expiresAt < Date.now()) {
    mem.delete(key)
    return null
  }
  return e.value
}
function memList(key: string): unknown[] {
  const v = memGet(key)
  return Array.isArray(v) ? (v as unknown[]) : []
}
function memHash(key: string): Record<string, unknown> {
  const v = memGet(key)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function memZ(key: string): Array<[number, string]> {
  const v = memGet(key)
  return Array.isArray(v) ? (v as Array<[number, string]>) : []
}

const memoryKV: KV = {
  durable: false,
  async get<T>(key: string) {
    return (memGet(key) as T) ?? null
  },
  async set(key, value, opts) {
    if (opts?.nx && memGet(key) !== null) return false
    mem.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : undefined })
    return true
  },
  async del(...keys) {
    let n = 0
    for (const k of keys) if (mem.delete(k)) n++
    return n
  },
  async incr(key) {
    const n = Number(memGet(key) ?? 0) + 1
    mem.set(key, { value: n, expiresAt: mem.get(key)?.expiresAt })
    return n
  },
  async expire(key, seconds) {
    const e = mem.get(key)
    if (e) e.expiresAt = Date.now() + seconds * 1000
  },
  async lpush(key, ...values) {
    const list = memList(key)
    list.unshift(...values)
    mem.set(key, { value: list })
    return list.length
  },
  async lrange<T>(key: string, start: number, stop: number) {
    const list = memList(key)
    const end = stop < 0 ? list.length + stop + 1 : stop + 1
    return list.slice(start < 0 ? Math.max(0, list.length + start) : start, end) as T[]
  },
  async ltrim(key, start, stop) {
    const list = memList(key)
    const end = stop < 0 ? list.length + stop + 1 : stop + 1
    mem.set(key, { value: list.slice(start, end) })
  },
  async sadd(key, ...members) {
    const s = new Set((memGet(key) as string[]) ?? [])
    let added = 0
    for (const m of members) if (!s.has(m)) { s.add(m); added++ }
    mem.set(key, { value: [...s] })
    return added
  },
  async srem(key, ...members) {
    const s = new Set((memGet(key) as string[]) ?? [])
    let removed = 0
    for (const m of members) if (s.delete(m)) removed++
    mem.set(key, { value: [...s] })
    return removed
  },
  async smembers(key) {
    return ((memGet(key) as string[]) ?? []).slice()
  },
  async hset(key, field, value) {
    const h = memHash(key)
    h[field] = value
    mem.set(key, { value: h })
  },
  async hget<T>(key: string, field: string) {
    return (memHash(key)[field] as T) ?? null
  },
  async hgetall<T>(key: string) {
    return memHash(key) as Record<string, T>
  },
  async hdel(key, ...fields) {
    const h = memHash(key)
    for (const f of fields) delete h[f]
    mem.set(key, { value: h })
  },
  async zadd(key, score, member) {
    const z = memZ(key).filter(([, m]) => m !== member)
    z.push([score, member])
    z.sort((a, b) => a[0] - b[0])
    mem.set(key, { value: z })
  },
  async zrange<T = string>(key: string, start: number, stop: number, rev?: boolean) {
    let z = memZ(key)
    if (rev) z = [...z].reverse()
    const end = stop < 0 ? z.length + stop + 1 : stop + 1
    return z.slice(start, end).map(([, m]) => m) as T[]
  },
  async zrem(key, ...members) {
    mem.set(key, { value: memZ(key).filter(([, m]) => !members.includes(m)) })
  },
  async keys(pattern) {
    const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    const out: string[] = []
    for (const k of mem.keys()) if (rx.test(k)) out.push(k)
    return out
  },
  async eval<T>(_script: string, _keys: string[], _args: (string | number)[]) {
    throw new Error('eval unsupported in memory KV')
  },
}

// ------------------------------------------------------------------- upstash
function upstashKV(r: Redis): KV {
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
    eval: <T>(script: string, keys: string[], args: (string | number)[]) => r.eval(script, keys, args) as Promise<T>,
  }
}

const globalKV = globalThis as typeof globalThis & { __khataKV?: KV }

export function kv(): KV {
  if (globalKV.__khataKV) return globalKV.__khataKV
  const r = client()
  globalKV.__khataKV = r ? upstashKV(r) : memoryKV
  return globalKV.__khataKV
}

export const K = {
  user: (id: string) => `u:${id}`,
  userByEmail: (email: string) => `u:email:${email.toLowerCase()}`,
  userIndex: 'u:all',
  oauth: (state: string) => `oauth:${state}`,
  googleTokens: (userId: string) => `gtok:${userId}`,

  folders: (userId: string) => `d:${userId}:folders`,
  seeded: (userId: string) => `d:${userId}:seeded`,
  files: (userId: string, folderId: string) => `d:${userId}:f:${folderId}:files`,
  doc: (userId: string, fileId: string) => `d:${userId}:doc:${fileId}`,
  docIndex: (userId: string) => `d:${userId}:docs`,
  attachment: (userId: string, id: string) => `d:${userId}:att:${id}`,

  cacheDoc: (userId: string, fileId: string) => `c:${userId}:doc:${fileId}`,
  lock: (scope: string) => `lock:${scope}`,
  idem: (userId: string, key: string) => `idem:${userId}:${key}`,

  chat: (userId: string, threadId: string) => `chat:${userId}:${threadId}`,
  chatIndex: (userId: string) => `chat:${userId}:threads`,
  chatSummary: (userId: string, threadId: string) => `chat:${userId}:${threadId}:sum`,
  pending: (userId: string, actionId: string) => `pend:${userId}:${actionId}`,
  memory: (userId: string) => `mem:${userId}`,
  grants: (userId: string, threadId: string) => `grant:${userId}:${threadId}`,

  rate: (userId: string, bucket: string) => `rl:${userId}:${bucket}`,
} as const
