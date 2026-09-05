/**
 * Postgres store tests.
 *
 * These run against a real database, because every interesting claim here is a
 * claim about Postgres: that SETNX is atomic enough to hold a lock, that two
 * writers appending to the same list do not lose each other's entry, that an
 * expired key is treated as absent rather than as a live value, and that a
 * receipt survives a round trip through `bytea` byte for byte.
 *
 * Point DATABASE_URL at a throwaway database and run:
 *   DATABASE_URL=postgres://localhost/hisaabhkitaabh \
 *     node --experimental-strip-types --import ./tests/resolve-hook-register.mjs tests/db.test.mjs
 *
 * Without DATABASE_URL the suite skips rather than fails - nothing else in the
 * project needs a database to be installed.
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register('./resolve-hook.mjs', pathToFileURL('./tests/'))

if (!process.env.DATABASE_URL) {
  console.log('\n  skipped: set DATABASE_URL to run the Postgres suite\n')
  process.exit(0)
}

const { sqlKV, blobs, accountFootprint, purgeAccount, sweepExpired, ownerOf, db } = await import('@/lib/db/sql.ts')
const { acquireLock } = await import('@/lib/store/locks.ts')

let pass = 0, fail = 0
const failures = []

async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`) }
  catch (err) { fail++; failures.push(`${name}: ${err.message}`); console.log(`  FAIL ${name}\n       ${err.message}`) }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`)
}
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy') }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const kv = sqlKV()
const USER = 'TESTUSER' + Math.random().toString(36).slice(2, 8).toUpperCase()
const k = (suffix) => `d:${USER}:${suffix}`

console.log('\nPostgres store\n')

await check('a value written comes back as the same value', async () => {
  await kv.set(k('doc:1'), { name: 'Trip', rows: [1, 2, 3] })
  eq(await kv.get(k('doc:1')), { name: 'Trip', rows: [1, 2, 3] })
})

await check('a key that was never written reads as null', async () => {
  eq(await kv.get(k('nothing')), null)
})

await check('a write replaces rather than merges', async () => {
  await kv.set(k('doc:2'), { a: 1, b: 2 })
  await kv.set(k('doc:2'), { a: 9 })
  eq(await kv.get(k('doc:2')), { a: 9 })
})

await check('delete removes the key and reports how many went', async () => {
  await kv.set(k('gone:1'), 1)
  await kv.set(k('gone:2'), 2)
  eq(await kv.del(k('gone:1'), k('gone:2'), k('gone:never')), 2)
  eq(await kv.get(k('gone:1')), null)
})

await check('an expired key reads as absent', async () => {
  await kv.set(k('brief'), 'here', { ex: 1 })
  eq(await kv.get(k('brief')), 'here')
  await sleep(1100)
  eq(await kv.get(k('brief')), null)
})

await check('setnx refuses a key that is already held', async () => {
  await kv.del(k('claim'))
  eq(await kv.set(k('claim'), 'first', { nx: true }), true)
  eq(await kv.set(k('claim'), 'second', { nx: true }), false)
  eq(await kv.get(k('claim')), 'first')
})

await check('setnx succeeds once the previous holder has expired', async () => {
  await kv.del(k('lease'))
  eq(await kv.set(k('lease'), 'A', { nx: true, ex: 1 }), true)
  eq(await kv.set(k('lease'), 'B', { nx: true, ex: 60 }), false)
  await sleep(1100)
  eq(await kv.set(k('lease'), 'C', { nx: true, ex: 60 }), true, 'an expired lease still blocked a new holder:')
  eq(await kv.get(k('lease')), 'C')
})

await check('exactly one of twenty racing writers takes the key', async () => {
  await kv.del(k('race'))
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => kv.set(k('race'), `writer-${i}`, { nx: true, ex: 30 })),
  )
  eq(results.filter(Boolean).length, 1, 'more than one writer believed it had the key:')
})

await check('compareDel only deletes when the value still matches', async () => {
  await kv.set(k('token'), 'mine')
  eq(await kv.compareDel(k('token'), 'someone-else'), false)
  eq(await kv.get(k('token')), 'mine')
  eq(await kv.compareDel(k('token'), 'mine'), true)
  eq(await kv.get(k('token')), null)
})

await check('a lock is held by one holder at a time', async () => {
  const scope = `test:${USER}`
  const first = await acquireLock(scope, { ttlMs: 5000, waitMs: 50 })
  ok(first, 'the first caller did not get the lock')
  const second = await acquireLock(scope, { ttlMs: 5000, waitMs: 100 })
  eq(second, null, 'a second caller got a lock that was already held:')
  await first.release()
  const third = await acquireLock(scope, { ttlMs: 5000, waitMs: 500 })
  ok(third, 'the lock was not released')
  await third.release()
})

await check('incr counts up from nothing', async () => {
  await kv.del(k('n'))
  eq(await kv.incr(k('n')), 1)
  eq(await kv.incr(k('n')), 2)
  eq(await kv.incr(k('n')), 3)
})

await check('incr resets a counter whose window has expired', async () => {
  await kv.del(k('window'))
  await kv.incr(k('window'))
  await kv.expire(k('window'), 1)
  await sleep(1100)
  eq(await kv.incr(k('window')), 1, 'an expired counter carried its old value forward:')
})

await check('a list keeps newest first and trims to length', async () => {
  await kv.del(k('log'))
  await kv.lpush(k('log'), { rev: 1 })
  await kv.lpush(k('log'), { rev: 2 })
  await kv.lpush(k('log'), { rev: 3 })
  eq(await kv.lrange(k('log'), 0, -1), [{ rev: 3 }, { rev: 2 }, { rev: 1 }])
  await kv.ltrim(k('log'), 0, 1)
  eq(await kv.lrange(k('log'), 0, -1), [{ rev: 3 }, { rev: 2 }])
})

await check('lrange reads from the end with a negative index', async () => {
  await kv.del(k('slice'))
  await kv.lpush(k('slice'), 'c')
  await kv.lpush(k('slice'), 'b')
  await kv.lpush(k('slice'), 'a')
  eq(await kv.lrange(k('slice'), 0, 1), ['a', 'b'])
  eq(await kv.lrange(k('slice'), -2, -1), ['b', 'c'])
})

await check('twenty concurrent appends all survive', async () => {
  // The whole list is one row, so an unguarded read-modify-write here loses
  // entries. This is the test that says the per-key lock actually works.
  await kv.del(k('busy'))
  await Promise.all(Array.from({ length: 20 }, (_, i) => kv.lpush(k('busy'), i)))
  const list = await kv.lrange(k('busy'), 0, -1)
  eq(list.length, 20, 'appends were lost:')
  eq([...list].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i))
})

await check('a set holds each member once', async () => {
  await kv.del(k('tools'))
  eq(await kv.sadd(k('tools'), 'add_row', 'set_cell'), 2)
  eq(await kv.sadd(k('tools'), 'add_row'), 0)
  eq((await kv.smembers(k('tools'))).sort(), ['add_row', 'set_cell'])
  eq(await kv.srem(k('tools'), 'add_row'), 1)
  eq(await kv.smembers(k('tools')), ['set_cell'])
})

await check('a hash sets, reads and deletes one field at a time', async () => {
  await kv.del(k('titles'))
  await kv.hset(k('titles'), 't1', 'Goa trip')
  await kv.hset(k('titles'), 't2', 'Rent')
  eq(await kv.hget(k('titles'), 't1'), 'Goa trip')
  eq(await kv.hgetall(k('titles')), { t1: 'Goa trip', t2: 'Rent' })
  await kv.hdel(k('titles'), 't1')
  eq(await kv.hgetall(k('titles')), { t2: 'Rent' })
})

await check('a sorted set orders by score and reverses on request', async () => {
  await kv.del(k('threads'))
  await kv.zadd(k('threads'), 100, 'old')
  await kv.zadd(k('threads'), 300, 'new')
  await kv.zadd(k('threads'), 200, 'mid')
  eq(await kv.zrange(k('threads'), 0, -1), ['old', 'mid', 'new'])
  eq(await kv.zrange(k('threads'), 0, 1, true), ['new', 'mid'])
  await kv.zrem(k('threads'), 'mid')
  eq(await kv.zrange(k('threads'), 0, -1), ['old', 'new'])
})

await check('re-scoring a member moves it rather than duplicating it', async () => {
  await kv.del(k('scores'))
  await kv.zadd(k('scores'), 1, 'a')
  await kv.zadd(k('scores'), 9, 'a')
  eq(await kv.zrange(k('scores'), 0, -1), ['a'])
})

await check('a key pattern matches only its own account', async () => {
  const other = 'OTHER' + USER
  await kv.set(`c:${USER}:doc:x`, 1)
  await kv.set(`c:${USER}:doc:y`, 1)
  await kv.set(`c:${other}:doc:z`, 1)
  const found = await kv.keys(`c:${USER}:doc:*`)
  eq(found.sort(), [`c:${USER}:doc:x`, `c:${USER}:doc:y`])
  await kv.del(`c:${other}:doc:z`)
})

await check('a wildcard in the literal part is not treated as a wildcard', async () => {
  await kv.set(`c:${USER}:doc:a_b`, 1)
  await kv.set(`c:${USER}:doc:axb`, 1)
  eq(await kv.keys(`c:${USER}:doc:a_b`), [`c:${USER}:doc:a_b`])
})

await check('every key is attributed to the account that owns it', async () => {
  eq(ownerOf(`d:${USER}:folders`), USER)
  eq(ownerOf(`chat:${USER}:thread1`), USER)
  eq(ownerOf(`u:${USER}`), USER)
  eq(ownerOf('u:email:someone@example.com'), null)
  eq(ownerOf('u:all'), null)
  const [row] = await db()`select owner from hk_kv where k = ${k('doc:1')}`
  eq(row.owner, USER, 'the row was stored without an owner:')
})

await check('a receipt survives the round trip byte for byte', async () => {
  // Real bytes, not text: a PNG header with a null and a high byte in it, the
  // shape of thing that base64 handling or an encoding guess would corrupt.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f])
  await blobs.put(USER, { id: 'att1', name: 'receipt.png', mime: 'image/png', bytes })
  const back = await blobs.get(USER, 'att1')
  eq(back.name, 'receipt.png')
  eq(back.mime, 'image/png')
  ok(Buffer.compare(back.bytes, bytes) === 0, 'the bytes came back different')
})

await check('a missing attachment reads as null rather than throwing', async () => {
  eq(await blobs.get(USER, 'no-such-id'), null)
})

await check('re-uploading the same id replaces it', async () => {
  await blobs.put(USER, { id: 'att1', name: 'better.png', mime: 'image/png', bytes: Buffer.from([1, 2, 3]) })
  const back = await blobs.get(USER, 'att1')
  eq(back.name, 'better.png')
  eq([...back.bytes], [1, 2, 3])
  eq((await blobs.usage(USER)).count, 1, 'the replaced attachment was counted twice:')
})

await check('usage adds up what an account is holding', async () => {
  await blobs.put(USER, { id: 'att2', name: 'b.png', mime: 'image/png', bytes: Buffer.alloc(500) })
  const used = await blobs.usage(USER)
  eq(used.count, 2)
  eq(used.bytes, 503)
})

await check('a footprint covers both the rows and the files', async () => {
  const f = await accountFootprint(USER)
  ok(f.keys > 5, `expected several keys, got ${f.keys}`)
  ok(f.jsonBytes > 0, 'json bytes were not counted')
  eq(f.blobCount, 2)
  eq(f.blobBytes, 503)
})

await check('one account cannot see another account through a footprint', async () => {
  const f = await accountFootprint('NOBODY' + USER)
  eq(f, { keys: 0, jsonBytes: 0, blobBytes: 0, blobCount: 0 })
})

await check('the sweeper drops leases that ran out', async () => {
  await kv.set(k('doomed'), 1, { ex: 1 })
  await sleep(1100)
  await sweepExpired()
  const [row] = await db()`select count(*)::int as n from hk_kv where k = ${k('doomed')}`
  eq(row.n, 0, 'an expired row was left behind:')
})

await check('purging an account leaves nothing of it behind', async () => {
  const gone = await purgeAccount(USER)
  ok(gone.keys > 0, 'nothing was deleted')
  eq(gone.blobs, 2)
  eq(await accountFootprint(USER), { keys: 0, jsonBytes: 0, blobBytes: 0, blobCount: 0 })
  eq(await kv.get(k('doc:1')), null)
})

console.log(`\n  ${pass} passed, ${fail} failed\n`)
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`)
}
await db().end()
process.exit(fail ? 1 : 0)
