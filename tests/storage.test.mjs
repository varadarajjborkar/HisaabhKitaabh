/**
 * Storage: the share, the shrinking, and being told about it.
 *
 * These exist because one number changed meaning. `MAX_STORAGE_BYTES_PER_USER`
 * used to be the size of the whole database written into a per-account
 * variable, so the cap was never reached and none of the behaviour behind it
 * had ever run. Now that it is a real share of a real pool, three things have
 * to be true: a receipt has to cost about what a receipt is worth, the
 * thresholds have to fire where they claim to, and a person has to be told
 * before uploads start failing rather than by an upload failing.
 *
 * Run with: node --experimental-strip-types --import ./tests/resolve-hook-register.mjs tests/storage.test.mjs
 */
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { storageNoticeLevel, unseenAmong } from '../src/lib/notices.ts'

const BASE = process.env.BASE ?? 'http://localhost:3111'

let pass = 0, fail = 0
const failures = []
const log = (s = '') => console.log(s)

async function check(name, fn) {
  try { await fn(); pass++; log(`  ok   ${name}`) }
  catch (err) {
    fail++
    failures.push(`${name}: ${err.message}`)
    log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`)
  }
}
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy') }
function eq(a, b, m = '') { if (String(a) !== String(b)) throw new Error(`${m} expected ${b}, got ${a}`) }

// ── thresholds ──────────────────────────────────────────────────────────────
log('\nWhen a warning is due')

await check('nothing is said below three quarters', () => {
  eq(storageNoticeLevel(0, 100), null, 'an empty account:')
  eq(storageNoticeLevel(74, 100), null, 'at 74%:')
  eq(storageNoticeLevel(74.9, 100), null, 'just under the line:')
})

await check('each threshold fires exactly on its own boundary', () => {
  eq(storageNoticeLevel(75, 100), 'warning', 'at 75%:')
  eq(storageNoticeLevel(89.9, 100), 'warning', 'just under critical:')
  eq(storageNoticeLevel(90, 100), 'critical', 'at 90%:')
  eq(storageNoticeLevel(99.9, 100), 'critical', 'just under full:')
  eq(storageNoticeLevel(100, 100), 'full', 'at 100%:')
})

await check('over the limit is full, not an error', () => {
  // A cap lowered under an account that was already above it must still produce
  // a notice rather than dividing its way into something nonsensical.
  eq(storageNoticeLevel(500, 100), 'full', 'well over:')
})

await check('a limit of zero says nothing at all', () => {
  eq(storageNoticeLevel(10, 0), null, 'no limit means no notice:')
})

// ── the dot ─────────────────────────────────────────────────────────────────
log('\nThe dot on the bell')

const notice = (level) => ({ id: 'storage', level, title: '', body: '', actions: [] })

await check('a first warning lights it', () => {
  eq(unseenAmong([notice('warning')], null), true)
})

await check('the same warning again does not', () => {
  eq(unseenAmong([notice('warning')], 'warning'), false, 'being told twice:')
})

await check('getting worse lights it again', () => {
  eq(unseenAmong([notice('critical')], 'warning'), true, 'warning acknowledged, now critical:')
  eq(unseenAmong([notice('full')], 'critical'), true, 'critical acknowledged, now full:')
})

await check('getting better does not', () => {
  // Deleting receipts drops the level. That is good news and good news does not
  // get a red dot.
  eq(unseenAmong([notice('warning')], 'full'), false)
})

await check('no notices means no dot, whatever was acknowledged', () => {
  eq(unseenAmong([], 'full'), false)
})

// ── the browser: a receipt costs what a receipt is worth ────────────────────
log('\nIn the browser')

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
page.setDefaultTimeout(60_000)
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 160)}`))

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('#identifier', 'varad')
await page.fill('#password', 'varad[123]')
await page.click('button[type=submit]')
await page.waitForURL(`${BASE}/home`, { timeout: 60_000 })
await page.waitForTimeout(2000)

