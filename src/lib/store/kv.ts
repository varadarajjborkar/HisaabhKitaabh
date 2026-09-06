import { env } from '../env'
import { sqlKV } from '../db/sql'
import { redisKV } from './kv-redis'

/**
 * The key/value surface the whole app persists through, and the routing that
 * decides where each key actually lands.
 *
 * Three implementations sit behind it:
 *   - Postgres  (src/lib/db/sql.ts)   durable, the default home for an account
 *   - Redis     (src/lib/store/kv-redis.ts)  fast, optional
 *   - memory    (below)               a process-local map, for local dev only
 *
 * Keys are split across two tiers rather than one store. Account data - users,
 * folders, documents, chat history, memory - goes to the durable store. Hot,
 * disposable keys - caches, locks, rate-limit counters, idempotency records -
 * go to the fast store when there is one. Nothing is lost if the fast tier is
 * cold or missing: every key in it either rebuilds itself or is a lease that
 * was already allowed to expire.
 *
 * When only one store is configured both tiers point at it and the routing is a
 * no-op, which is the common case.
 */

export type KV = {
  durable: boolean
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<boolean>
  del(...keys: string[]): Promise<number>
  /** Delete only if the stored value still matches. Releasing a lock you own. */
  compareDel(key: string, expected: unknown): Promise<boolean>
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
}

// ---------------------------------------------------------------- memory shim
type Entry = { value: unknown; expiresAt?: number }

/**
 * The fallback map lives on globalThis, not in module scope.
 *
 * Next gives each route handler its own module registry, so a module-scoped Map
 * would be a *different map per route* - a folder written by POST /api/folders
 * would be invisible to GET /api/folders/[id], which 404s for no apparent
 * reason. Hanging it off globalThis makes one map per process, which is what
 * "in-memory" should mean.
 *
 * It is still per-process: nothing survives a restart, and nothing is shared
 * between serverless instances. That is what `durable` reports, and it is why a
 * deployment without a database is a demo rather than an installation.
 */
const globalMem = globalThis as typeof globalThis & { __hisaabMem?: Map<string, Entry> }
const mem: Map<string, Entry> = (globalMem.__hisaabMem ??= new Map<string, Entry>())

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

export const memoryKV: KV = {
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
  async compareDel(key, expected) {
    if (JSON.stringify(memGet(key)) !== JSON.stringify(expected)) return false
    return mem.delete(key)
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
}

// ----------------------------------------------------------------- routing

/**
 * Keys that may be thrown away. Everything not listed here is account data and
 * goes to the durable store.
 */
const DISPOSABLE = ['c:', 'lock:', 'rl:', 'idem:', 'health:', 'fx:']

function disposable(key: string): boolean {
  return DISPOSABLE.some((p) => key.startsWith(p))
}

export type Backends = { primary: KV; fast: KV; primaryName: string; fastName: string }

const globalKV = globalThis as typeof globalThis & { __hisaabBackends?: Backends; __hisaabKV?: KV }

function build(): Backends {
  // Both clients are built lazily by their own modules, so naming a backend
  // here costs nothing until a key is actually routed to it.
  const durable = env.database.enabled ? { kv: sqlKV(), name: 'Postgres' } : null
  const cache = env.redis.enabled ? { kv: redisKV(), name: 'Redis' } : null

  const primary = durable ?? cache ?? { kv: memoryKV, name: 'In-memory (not durable)' }
  const fast = cache ?? primary
  return { primary: primary.kv, fast: fast.kv, primaryName: primary.name, fastName: fast.name }
}

export function backends(): Backends {
  return (globalKV.__hisaabBackends ??= build())
}

function router(b: Backends): KV {
  const to = (key: string) => (disposable(key) ? b.fast : b.primary)
  return {
    durable: b.primary.durable,
    get: (key) => to(key).get(key),
    set: (key, value, opts) => to(key).set(key, value, opts),
    // Callers only ever delete keys of one kind at a time, but splitting is
    // cheap and beats a silent miss if that ever stops being true.
    async del(...keys) {
      const hot = keys.filter(disposable)
      const cold = keys.filter((k) => !disposable(k))
      const counts = await Promise.all([
        hot.length ? b.fast.del(...hot) : Promise.resolve(0),
        cold.length ? b.primary.del(...cold) : Promise.resolve(0),
      ])
      return counts[0] + counts[1]
    },
    compareDel: (key, expected) => to(key).compareDel(key, expected),
    incr: (key) => to(key).incr(key),
    expire: (key, seconds) => to(key).expire(key, seconds),
    lpush: (key, ...values) => to(key).lpush(key, ...values),
    lrange: (key, start, stop) => to(key).lrange(key, start, stop),
    ltrim: (key, start, stop) => to(key).ltrim(key, start, stop),
    sadd: (key, ...members) => to(key).sadd(key, ...members),
    srem: (key, ...members) => to(key).srem(key, ...members),
    smembers: (key) => to(key).smembers(key),
    hset: (key, field, value) => to(key).hset(key, field, value),
    hget: (key, field) => to(key).hget(key, field),
    hgetall: (key) => to(key).hgetall(key),
    hdel: (key, ...fields) => to(key).hdel(key, ...fields),
    zadd: (key, score, member) => to(key).zadd(key, score, member),
    zrange: (key, start, stop, rev) => to(key).zrange(key, start, stop, rev),
    zrem: (key, ...members) => to(key).zrem(key, ...members),
    keys: (pattern) => to(pattern).keys(pattern),
  }
}

export function kv(): KV {
  return (globalKV.__hisaabKV ??= router(backends()))
}

export const K = {
  user: (id: string) => `u:${id}`,
  userByEmail: (email: string) => `u:email:${email.toLowerCase()}`,
  userByUsername: (name: string) => `u:name:${name.toLowerCase()}`,
  userIndex: 'u:all',
  oauth: (state: string) => `oauth:${state}`,
  /** A password reset in flight: the code by mailbox, then the ticket it earns. */
  resetCode: (email: string) => `pwr:code:${email.toLowerCase()}`,
  resetTicket: (digest: string) => `pwr:tkt:${digest}`,
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
  /** User-supplied conversation names, keyed by thread id. */
  chatTitles: (userId: string) => `chat:${userId}:titles`,
  pending: (userId: string, actionId: string) => `pend:${userId}:${actionId}`,
  memory: (userId: string) => `mem:${userId}`,
  grants: (userId: string, threadId: string) => `grant:${userId}:${threadId}`,

  rate: (userId: string, bucket: string) => `rl:${userId}:${bucket}`,
} as const
