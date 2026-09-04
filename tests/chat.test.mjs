/**
 * Chatbot simulation against the live model and the live write path.
 *
 * These are slow and non-deterministic by nature — a model is in the loop. They
 * assert on *behaviour that must hold regardless of phrasing*: that reads run
 * freely, that writes stop at an approval, that denial changes nothing, that
 * approval changes exactly what the card said, and that a concurrent edit
 * during review turns into a conflict rather than an overwrite.
 */
const BASE = process.env.BASE ?? 'http://localhost:3111'

let pass = 0, fail = 0
const failures = []
let cookie = ''

const log = (s = '') => console.log(s)
async function check(name, fn) {
  const t = Date.now()
  try { await fn(); pass++; log(`  ok   ${name}  (${((Date.now() - t) / 1000).toFixed(1)}s)`) }
  catch (err) { fail++; failures.push(`${name}: ${err.message}`); log(`  FAIL ${name}  (${((Date.now() - t) / 1000).toFixed(1)}s)\n       ${err.message}`) }
}
function eq(a, b, m = '') { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`) }
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy') }

async function req(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } })
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]
  const text = await res.text()
  let body = {}; try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, body }
}
const post = (p, d) => req(p, { method: 'POST', body: JSON.stringify(d ?? {}) })
const get = (p) => req(p)
const uid = () => Math.random().toString(36).slice(2, 12).toUpperCase()

/** Drive one SSE stream to completion, collecting every event. */
async function stream(path, payload) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const b = await res.json().catch(() => ({}))
    throw new Error(`${path} -> ${res.status}: ${b.message ?? ''}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (line) { try { events.push(JSON.parse(line.slice(6))) } catch { /* keepalive */ } }
    }
  }
  return events
}

