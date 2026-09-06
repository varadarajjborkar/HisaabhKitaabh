import postgres from 'postgres'
import { env } from '../env'
import type { KV } from '../store/kv'

/**
 * Postgres: the account's own storage.
 *
 * Every account gets a home here whether or not it ever connects Google Drive.
 * Drive is a choice a user makes, not a precondition for using the app, so the
 * default has to be a store we run ourselves.
 *
 * Why Postgres and not just Redis. Redis is priced by memory and sized in
 * hundreds of megabytes on the tiers anyone starts on, and a single receipt
 * photo is a few hundred kilobytes. An expense tracker whose whole point is
 * attaching receipts fills that budget in an afternoon, and when it fills, the
 * failure is data loss rather than a slow page. Postgres is priced by disk,
 * takes a backup, and can be read with a query when something looks wrong.
 * Redis stays useful for what Redis is actually good at - locks, caches, rate
 * limits - and is optional.
 *
 * There are two tables. `hk_kv` is a key/value store with expiry, which is
 * enough to back every structure the app keeps (documents, folders, chat
 * threads, memory), and `hk_attachments` holds file bytes as `bytea` rather
 * than base64 inside JSON, which would cost a third more space and a parse of
 * the whole blob on every read.
 *
 * The driver is provider-neutral on purpose: this works against Neon, Supabase,
 * Vercel Postgres, Railway or a Postgres you run yourself, with no code change.
 */

type Sql = ReturnType<typeof postgres>

const globalSql = globalThis as typeof globalThis & { __hisaabSql?: Sql; __hisaabSqlReady?: Promise<void> }

export const sqlEnabled = Boolean(env.database.url)

function needsTls(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.searchParams.has('sslmode')) return false // the URL already says what it wants
    return !['localhost', '127.0.0.1', '::1'].includes(u.hostname)
  } catch {
    return false
  }
}

export function db(): Sql {
  if (!env.database.url) throw new Error('No DATABASE_URL is configured')
  if (globalSql.__hisaabSql) return globalSql.__hisaabSql
  const url = env.database.url
  globalSql.__hisaabSql = postgres(url, {
    // One connection per instance. Serverless scales by adding instances, not
    // by widening a pool, and a pool per instance is how you exhaust a
    // database's connection limit during a traffic spike. Use the provider's
    // pooled/pgBouncer URL and this stays comfortable.
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    // Required for transaction-mode poolers (Supabase's 6543, pgBouncer):
    // prepared statements do not survive a connection being handed to someone
    // else between statements.
    prepare: false,
    ...(needsTls(url) ? { ssl: 'require' as const } : {}),
    onnotice: () => {},
  })
  return globalSql.__hisaabSql
}

const SCHEMA = `
create table if not exists hk_kv (
  k          text primary key,
  owner      text,
  v          jsonb not null,
  expires_at timestamptz
);
create index if not exists hk_kv_owner_idx on hk_kv (owner) where owner is not null;
create index if not exists hk_kv_expires_idx on hk_kv (expires_at) where expires_at is not null;

create table if not exists hk_attachments (
  owner      text not null,
  id         text not null,
  name       text not null,
  mime       text not null,
  size       integer not null,
  bytes      bytea not null,
  created_at timestamptz not null default now(),
  primary key (owner, id)
);
create index if not exists hk_attachments_owner_idx on hk_attachments (owner, created_at desc);
`

/**
 * Create the schema, once per process and once per database.
 *
 * Two instances booting together would otherwise race: `create table if not
 * exists` is not atomic against a concurrent create and raises a duplicate-key
 * error on the system catalogue. The advisory lock is transaction-scoped, so it
 * releases on its own if an instance dies mid-migration and it works through a
 * transaction-mode pooler.
 */
