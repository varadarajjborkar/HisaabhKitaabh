/**
 * End-to-end tests against a running server.
 *   npx next dev -p 3111   then   node tests/e2e.test.mjs
 *
 * These exercise the real HTTP surface with a real session cookie - the
 * concurrency guarantees especially, which only mean anything through the
 * actual write path.
 */
const BASE = process.env.BASE ?? 'http://localhost:3111'

let pass = 0, fail = 0
const failures = []
let cookie = ''

const log = (s = '') => console.log(s)
async function check(name, fn) {
  try { await fn(); pass++; log(`  ok   ${name}`) }
  catch (err) { fail++; failures.push(`${name}: ${err.message}`); log(`  FAIL ${name}\n       ${err.message}`) }
}
function eq(a, b, msg = '') {
  const x = JSON.stringify(a), y = JSON.stringify(b)
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`)
}
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy') }

async function req(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }), cookie, ...(init.headers ?? {}) },
  })
  const setCookie = res.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, body, res }
}
const post = (p, d) => req(p, { method: 'POST', body: JSON.stringify(d ?? {}) })
const get = (p) => req(p)
const del = (p, d) => req(p, { method: 'DELETE', ...(d ? { body: JSON.stringify(d) } : {}) })

const uid = () => Math.random().toString(36).slice(2, 12).toUpperCase()

// ---------------------------------------------------------------- auth

log('\nAuthentication')
await check('unauthenticated request is refused', async () => {
  const saved = cookie; cookie = ''
  const r = await get('/api/folders')
  eq(r.status, 401)
  cookie = saved
})
await check('wrong password is rejected', async () => {
  const r = await post('/api/auth/login', { identifier: 'varad', password: 'wrong' })
  eq(r.status, 500, 'should not authenticate:')
  cookie = ''
})
await check('developer login works', async () => {
  const r = await post('/api/auth/login', { identifier: 'varad', password: 'varad[123]' })
  eq(r.status, 200)
  eq(r.body.devLogin, true)
  eq(r.body.user.role, 'admin')
  ok(cookie.includes('hisaabhkitaabh_session'), 'no session cookie was set')
})
await check('session reads back', async () => {
  const r = await get('/api/auth/session')
  eq(r.body.user.name, 'varad')
  eq(r.body.ai, true, 'AI should be configured:')
})

/**
 * Everything below runs as a brand-new account.
 *
 * The seeding assertions describe a *pristine* account, and the shared dev
 * account accumulates whatever the other suites did to it - an earlier run
 * left the sample file edited and these assertions started failing on state
 * that had nothing to do with the code under test.
 */
const freshEmail = `e2e-${uid().toLowerCase()}@hisaab.test`
await check('sign up creates a working account', async () => {
  cookie = ''
  const r = await post('/api/auth/signup', { email: freshEmail, password: 'a-good-password', name: 'E2E' })
  eq(r.status, 200)
  eq(r.body.user.email, freshEmail)
  ok(cookie.includes('hisaabhkitaabh_session'), 'sign-up did not start a session')
})
await check('a duplicate sign-up is refused', async () => {
  const saved = cookie
  const r = await post('/api/auth/signup', { email: freshEmail, password: 'a-good-password' })
  ok(r.status >= 400, `a duplicate email was accepted (${r.status})`)
  cookie = saved
})
await check('a short password is refused', async () => {
  const saved = cookie
  const r = await post('/api/auth/signup', { email: `x-${uid().toLowerCase()}@hisaab.test`, password: 'short' })
  eq(r.status, 400)
  cookie = saved
})

// -------------------------------------------------------------- folders

log('\nFolders and the sample seed')
let sampleFolder, sampleFile
await check('a new account is seeded with a sample folder', async () => {
  const r = await get('/api/folders')
  eq(r.status, 200)
  ok(r.body.folders.length >= 1, 'no folders were seeded')
  sampleFolder = r.body.folders.find((f) => f.sample)
  ok(sampleFolder, 'the sample folder is not flagged as a sample')
})
await check('the sample folder contains readable files', async () => {
  const r = await get(`/api/folders/${sampleFolder.id}`)
  ok(r.body.files.length >= 2, `expected 2+ sample files, got ${r.body.files.length}`)
  sampleFile = r.body.files.find((f) => f.name === 'Trip expenses')
  ok(sampleFile, `no "Trip expenses" file; got ${r.body.files.map((f) => f.name).join(', ')}`)
  ok(r.body.files.some((f) => f.name === 'Souvenirs'), 'the second sample file is missing')
})
await check('sample data has real totals in both files', async () => {
  const trip = await get(`/api/files/${sampleFile.id}`)
  eq(trip.body.totals.total, 10535, 'trip total:')
  eq(trip.body.totals.count, 7)
  ok(trip.body.doc.duration.enabled, 'the sample period should be switched on')
  eq(trip.body.doc.columns.length, 6, 'the sample should demonstrate custom columns:')

  const list = await get(`/api/folders/${sampleFolder.id}`)
  const souvenirs = list.body.files.find((f) => f.name === 'Souvenirs')
  const s = await get(`/api/files/${souvenirs.id}`)
  eq(s.body.totals.total, 2050, 'souvenirs total:')
})

let folderId
await check('create a folder', async () => {
  const r = await post('/api/folders', { name: 'E2E tests', icon: '🧪', id: uid() })
  eq(r.status, 201)
  folderId = r.body.folder.id
})
await check('creating a folder twice with the same id is idempotent', async () => {
  const id = uid()
  await post('/api/folders', { name: 'Dupe check', id })
  await post('/api/folders', { name: 'Dupe check', id })
  const r = await get('/api/folders')
  eq(r.body.folders.filter((f) => f.id === id).length, 1, 'retry created two folders:')
})

// ---------------------------------------------------------------- files

log('\nFiles and mutations')
let fileId, doc
await check('create a file with the three default columns', async () => {
  const r = await post('/api/files', { folderId, name: 'Concurrency drills', id: uid() })
  eq(r.status, 201)
  fileId = r.body.doc.id
  doc = r.body.doc
  eq(doc.columns.map((c) => c.name), ['INR', 'Title', 'Extra Captions'])
  eq(doc.rev, 0)
})

const A = 'c_amount', T = 'c_title'
let rev = 0
async function mutate(ops, extra = {}) {
  const r = await post(`/api/files/${fileId}/mutate`, { baseRev: rev, ops, ...extra })
  if (r.status === 200) { rev = r.body.doc.rev; doc = r.body.doc }
  return r
}

await check('add rows and see the total', async () => {
  const r = await mutate([
    { id: uid(), type: 'row.insert', rowId: 'ROW1', order: 'a0', cells: { [A]: 450, [T]: 'Cab' } },
    { id: uid(), type: 'row.insert', rowId: 'ROW2', order: 'a1', cells: { [A]: 1200, [T]: 'Hotel' } },
  ])
  eq(r.status, 200)
  eq(r.body.totals.total, 1650)
  eq(r.body.totals.count, 2)
})

await check('amount strings are coerced, not stored raw', async () => {
  const r = await mutate([{ id: uid(), type: 'cell.set', rowId: 'ROW1', columnId: A, value: '1.2k' }])
  eq(r.body.totals.total, 2400, '1.2k should become 1200:')
})

await check('a replayed request does not double-apply', async () => {
  const requestId = 'REPLAY-' + uid()
  const ops = [{ id: uid(), type: 'row.insert', rowId: 'ROW3', order: 'a2', cells: { [A]: 100 } }]
  const first = await post(`/api/files/${fileId}/mutate`, { baseRev: rev, ops, requestId })
  const second = await post(`/api/files/${fileId}/mutate`, { baseRev: rev, ops, requestId })
  eq(second.body.replayed, true, 'the retry was not recognised as a replay:')
  eq(first.body.totals.total, second.body.totals.total, 'replay changed the total:')
  rev = first.body.doc.rev
  const check2 = await get(`/api/files/${fileId}`)
  eq(check2.body.totals.count, 3, 'the retried insert created a duplicate row:')
  rev = check2.body.doc.rev
})

await check('the same op id sent twice is dropped', async () => {
  const opId = 'FIXED-' + uid()
  const op = { id: opId, type: 'row.insert', rowId: 'ROW4', order: 'a3', cells: { [A]: 50 } }
  await mutate([op])
  const again = await post(`/api/files/${fileId}/mutate`, { baseRev: rev, ops: [op] })
  eq(again.body.duplicates, [opId], 'duplicate op was not detected:')
  const after = await get(`/api/files/${fileId}`)
  eq(after.body.totals.count, 4)
  rev = after.body.doc.rev
})

// ---------------------------------------------------------- concurrency

log('\nConcurrency - the guarantee that matters')
await check('two writers on DIFFERENT cells both survive', async () => {
  const staleRev = rev
  const w1 = await post(`/api/files/${fileId}/mutate`, {
    baseRev: staleRev, ops: [{ id: uid(), type: 'cell.set', rowId: 'ROW1', columnId: T, value: 'Writer one' }],
  })
  eq(w1.status, 200)
  const w2 = await post(`/api/files/${fileId}/mutate`, {
    baseRev: staleRev, ops: [{ id: uid(), type: 'cell.set', rowId: 'ROW2', columnId: T, value: 'Writer two' }],
  })
  eq(w2.status, 200, 'the second writer was rejected despite touching a different cell:')

  const final = await get(`/api/files/${fileId}`)
  const rows = final.body.doc.rows
  eq(rows.find((r) => r.id === 'ROW1').cells[T], 'Writer one', 'writer one was lost:')
  eq(rows.find((r) => r.id === 'ROW2').cells[T], 'Writer two', 'writer two was lost:')
  rev = final.body.doc.rev
})

await check('two writers on the SAME cell: the second is refused, not silently lost', async () => {
  const staleRev = rev
  const w1 = await post(`/api/files/${fileId}/mutate`, {
    baseRev: staleRev, ops: [{ id: uid(), type: 'cell.set', rowId: 'ROW1', columnId: A, value: 111 }],
  })
  eq(w1.status, 200)
  const w2 = await post(`/api/files/${fileId}/mutate`, {
    baseRev: staleRev, ops: [{ id: uid(), type: 'cell.set', rowId: 'ROW1', columnId: A, value: 222 }],
  })
  eq(w2.status, 409, 'an overlapping write was accepted instead of conflicting:')
  eq(w2.body.code, 'conflict')
  ok(w2.body.current, 'the conflict response did not include the current document')

  const final = await get(`/api/files/${fileId}`)
  eq(final.body.doc.rows.find((r) => r.id === 'ROW1').cells[A], 111, 'the first write did not survive:')
  rev = final.body.doc.rev
})

await check('20 parallel writers all land, none lost', async () => {
  const before = (await get(`/api/files/${fileId}`)).body
  let r = before.doc.rev
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      post(`/api/files/${fileId}/mutate`, {
        baseRev: r,
        ops: [{ id: uid(), type: 'row.insert', rowId: `PAR${i}`, order: `b${i.toString(36)}`, cells: { [A]: 10 } }],
      }),
    ),
  )
  const accepted = results.filter((x) => x.status === 200).length
  eq(accepted, 20, 'some parallel inserts were rejected:')
  const after = await get(`/api/files/${fileId}`)
  eq(after.body.totals.count, before.totals.count + 20, 'rows were lost under parallel writes:')
  eq(after.body.totals.total, before.totals.total + 200, 'the total is wrong after parallel writes:')
  rev = after.body.doc.rev
})

await check('a client ahead of the server is refused', async () => {
  const r = await post(`/api/files/${fileId}/mutate`, {
    baseRev: rev + 500, ops: [{ id: uid(), type: 'cell.set', rowId: 'ROW1', columnId: T, value: 'nope' }],
  })
  eq(r.status, 409)
})

// ------------------------------------------------------------- guards

log('\nValidation and limits')
await check('a built-in column cannot be deleted', async () => {
  const r = await mutate([{ id: uid(), type: 'column.delete', columnId: A }])
  eq(r.body.rejected.length, 1)
  ok(String(r.body.rejected[0].reason).includes('system'), `unexpected reason: ${r.body.rejected[0].reason}`)
})
await check('a malformed operation is rejected by schema', async () => {
  const r = await post(`/api/files/${fileId}/mutate`, { baseRev: rev, ops: [{ id: uid(), type: 'nonsense' }] })
  eq(r.status, 400)
})
await check('an oversized batch is refused', async () => {
  const ops = Array.from({ length: 501 }, (_, i) => ({ id: uid(), type: 'row.insert', rowId: `X${i}`, order: `c${i}` }))
  const r = await post(`/api/files/${fileId}/mutate`, { baseRev: rev, ops })
  eq(r.status, 400)
})
await check('conditional GET returns 304 when nothing changed', async () => {
  const first = await get(`/api/files/${fileId}`)
  const etag = first.res.headers.get('etag')
  ok(etag, 'no ETag was sent')
  const second = await req(`/api/files/${fileId}`, { headers: { 'if-none-match': etag } })
  eq(second.status, 304, 'the server re-sent an unchanged document:')
})

// -------------------------------------------------------- attachments

log('\nAttachments')
await check('a video file is refused', async () => {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([0, 1, 2, 3])], 'holiday.mp4', { type: 'video/mp4' }))
  const r = await req(`/api/files/${fileId}/attachments`, { method: 'POST', body: form })
  eq(r.status, 415)
  ok(/video/i.test(r.body.message), `unhelpful message: ${r.body.message}`)
})
await check('a video renamed to .txt is still refused by MIME', async () => {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([0, 1])], 'sneaky.txt', { type: 'video/mp4' }))
  const r = await req(`/api/files/${fileId}/attachments`, { method: 'POST', body: form })
  eq(r.status, 415, 'a video slipped through on a renamed extension:')
})
await check('a CSV is accepted and readable back', async () => {
  const form = new FormData()
  form.append('file', new File(['item,amount\nChai,60\n'], 'receipt.csv', { type: 'text/csv' }))
  const r = await req(`/api/files/${fileId}/attachments`, { method: 'POST', body: form })
  eq(r.status, 201)
  ok(r.body.attachment.id, 'no attachment id returned')
  const ref = Buffer.from(JSON.stringify(r.body.attachment)).toString('base64url')
  const back = await fetch(`${BASE}/api/files/${fileId}/attachments?ref=${ref}`, { headers: { cookie } })
  eq(back.status, 200)
  eq(await back.text(), 'item,amount\nChai,60\n', 'the attachment came back altered:')
})

// ------------------------------------------------- storage backends

/**
 * Storage is the account's choice, not a consequence of the sign-in button.
 * These check the half that can be exercised without a Google account: that
 * everybody starts with a working home, that the app says so, and that asking
 * for Drive on a deployment with no Google credentials fails cleanly instead
 * of stranding the account between two backends.
 */
log('\nStorage')
const health = (await get('/api/health')).body
await check('a password account gets app storage by default', async () => {
  const r = await get('/api/settings/storage')
  eq(r.status, 200)
  eq(r.body.backend, 'app', 'a new account did not land in app storage:')
  // Durability is a property of the deployment, not of the account. Asserting
  // it unconditionally would just fail on a machine with no database, which is
  // the configuration someone cloning this repo starts in.
  if (health.database === 'ok') ok(r.body.storage.durable, 'a database-backed store reported itself as not durable')
})
await check('the storage readout says what the account is using', async () => {
  const r = await get('/api/settings/storage')
  if (health.database !== 'ok') return
  ok(typeof r.body.storage.used === 'number', 'no usage figure was reported')
  ok(r.body.storage.used > 0, 'an account with files reported zero usage')
})
await check('switching to the backend already in use is a no-op', async () => {
  const r = await post('/api/settings/storage', { backend: 'app' })
  eq(r.status, 200)
  eq(r.body.moved, null, 'a pointless migration ran anyway:')
})
await check('drive is refused cleanly when google is not configured', async () => {
  const r = await post('/api/settings/storage', { backend: 'drive' })
  // Either answer is correct and both leave the account where it was: refused
  // outright, or told to go and get consent first.
  ok(r.status === 400 || r.body.needsAuth, `expected a refusal or a consent redirect, got ${r.status}`)
  const after = await get('/api/settings/storage')
  eq(after.body.backend, 'app', 'a failed switch moved the account anyway:')
})
await check('an unknown backend is rejected', async () => {
  const r = await post('/api/settings/storage', { backend: 'dropbox' })
  eq(r.status, 400)
})
await check('deleting a file that is not yours is a 404, not a fake success', async () => {
  // Regression for a security probe: DELETE returned 200 for a file the caller
  // did not own. No data ever crossed accounts - keys are scoped by user id -
  // but claiming to have deleted a file you never had is dishonest and hides
  // the missing ownership check. It must 404 like GET does.
  const other = `idor-${uid().toLowerCase()}@hisaab.test`
  const savedCookie = cookie
  cookie = ''
  await post('/api/auth/signup', { email: other, password: 'a-good-password' })
  const f = await post('/api/folders', { name: 'theirs' })
  const file = await post('/api/files', { folderId: f.body.folder.id, name: 'theirs' })
  const victimFileId = file.body.doc.id
  const victimFolderId = f.body.folder.id

  cookie = savedCookie // back to the original account
  const delFile = await del(`/api/files/${victimFileId}`)
  eq(delFile.status, 404, "deleting another account's file did not 404:")
  const delFolder = await del(`/api/folders/${victimFolderId}`)
  eq(delFolder.status, 404, "deleting another account's folder did not 404:")

  // And the victim's file is still there.
  const stealCookie = cookie
  cookie = ''
  await post('/api/auth/login', { identifier: other, password: 'a-good-password' })
  const still = await get(`/api/files/${victimFileId}`)
  eq(still.status, 200, 'the file was actually removed across accounts:')
  cookie = stealCookie
})

await check('deleting your own file still works', async () => {
  const f = await post('/api/files', { folderId, name: 'to be removed' })
  const r = await del(`/api/files/${f.body.doc.id}`)
  eq(r.status, 200, 'a legitimate delete was refused:')
  const gone = await get(`/api/files/${f.body.doc.id}`)
  eq(gone.status, 404, 'the file survived its own deletion:')
})

await check('the account still reads normally after all that', async () => {
  const r = await get(`/api/files/${fileId}`)
  eq(r.status, 200)
  ok(r.body.doc.rows.length > 0, 'the file lost its rows')
})

// --------------------------------------------------------- analytics

log('\nAnalytics')
await check('analytics aggregates across files', async () => {
  const r = await get('/api/analytics')
  eq(r.status, 200)
  ok(r.body.summary.total > 0, 'analytics reported a zero total')
  ok(Array.isArray(r.body.timeline), 'no timeline returned')
  ok(Array.isArray(r.body.perFile), 'no per-file breakdown returned')
})
await check('analytics can be scoped to one folder', async () => {
  const r = await get(`/api/analytics?folderId=${folderId}`)
  ok(r.body.perFile.every((f) => f.folderId === folderId), 'a file from another folder leaked in')
})

log(`\n${pass} passed, ${fail} failed`)
if (fail) { log('\nFailures:'); failures.forEach((f) => log('  - ' + f)); process.exit(1) }