const text = (events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('')
const of = (events, type) => events.filter((e) => e.type === type)
const summarise = (events) => events.map((e) => e.type === 'tool_start' ? `tool:${e.name}` : e.type).join(' → ')

// ------------------------------------------------------------------ setup

const login = await post('/api/auth/login', { identifier: 'varad', password: 'varad[123]' })
if (login.status !== 200) {
  log(`SETUP FAILED: login returned ${login.status} — ${login.body.message ?? ''}`)
  log('(If this says "too many failed attempts", wait five minutes or restart the server.)')
  process.exit(1)
}

const folderRes = await post('/api/folders', { name: 'Chat drills', icon: '🤖', id: uid() })
if (folderRes.status !== 201) {
  log(`SETUP FAILED: could not create a folder (${folderRes.status}) — ${folderRes.body.message ?? ''}`)
  process.exit(1)
}
const folderId = folderRes.body.folder.id

const fileRes = await post('/api/files', { folderId, name: 'Agent test sheet', id: uid() })
if (fileRes.status !== 201) {
  log(`SETUP FAILED: could not create a file (${fileRes.status}) — ${fileRes.body.message ?? ''}`)
  process.exit(1)
}
const fileId = fileRes.body.doc.id

const A = 'c_amount', T = 'c_title'
let rev = 0
async function seed(ops) {
  const r = await post(`/api/files/${fileId}/mutate`, { baseRev: rev, ops })
  if (r.status !== 200) throw new Error(`seed failed ${r.status}: ${r.body.message}`)
  rev = r.body.doc.rev
  return r.body
}
await seed([
  { id: uid(), type: 'row.insert', rowId: 'S1', order: 'a0', cells: { [A]: 4820, [T]: 'Train tickets' } },
  { id: uid(), type: 'row.insert', rowId: 'S2', order: 'a1', cells: { [A]: 640, [T]: 'Dinner at the pier' } },
  { id: uid(), type: 'row.insert', rowId: 'S3', order: 'a2', cells: { [A]: 95, [T]: 'Coffee' } },
])
const state = async () => (await get(`/api/files/${fileId}`)).body
log(`setup: file ${fileId}, total ${(await state()).totals.total}`)

const scope = { fileId, folderId }
let thread = 0
const newThread = () => `t_chat_${++thread}_${uid()}`

// -------------------------------------------------------------- read path

log('\nReading — should never need approval')
await check('answers a question about the total without asking permission', async () => {
  const ev = await stream('/api/chat', { threadId: newThread(), message: 'What is the total in this file?', ...scope })
  log(`       ${summarise(ev)}`)
  eq(of(ev, 'permission').length, 0, 'a read asked for approval:')
  const answer = text(ev)
  ok(answer.length > 0, 'the assistant said nothing')
  ok(/5,?555|5555/.test(answer.replace(/,/g, '')), `answer did not contain the total 5555: "${answer.slice(0, 300)}"`)
})

await check('uses a tool rather than guessing', async () => {
  const ev = await stream('/api/chat', { threadId: newThread(), message: 'Which row here is the most expensive?', ...scope })
  log(`       ${summarise(ev)}`)
  ok(of(ev, 'tool_start').length > 0, 'answered with no tool call at all')
  ok(/train/i.test(text(ev)), `did not identify the train ticket: "${text(ev).slice(0, 250)}"`)
})

// ------------------------------------------------------------- write gate

log('\nWriting — must stop at the gate')
let pendingRun, pendingAction
await check('an add request produces an approval card, and writes nothing yet', async () => {
  const before = await state()
  const ev = await stream('/api/chat', {
    threadId: newThread(), message: 'Add a row: 450 for a cab to the airport', ...scope,
  })
  log(`       ${summarise(ev)}`)
  const perms = of(ev, 'permission')
  eq(perms.length, 1, 'expected exactly one approval request:')
  pendingAction = perms[0].action
  pendingRun = ev.find((e) => e.type === 'run').runId

  ok(pendingAction.summary, 'the card has no summary')
  ok(pendingAction.preview.length > 0, 'the card previews nothing')
  eq(of(ev, 'applied').length, 0, 'something was applied before approval:')

  const after = await state()
  eq(after.totals.total, before.totals.total, 'the document changed before approval:')
  eq(after.doc.rev, before.doc.rev, 'the revision moved before approval:')
})

await check('the card describes the actual change', async () => {
  const blob = (pendingAction.summary + ' ' + pendingAction.preview.join(' ')).toLowerCase()
  ok(/450/.test(blob), `450 is not in the card: "${blob.slice(0, 200)}"`)
  ok(/cab|airport/.test(blob), `the title is not in the card: "${blob.slice(0, 200)}"`)
})

await check('denying changes nothing', async () => {
  const before = await state()
  const ev = await stream('/api/chat/approve', {
    runId: pendingRun, actionId: pendingAction.actionId, decision: 'deny',
  })
  log(`       ${summarise(ev)}`)
  eq(of(ev, 'applied').length, 0, 'a denied action was applied:')
  const after = await state()
  eq(after.totals.total, before.totals.total, 'the total moved after a denial:')
  eq(after.doc.rev, before.doc.rev, 'the revision moved after a denial:')
})

await check('a stale approval is refused', async () => {
  const r = await post('/api/chat/approve', { runId: pendingRun, actionId: pendingAction.actionId, decision: 'allow' })
  ok(r.status === 409 || r.status === 410, `expected 409/410 for a spent approval, got ${r.status}`)
})

await check('approving applies exactly the planned change', async () => {
  const before = await state()
  const ev1 = await stream('/api/chat', {
    threadId: newThread(), message: 'Add a row for 1250, hotel night one', ...scope,
  })
  const perm = of(ev1, 'permission')[0]
  ok(perm, `no approval card was raised: ${summarise(ev1)}`)
  const runId = ev1.find((e) => e.type === 'run').runId

  const ev2 = await stream('/api/chat/approve', { runId, actionId: perm.action.actionId, decision: 'allow' })
  log(`       ${summarise(ev2)}`)
  const applied = of(ev2, 'applied')
  eq(applied.length, 1, 'expected exactly one applied event:')

  const after = await state()
  eq(after.totals.count, before.totals.count + 1, 'row count did not move by exactly one:')
  eq(after.totals.total, before.totals.total + 1250, 'the total did not move by exactly 1250:')
  ok(after.doc.rev > before.doc.rev, 'the revision did not advance')

  const written = after.doc.rows.find((r) => Number(r.cells[A]) === 1250)
  ok(written, 'the row is not in the document')
  ok(/hotel/i.test(String(written.cells[T] ?? '')), `the title was not carried: "${written.cells[T]}"`)
})

await check('the agent writes under its own actor id', async () => {
  const s = await state()
  const stamps = Object.values(s.doc.stamps).map((st) => st[1])
  ok(stamps.some((a) => String(a).startsWith('ai:')), `no agent-authored stamp found: ${[...new Set(stamps)].join(', ')}`)
  ok(stamps.some((a) => !String(a).startsWith('ai:')), 'no human-authored stamp found')
})

// ------------------------------------------------------- guidance path

log('\nRedirecting mid-flight')
await check('"tell it what to do" redirects instead of applying', async () => {
  const before = await state()
  const ev1 = await stream('/api/chat', { threadId: newThread(), message: 'Add a row for 300 for snacks', ...scope })
  const perm = of(ev1, 'permission')[0]
  ok(perm, `no approval card: ${summarise(ev1)}`)
  const runId = ev1.find((e) => e.type === 'run').runId

  const ev2 = await stream('/api/chat/approve', {
    runId, actionId: perm.action.actionId, decision: 'guide',
    guidance: 'Make it 500, not 300, and title it "Snacks and water".',
  })
  log(`       ${summarise(ev2)}`)

  const mid = await state()
  eq(mid.totals.total, before.totals.total, 'the original 300 was applied despite being redirected:')

  const perm2 = of(ev2, 'permission')[0]
  ok(perm2, `the redirect produced no new proposal: ${summarise(ev2)}`)
  const blob = (perm2.action.summary + ' ' + perm2.action.preview.join(' ')).toLowerCase()
  ok(/500/.test(blob), `the corrected amount is missing: "${blob.slice(0, 200)}"`)
  ok(!/\b300\b/.test(blob), `the rejected amount is still being proposed: "${blob.slice(0, 200)}"`)
})

// ------------------------------------------------------ conflict during review

log('\nConflict while an approval sits on screen')
await check('an edit made during review turns into a conflict, not an overwrite', async () => {
  const ev1 = await stream('/api/chat', {
    threadId: newThread(), message: 'Change the Coffee row amount to 999', ...scope,
  })
  const perm = of(ev1, 'permission')[0]
  ok(perm, `no approval card: ${summarise(ev1)}`)
  const runId = ev1.find((e) => e.type === 'run').runId

  // The user edits the very same cell while the card is open.
  const current = await state()
  const human = await post(`/api/files/${fileId}/mutate`, {
    baseRev: current.doc.rev,
    ops: [{ id: uid(), type: 'cell.set', rowId: 'S3', columnId: A, value: 123 }],
  })
  eq(human.status, 200, 'the human edit was rejected:')

  const ev2 = await stream('/api/chat/approve', { runId, actionId: perm.action.actionId, decision: 'allow' })
  log(`       ${summarise(ev2)}`)

  const after = await state()
  const coffee = after.doc.rows.find((r) => r.id === 'S3')
  ok(of(ev2, 'conflict').length > 0 || Number(coffee.cells[A]) === 123,
     `the agent overwrote a concurrent human edit: coffee is now ${coffee.cells[A]}`)
})

// ---------------------------------------------------------- document import

log('\nDocument extraction')
await check('reads a CSV receipt into proposed rows', async () => {
  const form = new FormData()
  form.append('file', new File(
    ['Item,Amount\nChai,60\nSamosa,40\nBottled water,20\n'],
    'receipt.csv', { type: 'text/csv' },
  ))
  form.append('folderId', folderId)
  const up = await fetch(`${BASE}/api/chat/attach`, { method: 'POST', headers: { cookie }, body: form })
  const upBody = await up.json()
  eq(up.status, 201, `attach failed: ${upBody.message}`)

  const ev = await stream('/api/chat', {
    threadId: newThread(),
    message: 'Read this receipt and add its line items as rows.',
    ...scope,
    attachments: [upBody.attachment],
  })
  log(`       ${summarise(ev)}`)
  ok(of(ev, 'tool_start').some((e) => /extract|attachment/.test(e.name)), 'the document was never read')

  const perm = of(ev, 'permission')[0]
  ok(perm, `no rows were proposed: ${summarise(ev)} | said: ${text(ev).slice(0, 200)}`)
  const blob = (perm.action.summary + ' ' + perm.action.preview.join(' ')).toLowerCase()
  ok(/chai/.test(blob), `chai is missing from the proposal: "${blob.slice(0, 250)}"`)
  ok(/60/.test(blob), `the amount 60 is missing: "${blob.slice(0, 250)}"`)
})

// ---------------------------------------------------------------- memory

log('\nMemory across turns')
await check('remembers context from earlier in the same thread', async () => {
  const t = newThread()
  await stream('/api/chat', { threadId: t, message: 'What is the total here?', ...scope })
  const ev = await stream('/api/chat', { threadId: t, message: 'And how many rows was that?', ...scope })
  log(`       ${summarise(ev)}`)
  const answer = text(ev)
  ok(/\d/.test(answer), `no number in the follow-up answer: "${answer.slice(0, 200)}"`)
  eq(of(ev, 'error').length, 0, 'the follow-up errored')
})

await check('the thread is retrievable afterwards', async () => {
  const t = newThread()
  await stream('/api/chat', { threadId: t, message: 'What is the largest row?', ...scope })
  const r = await get(`/api/chat/threads?threadId=${t}`)
  ok(r.body.messages.length >= 2, `expected a stored exchange, got ${r.body.messages.length} messages`)
  ok(r.body.messages.some((m) => m.role === 'user'), 'the user message was not stored')
  ok(r.body.messages.some((m) => m.role === 'assistant'), 'the assistant reply was not stored')
})

// ---------------------------------------------------------------- misuse

log('\nMisuse and edge cases')
await check('refuses to invent data it has not read', async () => {
  const ev = await stream('/api/chat', {
    threadId: newThread(), message: 'What did I spend on groceries in March 2019?', ...scope,
  })
  log(`       ${summarise(ev)}`)
  eq(of(ev, 'permission').length, 0, 'a question triggered a write proposal')

  // Two acceptable outcomes: say there is no such data, or ask which file to
  // look in. Both are honest. Only a confident fabricated figure is a failure.
  const asked = of(ev, 'ask')
  if (asked.length > 0) return
  const answer = text(ev).toLowerCase()
  ok(answer.length > 0, 'the assistant neither answered nor asked')
  ok(/no |not |none|noth|don't|doesn't|cannot|can't|isn't|empty|only|0/.test(answer),
     `the assistant may have fabricated an answer: "${answer.slice(0, 250)}"`)
})

await check('a nonsense message does not crash the loop', async () => {
  const ev = await stream('/api/chat', { threadId: newThread(), message: 'asdkjh qwe ;;; 🙃', ...scope })
  log(`       ${summarise(ev)}`)
  const fatal = of(ev, 'error').filter((e) => e.fatal)
  eq(fatal.length, 0, 'a nonsense message produced a fatal error:')
  ok(of(ev, 'done').length > 0, 'the stream never completed')
})

await check('works with no file open', async () => {
  const ev = await stream('/api/chat', {
    threadId: newThread(), message: 'Which of my files has the largest total?', fileId: null, folderId: null,
  })
  log(`       ${summarise(ev)}`)
  eq(of(ev, 'error').filter((e) => e.fatal).length, 0, 'failed without a file open')
  ok(text(ev).length > 0, 'said nothing')
})

log(`\n${pass} passed, ${fail} failed`)
if (fail) { log('\nFailures:'); failures.forEach((f) => log('  - ' + f)); process.exit(1) }