export function ready(): Promise<void> {
  if (!globalSql.__hisaabSqlReady) {
    globalSql.__hisaabSqlReady = (async () => {
      const sql = db()
      await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(4712009)`
        await tx.unsafe(SCHEMA)
      })
    })().catch((err) => {
      globalSql.__hisaabSqlReady = undefined // let the next request try again
      throw err
    })
  }
  return globalSql.__hisaabSqlReady
}

/**
 * Which account a key belongs to.
 *
 * Keys are already namespaced by user; lifting that into a column is what makes
 * this a per-account store rather than one shared bucket. It buys three things
 * that matter once real people sign up: "how much is this account using",
 * "export everything this account owns", and a delete that provably leaves
 * nothing behind.
 */
const OWNER_AT_1 = new Set(['d', 'c', 'chat', 'pend', 'mem', 'grant', 'rl', 'idem', 'oplog', 'gtok'])
/** Second segments under `u:` that name an index rather than a user. */
const U_INDEXES = new Set(['email', 'name', 'all'])

export function ownerOf(key: string): string | null {
  const parts = key.split(':')
  if (parts.length < 2) return null
  if (OWNER_AT_1.has(parts[0])) return parts[1] || null
  // `u:<id>` belongs to that user; `u:email:...`, `u:name:...` and `u:all` are
  // install-wide indexes and belong to nobody. Getting this wrong would file an
  // index row under an owner called "name" and leave it behind when that
  // account was deleted.
  if (parts[0] === 'u' && !U_INDEXES.has(parts[1])) return parts[1] || null
  return null
}

function expiryFor(seconds?: number): Date | null {
  return seconds ? new Date(Date.now() + seconds * 1000) : null
}

/** `*` is the only wildcard callers use; everything else is a literal. */
function likePattern(pattern: string): string {
  return pattern.replace(/([%_\\])/g, '\\$1').replace(/\*/g, '%')
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Resolve Redis-style indices, where a negative counts back from the end. */
function slice<T>(list: T[], start: number, stop: number): T[] {
  const from = start < 0 ? Math.max(0, list.length + start) : start
  const to = stop < 0 ? list.length + stop + 1 : stop + 1
  return list.slice(from, Math.max(from, to))
}

export function sqlKV(): KV {
  const sql = db()

  /**
   * Read-modify-write under a per-key lock.
   *
   * Lists, sets, hashes and sorted sets are held as one JSON value, so a
   * concurrent append and trim would otherwise be a lost update. Expressing
   * each operation as clever jsonb SQL would avoid the round trip, but these
   * are cold paths - an oplog append, a chat index - and a lock that is
   * obviously correct beats an expression that needs a proof.
   */
  async function edit<T>(key: string, fn: (current: unknown) => { value: unknown; result: T }): Promise<T> {
    await ready()
    return sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${key}))`
      const rows = await tx<Array<{ v: unknown; expires_at: Date | null }>>`
        select v, expires_at from hk_kv where k = ${key}`
      const row = rows[0]
      const live = row && (!row.expires_at || row.expires_at.getTime() > Date.now())
      const { value, result } = fn(live ? row.v : null)
      await tx`
        insert into hk_kv (k, owner, v, expires_at)
        values (${key}, ${ownerOf(key)}, ${tx.json(value as never)}, ${live ? row.expires_at : null})
        on conflict (k) do update set v = excluded.v, owner = excluded.owner, expires_at = excluded.expires_at`
      return result
    }) as Promise<T>
  }

  async function read(key: string): Promise<unknown> {
    await ready()
    const rows = await sql<Array<{ v: unknown }>>`
      select v from hk_kv where k = ${key} and (expires_at is null or expires_at > now())`
    return rows.length ? rows[0].v : null
  }

  return {
    durable: true,

    async get<T>(key: string) {
      return ((await read(key)) as T) ?? null
    },

    async set(key, value, opts) {
      await ready()
      const payload = value === undefined ? null : value
      const expires = expiryFor(opts?.ex)
      if (opts?.nx) {
        // Claim the key only if it is absent, or present but already expired -
        // an expired row is not a holder, and treating it as one would wedge
        // every lock behind a lease whose owner died.
        const rows = await sql`
          insert into hk_kv (k, owner, v, expires_at)
          values (${key}, ${ownerOf(key)}, ${sql.json(payload as never)}, ${expires})
          on conflict (k) do update
            set v = excluded.v, owner = excluded.owner, expires_at = excluded.expires_at
            where hk_kv.expires_at is not null and hk_kv.expires_at <= now()
          returning k`
        return rows.length > 0
      }
      await sql`
        insert into hk_kv (k, owner, v, expires_at)
        values (${key}, ${ownerOf(key)}, ${sql.json(payload as never)}, ${expires})
        on conflict (k) do update set v = excluded.v, owner = excluded.owner, expires_at = excluded.expires_at`
      return true
    },

    async del(...keys) {
      if (keys.length === 0) return 0
      await ready()
      const rows = await sql`delete from hk_kv where k = any(${keys}) returning k`
      return rows.length
    },

    async compareDel(key, expected) {
      await ready()
      const rows = await sql`
        delete from hk_kv where k = ${key} and v = ${sql.json(expected as never)} returning k`
      return rows.length > 0
    },

    async incr(key) {
      await ready()
      const rows = await sql<Array<{ v: number }>>`
        insert into hk_kv (k, owner, v) values (${key}, ${ownerOf(key)}, to_jsonb(1))
        on conflict (k) do update set
          v = to_jsonb(
                (case when hk_kv.expires_at is not null and hk_kv.expires_at <= now() then 0
                      when jsonb_typeof(hk_kv.v) = 'number' then (hk_kv.v)::text::numeric
                      else 0 end) + 1),
          expires_at = case when hk_kv.expires_at is not null and hk_kv.expires_at <= now()
                            then null else hk_kv.expires_at end
        returning v`
      return Number(rows[0].v)
    },

    async expire(key, seconds) {
      await ready()
      await sql`update hk_kv set expires_at = now() + make_interval(secs => ${seconds}) where k = ${key}`
    },

    async lpush(key, ...values) {
      return edit<number>(key, (current) => {
        const next = [...values, ...asArray(current)]
        return { value: next, result: next.length }
      })
    },

    async lrange<T>(key: string, start: number, stop: number) {
      return slice(asArray(await read(key)), start, stop) as T[]
    },

    async ltrim(key, start, stop) {
      await edit(key, (current) => ({ value: slice(asArray(current), start, stop), result: undefined }))
    },

    async sadd(key, ...members) {
      return edit<number>(key, (current) => {
        const set = new Set(asArray(current) as string[])
        const before = set.size
        for (const m of members) set.add(m)
        return { value: [...set], result: set.size - before }
      })
    },

    async srem(key, ...members) {
      return edit<number>(key, (current) => {
        const set = new Set(asArray(current) as string[])
        const before = set.size
        for (const m of members) set.delete(m)
        return { value: [...set], result: before - set.size }
      })
    },

    async smembers(key) {
      return asArray(await read(key)) as string[]
    },

    async hset(key, field, value) {
      await edit(key, (current) => ({ value: { ...asObject(current), [field]: value }, result: undefined }))
    },

    async hget<T>(key: string, field: string) {
      return (asObject(await read(key))[field] as T) ?? null
    },

    async hgetall<T>(key: string) {
      return asObject(await read(key)) as Record<string, T>
    },

    async hdel(key, ...fields) {
      await edit(key, (current) => {
        const next = { ...asObject(current) }
        for (const f of fields) delete next[f]
        return { value: next, result: undefined }
      })
    },

    async zadd(key, score, member) {
      await edit(key, (current) => {
        const rows = (asArray(current) as Array<[number, string]>).filter(([, m]) => m !== member)
        rows.push([score, member])
        rows.sort((a, b) => a[0] - b[0])
        return { value: rows, result: undefined }
      })
    },

    async zrange<T = string>(key: string, start: number, stop: number, rev?: boolean) {
      let rows = asArray(await read(key)) as Array<[number, string]>
      if (rev) rows = [...rows].reverse()
      return slice(rows, start, stop).map(([, m]) => m) as T[]
    },

    async zrem(key, ...members) {
      await edit(key, (current) => ({
        value: (asArray(current) as Array<[number, string]>).filter(([, m]) => !members.includes(m)),
        result: undefined,
      }))
    },

    async keys(pattern) {
      await ready()
      const rows = await sql<Array<{ k: string }>>`
        select k from hk_kv
        where k like ${likePattern(pattern)} escape '\\'
          and (expires_at is null or expires_at > now())`
      return rows.map((r) => r.k)
    },
  }
}