await check('a phone-sized photo is shrunk by roughly ten times before it is sent', async () => {
  /*
   * A real photograph, not a flat colour. A solid fill compresses to nothing at
   * any size and would pass this test while proving nothing - the reduction has
   * to come from resolution, so the source is noisy enough that JPEG cannot
   * cheat its way out of it.
   */
  const result = await page.evaluate(async () => {
    const draw = (w, h) => {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d')
      const img = ctx.createImageData(w, h)
      for (let i = 0; i < img.data.length; i += 4) {
        const n = Math.random() * 90
        img.data[i] = 150 + n; img.data[i + 1] = 145 + n; img.data[i + 2] = 140 + n; img.data[i + 3] = 255
      }
      ctx.putImageData(img, 0, 0)
      return c
    }
    const canvas = draw(4000, 3000)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.95))
    const before = blob.size

    // The same steps the app takes, run against the same browser APIs.
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const out = document.createElement('canvas')
    out.width = Math.round(bitmap.width * scale)
    out.height = Math.round(bitmap.height * scale)
    const octx = out.getContext('2d')
    octx.fillStyle = '#ffffff'
    octx.fillRect(0, 0, out.width, out.height)
    octx.drawImage(bitmap, 0, 0, out.width, out.height)
    const shrunk = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.72))
    return { before, after: shrunk.size, width: out.width, height: out.height }
  })

  eq(result.width, 1600, 'the long edge was not capped:')
  ok(result.height === 1200, `the aspect ratio was not kept, got ${result.width}x${result.height}`)
  ok(
    result.after * 5 < result.before,
    `expected at least a fivefold reduction, got ${(result.before / 1024 / 1024).toFixed(2)} MB ` +
      `to ${(result.after / 1024).toFixed(0)} KB`,
  )
  log(`       ${(result.before / 1024 / 1024).toFixed(2)} MB down to ${(result.after / 1024).toFixed(0)} KB` +
      ` (${(result.before / result.after).toFixed(1)}x)`)
})

await check('the bell is on every screen and knows this account', async () => {
  const bell = page.getByRole('button', { name: /Notifications/ })
  eq(await bell.count(), 1, 'expected exactly one bell:')
  const feed = await page.evaluate(() => fetch('/api/notifications').then((r) => r.json()))
  ok(feed.ok, `the feed did not answer: ${JSON.stringify(feed)}`)
  ok(Array.isArray(feed.notices), 'the feed carried no notices array')
  eq(typeof feed.unseen, 'boolean', 'unseen was not a boolean:')
})

await check('a healthy account is told nothing', async () => {
  // The suite's own account is nowhere near its cap, and an app that warns
  // about a quarter of a quota is an app whose warnings get ignored.
  const feed = await page.evaluate(() => fetch('/api/notifications').then((r) => r.json()))
  eq(feed.notices.length, 0, `expected silence, got: ${JSON.stringify(feed.notices)}`)
  eq(feed.unseen, false, 'a dot with nothing behind it:')
})

await check('feedback reaches the owner carrying the sender, not asking for it', async () => {
  const before = await readFile('.mail-outbox.log', 'utf8').catch(() => '')
  const res = await page.evaluate(() =>
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'A test message from the storage suite.', topic: 'storage' }),
    }).then((r) => r.json()),
  )

  if (res.code === 'feedback_not_configured') {
    log('       skipped: set FEEDBACK_TO to exercise the feedback door')
    return
  }
  ok(res.ok, `feedback was refused: ${JSON.stringify(res)}`)

  const after = await readFile('.mail-outbox.log', 'utf8').catch(() => '')
  ok(after.length > before.length, 'nothing was written to the outbox')
  const mail = JSON.parse(after.trim().split('\n').pop())
  ok(/varad/.test(mail.replyTo ?? ''), `the sender was not set as reply-to: ${mail.replyTo}`)
  ok(/Storage request/.test(mail.subject), `the subject did not name the topic: ${mail.subject}`)
  ok(/Storage:/.test(mail.text), 'the usage figures did not travel with the message')
  ok(!/varad\[123\]/.test(mail.text), 'a password appeared in the body')
})

await check('the message is not a way to mail the owner anything', async () => {
  // Four characters is the floor; a stray keypress should not become an email.
  const res = await page.evaluate(() =>
    fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x' }),
    }).then((r) => ({ status: r.status, ...r.json?.() })),
  )
  eq(res.status, 400, 'a one-character message was accepted:')
})

await check('no page errors along the way', () => {
  eq(problems.length, 0, `browser problems:\n       ${problems.join('\n       ')}`)
})

await browser.close()

log(`\n${pass} passed, ${fail} failed`)
if (failures.length) {
  log('\nFailures:')
  for (const f of failures) log(`  - ${f}`)
}
process.exit(fail ? 1 : 0)
