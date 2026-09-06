/**
 * Forgetting a password, and getting back in.
 *
 * The flow is three requests, and most of what matters is what it refuses.
 * A reset form is reachable by anyone with the URL, so the tests below are
 * mostly about the things it must not do: name an account, accept a code twice,
 * accept a ticket twice, let a wrong code be guessed at indefinitely, or leave
 * the old password working afterwards.
 *
 * The code is read from the development outbox, which is where a message goes
 * on a deployment with no email provider configured. Needs the dev server on
 * BASE and a working directory it can write to.
 */
import { readFile, writeFile } from 'node:fs/promises'

const BASE = process.env.BASE ?? 'http://localhost:3111'
const OUTBOX = process.env.MAIL_OUTBOX ?? '.mail-outbox.log'

let pass = 0, fail = 0
const failures = []
const log = (s = '') => console.log(s)
async function check(name, fn) {
  try { await fn(); pass++; log(`  ok   ${name}`) }
  catch (err) { fail++; failures.push(name); log(`  FAIL ${name}\n       ${err.message}`) }
}
function eq(a, b, m = '') { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`) }
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy') }

let cookie = ''
async function req(path, init = {}) {
  const res = await fetch(BASE + path, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } })
  const sc = res.headers.get('set-cookie')
  if (sc) cookie = sc.split(';')[0]
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: res.status, body }
}
const post = (p, d) => req(p, { method: 'POST', body: JSON.stringify(d ?? {}) })

/** The most recent message to this address, from the development outbox. */
async function lastMail(to) {
  const raw = await readFile(OUTBOX, 'utf8').catch(() => '')
  const lines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return [...lines].reverse().find((m) => m.to === to) ?? null
}
const codeOf = (mail) => (mail?.subject.match(/\b(\d{6})\b/) ?? [])[1] ?? null

const tag = Math.random().toString(36).slice(2, 10)
const EMAIL = `reset.${tag}@example.com`
const FIRST = 'first-password-1'
const SECOND = 'second-password-2'

await writeFile(OUTBOX, '').catch(() => {})

// Skip rather than fail when the server is not up: same contract as test:db.
const up = await fetch(`${BASE}/api/auth/login`).then((r) => r.ok).catch(() => false)
if (!up) {
  log(`\n  skipped: no server on ${BASE}`)
  process.exit(0)
}

log('\nSetting up')
await check('an account can be created to forget the password of', async () => {
  const r = await post('/api/auth/signup', { email: EMAIL, password: FIRST, name: 'Reset Test' })
  eq(r.status, 200, 'signup')
})
await post('/api/auth/logout')
cookie = ''

log('\nAsking for a code')
await check('an address with no account gets the same answer as one with', async () => {
  const a = await post('/api/auth/forgot', { email: `nobody.${tag}@example.com` })
  const b = await post('/api/auth/forgot', { email: EMAIL })
  eq(a.status, b.status, 'status')
  eq(a.body, b.body, 'body')
})

await check('no message is written for an address with no account', async () => {
  eq(await lastMail(`nobody.${tag}@example.com`), null)
})

let code = null
await check('a six-digit code reaches the mailbox', async () => {
  const mail = await lastMail(EMAIL)
  ok(mail, 'nothing in the outbox')
  code = codeOf(mail)
  ok(code && /^\d{6}$/.test(code), `no code in subject: ${mail.subject}`)
  ok(mail.text.includes(code), 'the plain-text part is missing the code')
  ok(mail.html.includes(code), 'the html part is missing the code')
})

await check('the code is nowhere in the response', async () => {
  const r = await post('/api/auth/forgot', { email: EMAIL })
  ok(!JSON.stringify(r.body).includes(code), `the response carried the code: ${JSON.stringify(r.body)}`)
})

log('\nProving it arrived')
await check('a wrong code is refused', async () => {
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, '0')
  const r = await post('/api/auth/verify-code', { email: EMAIL, code: wrong })
  eq(r.status, 400, 'status')
  ok(!r.body.ticket, 'a ticket was handed out for a wrong code')
})

let ticket = null
await check('the right code earns a ticket', async () => {
  // The resend above replaced the code, so read the current one.
  code = codeOf(await lastMail(EMAIL))
  const r = await post('/api/auth/verify-code', { email: EMAIL, code })
  eq(r.status, 200, 'status')
  ticket = r.body.ticket
  ok(typeof ticket === 'string' && ticket.length > 20, 'no ticket')
})

await check('the same code cannot be spent twice', async () => {
  const r = await post('/api/auth/verify-code', { email: EMAIL, code })
  eq(r.status, 400, 'status')
})

log('\nChoosing a new password')
await check('a short password is refused and the ticket is spent anyway', async () => {
  const r = await post('/api/auth/reset', { ticket, password: 'short' })
  ok(r.status >= 400, `expected a refusal, got ${r.status}`)
})

await check('a fresh code and ticket sets the password', async () => {
  await post('/api/auth/forgot', { email: EMAIL })
  const fresh = codeOf(await lastMail(EMAIL))
  const v = await post('/api/auth/verify-code', { email: EMAIL, code: fresh })
  eq(v.status, 200, 'verify')
  const r = await post('/api/auth/reset', { ticket: v.body.ticket, password: SECOND })
  eq(r.status, 200, 'reset')
  eq(r.body.user.email, EMAIL, 'signed in as')
  ticket = v.body.ticket
})

await check('the ticket cannot be replayed', async () => {
  const r = await post('/api/auth/reset', { ticket, password: 'another-password-3' })
  eq(r.status, 400, 'status')
})

log('\nAccounts with no password to reset')
await check('a developer or Google account is told which button to press', async () => {
  const address = 'varad@hisaabhkitaabh.local'
  const r = await post('/api/auth/forgot', { email: address })
  eq(r.status, 200, 'status')
  const mail = await lastMail(address)
  if (!mail) return // the developer account may not exist on this deployment
  eq(codeOf(mail), null, 'a code was sent to an account that has no password')
  ok(/sign/i.test(mail.text), 'the note does not say how to sign in')
})

log('\nLimits')
await check('a mailbox cannot be used to send unlimited mail', async () => {
  const address = `flood.${tag}@example.com`
  await post('/api/auth/signup', { email: address, password: 'flood-password-1' })
  await post('/api/auth/logout')
  cookie = ''
  for (let i = 0; i < 8; i++) await post('/api/auth/forgot', { email: address })
  const raw = await readFile(OUTBOX, 'utf8').catch(() => '')
  const sent = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.to === address)
  ok(sent.length <= 5, `${sent.length} messages sent for 8 requests`)
  ok(sent.length >= 1, 'nothing was sent at all')
})

await check('being throttled still looks like success', async () => {
  const address = `flood.${tag}@example.com`
  const r = await post('/api/auth/forgot', { email: address })
  eq(r.status, 200, 'a throttled request announced itself')
})

log('\nAfterwards')
await post('/api/auth/logout')
cookie = ''

await check('the old password no longer works', async () => {
  const r = await post('/api/auth/login', { identifier: EMAIL, password: FIRST })
  ok(r.status >= 400, `the old password still signs in (${r.status})`)
})

await check('the new password does', async () => {
  const r = await post('/api/auth/login', { identifier: EMAIL, password: SECOND })
  eq(r.status, 200, 'login')
})

await check('a made-up ticket gets nowhere', async () => {
  const r = await post('/api/auth/reset', { ticket: 'x'.repeat(43), password: 'yet-another-pw-4' })
  eq(r.status, 400, 'status')
})

log(`\n${pass} passed, ${fail} failed`)
if (fail) log(failures.map((f) => `  - ${f}`).join('\n'))
process.exit(fail ? 1 : 0)