// ------------------------------------------------------------- attachments

export type StoredBlob = { bytes: Buffer; mime: string; name: string }

export const blobs = {
  async put(owner: string, file: { id: string; name: string; mime: string; bytes: Buffer }): Promise<void> {
    await ready()
    await db()`
      insert into hk_attachments (owner, id, name, mime, size, bytes)
      values (${owner}, ${file.id}, ${file.name}, ${file.mime}, ${file.bytes.length}, ${file.bytes})
      on conflict (owner, id) do update
        set name = excluded.name, mime = excluded.mime, size = excluded.size, bytes = excluded.bytes`
  },

  async get(owner: string, id: string): Promise<StoredBlob | null> {
    await ready()
    const rows = await db()<Array<{ name: string; mime: string; bytes: Buffer }>>`
      select name, mime, bytes from hk_attachments where owner = ${owner} and id = ${id}`
    if (!rows.length) return null
    return { bytes: Buffer.from(rows[0].bytes), mime: rows[0].mime, name: rows[0].name }
  },

  async del(owner: string, id: string): Promise<void> {
    await ready()
    await db()`delete from hk_attachments where owner = ${owner} and id = ${id}`
  },

  async usage(owner: string): Promise<{ count: number; bytes: number }> {
    await ready()
    const rows = await db()<Array<{ count: string; bytes: string | null }>>`
      select count(*)::text as count, coalesce(sum(size), 0)::text as bytes
      from hk_attachments where owner = ${owner}`
    return { count: Number(rows[0].count), bytes: Number(rows[0].bytes ?? 0) }
  },
}

// ------------------------------------------------------------------- admin

/** Liveness for the health probe, and the first thing to check on a bad deploy. */
export async function ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    await ready()
    await db()`select 1`
    return { ok: true, latencyMs: Date.now() - started }
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: (err as Error).message }
  }
}

/** Everything one account occupies, which is what a storage readout should show. */
export async function accountFootprint(owner: string): Promise<{ keys: number; jsonBytes: number; blobBytes: number; blobCount: number }> {
  await ready()
  const sql = db()
  const [kvRow] = await sql<Array<{ keys: string; bytes: string }>>`
    select count(*)::text as keys, coalesce(sum(pg_column_size(v)), 0)::text as bytes
    from hk_kv where owner = ${owner}`
  const blob = await blobs.usage(owner)
  return { keys: Number(kvRow.keys), jsonBytes: Number(kvRow.bytes), blobBytes: blob.bytes, blobCount: blob.count }
}

/**
 * Keys under one owner whose stored JSON mentions every term.
 *
 * The narrowing runs in the database rather than in this process, which is the
 * whole reason it is worth having: a deep search otherwise means pulling every
 * document across the wire to look at it, and the documents are the largest
 * thing an account owns. What comes back is a candidate list - `v::text` sees
 * ids and column names too, so a match here is a reason to open the document,
 * not an answer - and the real scoring is done on what it finds.
 *
 * `ilike all(...)` requires every term, matching the ranking's rule that a
 * result has to satisfy the whole query rather than any part of it.
 */
export async function searchOwnerKeys(owner: string, prefix: string, terms: string[], limit = 40): Promise<string[]> {
  if (terms.length === 0) return []
  await ready()
  const patterns = terms.map((t) => `%${t.replace(/([%_\\])/g, '\\$1')}%`)
  const rows = await db()<Array<{ k: string }>>`
    select k from hk_kv
    where owner = ${owner}
      and k like ${likePattern(prefix)} escape '\\'
      and (expires_at is null or expires_at > now())
      and v::text ilike all(${patterns})
    limit ${limit}`
  return rows.map((r) => r.k)
}

/** Erase an account. Both tables carry the owner, so nothing is left orphaned. */
export async function purgeAccount(owner: string): Promise<{ keys: number; blobs: number }> {
  await ready()
  const sql = db()
  const keys = await sql`delete from hk_kv where owner = ${owner} returning k`
  const gone = await sql`delete from hk_attachments where owner = ${owner} returning id`
  return { keys: keys.length, blobs: gone.length }
}

/** Drop rows whose lease ran out. Cheap, and nothing depends on it being timely. */
export async function sweepExpired(): Promise<number> {
  await ready()
  const rows = await db()`delete from hk_kv where expires_at is not null and expires_at <= now() returning k`
  return rows.length
}
