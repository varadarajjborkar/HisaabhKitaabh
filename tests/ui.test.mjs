/**
 * Browser tests.
 *
 * These exist because the previous suites could not have caught the bug that
 * prompted them: the client sent its optimistically-advanced local revision as
 * `baseRev`, so every save from the UI came back 409 — invisible to API tests,
 * which construct their own requests. Anything that only breaks once React,
 * the network and the server are all in the loop belongs here.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:3111'
const SHOTS = process.env.SHOTS ?? '/tmp/khata-shots'

let pass = 0, fail = 0
const failures = []
const log = (s = '') => console.log(s)

async function check(name, fn) {
  const t = Date.now()
  try { await fn(); pass++; log(`  ok   ${name}  (${((Date.now() - t) / 1000).toFixed(1)}s)`) }
  catch (err) {
    fail++
    let where = ''
    try {
      where = ` [url=${page.url().replace(BASE, '')} rows=${await page.locator('tbody tr').count()} tfoot=${await page.locator('tfoot td').count()}]`
    } catch { /* page may be gone */ }
    const msg = `${err.message.split('\n')[0]}${where}`
    failures.push(`${name}: ${msg}`)
    log(`  FAIL ${name}\n       ${msg}`)
  }
}
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy') }
function eq(a, b, m = '') { if (String(a) !== String(b)) throw new Error(`${m} expected ${b}, got ${a}`) }

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } })
const page = await context.newPage()

/** Any console error or failed request is a test failure, not background noise. */
const problems = []
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`) })
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`))
const badResponses = []
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/api/')) badResponses.push(`${r.status()} ${r.url().replace(BASE, '')}`)
})

log('\nSign in')
await check('login page renders and accepts the developer account', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  ok(await page.locator('text=Folders, files, rows.').isVisible(), 'the pitch panel is missing')
  await page.fill('#identifier', 'varad')
  await page.fill('#password', 'varad[123]')
  await page.click('button[type=submit]')
  await page.waitForURL('**/home', { timeout: 15000 })
})

log('\nHome')
await check('folders are listed', async () => {
  await page.waitForSelector('text=Folders', { timeout: 10000 })
  const cards = await page.locator('a[href^="/folder/"]').count()
  ok(cards >= 1, `expected at least one folder card, found ${cards}`)
})
await check('folder cards show their file counts', async () => {
  const card = page.locator('a[href^="/folder/"]').first()
  ok(/file/i.test(await card.innerText()), `a folder card has no file count: "${await card.innerText()}"`)
})
await check('analytics is off until switched on, then charts appear', async () => {
  const toggle = page.locator('button[role=switch][aria-label=Analytics]')
  ok(await toggle.isVisible(), 'the analytics toggle is missing')
  if ((await toggle.getAttribute('aria-checked')) === 'false') await toggle.click()
  await page.waitForFunction(
    () => document.querySelectorAll('figure').length > 0 || /Nothing to chart yet/.test(document.body.innerText),
    { timeout: 20000 },
  )
  ok(true)
})
await page.screenshot({ path: `${SHOTS}/01-home.png`, fullPage: false })

log('\nThe sheet — where the save bug lived')

/**
 * Each run gets its own folder and file.
 *
 * The first version of these tests edited whichever sample file came first,
 * so a second run inherited the first run's rows and the assertions started
 * contradicting each other. Hermetic fixtures, created through the same API
 * the app uses.
 */
const fixture = await page.evaluate(async () => {
  const j = async (url, body) =>
    (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
  const stamp = Date.now().toString(36).toUpperCase()
  const folder = await j('/api/folders', { name: `UI drills ${stamp}`, icon: '🧪', id: `UIF${stamp}` })
  const file = await j('/api/files', { folderId: folder.folder.id, name: 'Sheet drills', id: `UIS${stamp}` })
  return { folderId: folder.folder.id, fileId: file.doc.id }
})
log(`       fixture: file ${fixture.fileId}`)

await check('a new file opens with the three default columns and no rows', async () => {
  await page.goto(`${BASE}/file/${fixture.fileId}`, { waitUntil: 'networkidle' })
  await page.waitForSelector('table', { timeout: 15000 })
  eq(await page.locator('tbody tr:not([data-placeholder])').count(), 0, 'a brand-new file should be empty:')
  ok(await page.locator('tbody tr[data-placeholder]').isVisible(), 'the empty state is not shown')
  for (const name of ['INR', 'Title', 'Extra Captions']) {
    ok(await page.locator('th').filter({ hasText: new RegExp(`^${name}`) }).first().isVisible(), `the ${name} column is missing`)
  }
})

await check('adding a row and typing an amount saves without conflict', async () => {
  badResponses.length = 0
  await page.locator('button:has-text("Add row")').first().click()
  await page.waitForSelector('tbody tr', { timeout: 5000 })

  const row = page.locator('tbody tr').first()
  await row.locator('input[aria-label="INR"]').fill('5000')
  await row.locator('input[aria-label="Title"]').fill('First row')
  await row.locator('input[aria-label="Title"]').press('Tab')
  await page.waitForTimeout(2500)

  const conflicts = badResponses.filter((r) => r.startsWith('409'))
  eq(conflicts.length, 0, `the save conflicted: ${conflicts.join(', ')}`)
  ok(!(await page.locator('text=Conflict').first().isVisible().catch(() => false)), 'a conflict banner appeared')
  ok(/Saved/.test(await page.locator('header').first().innerText()), 'the header never reported a save')
})

await check('the edit survives a reload', async () => {
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('tbody tr', { timeout: 15000 })
  const value = await page.locator('tbody tr').first().locator('input[aria-label="INR"]').inputValue()
  eq(value.replace(/,/g, ''), '5000', 'the saved value did not come back:')
})

await check('the footer total reflects the rows', async () => {
  const total = (await page.locator('tfoot td').nth(1).textContent())?.trim()
  ok(/5,?000/.test(total ?? ''), `the total does not show 5,000: "${total}"`)
})

await check('Enter at the bottom row does not create a phantom row', async () => {
  const before = await page.locator('tbody tr').count()
  const row = page.locator('tbody tr').last()
  await row.locator('input[aria-label="INR"]').fill('5500')
  await row.locator('input[aria-label="INR"]').press('Enter')
  await page.waitForTimeout(1200)
  eq(await page.locator('tbody tr').count(), before, 'Enter appended an empty row:')
})

await check('undo reverses the last edit', async () => {
  const undo = page.locator('button[aria-label=Undo]')
  ok(!(await undo.isDisabled()), 'undo is disabled after an edit')
  await undo.click()
  await page.waitForTimeout(900)
  const value = await page.locator('tbody tr').first().locator('input[aria-label="INR"]').inputValue()
  eq(value.replace(/,/g, ''), '5000', 'undo did not restore the previous amount:')
})

await check('redo reapplies it', async () => {
  await page.locator('button[aria-label=Redo]').click()
  await page.waitForTimeout(900)
  const value = await page.locator('tbody tr').first().locator('input[aria-label="INR"]').inputValue()
  eq(value.replace(/,/g, ''), '5500', 'redo did not reapply:')
})

await check('undo survives a round trip to the server', async () => {
  await page.waitForTimeout(1500)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('tbody tr', { timeout: 15000 })
  const value = await page.locator('tbody tr').first().locator('input[aria-label="INR"]').inputValue()
  eq(value.replace(/,/g, ''), '5500', 'the redone value was not persisted:')
})

await check('a non-numeric amount is refused, not stored', async () => {
  const cell = page.locator('tbody tr').first().locator('input[aria-label="INR"]')
  await cell.fill('not a number')
  await cell.press('Enter')
  await page.waitForTimeout(900)
  ok(/5,?500/.test(await cell.inputValue()), `junk was accepted into an amount cell: "${await cell.inputValue()}"`)
})

await check('a second row can be added and both persist', async () => {
  await page.locator('button:has-text("Add row")').first().click()
  await page.waitForTimeout(400)
  const row = page.locator('tbody tr').nth(1)
  await row.locator('input[aria-label="INR"]').fill('1500')
  await row.locator('input[aria-label="Title"]').fill('Second row')
  await row.locator('input[aria-label="Title"]').press('Tab')
  await page.waitForTimeout(2500)

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('tbody tr', { timeout: 15000 })
  eq(await page.locator('tbody tr').count(), 2, 'both rows should be present:')
  const total = (await page.locator('tfoot td').nth(1).textContent())?.trim()
  ok(/7,?000/.test(total ?? ''), `expected a total of 7,000, got "${total}"`)
})

await check('adding a custom column works and persists', async () => {
  await page.locator('button[aria-label="Add a column"]').click()
  await page.waitForSelector('#col-name', { timeout: 5000 })
  await page.fill('#col-name', 'Category')
  await page.locator('button:has-text("Add column")').last().click()
  await page.waitForTimeout(2000)
  ok(await page.locator('th').filter({ hasText: /^Category/ }).first().isVisible(), 'the column was not added')

  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('table')
  ok(await page.locator('th').filter({ hasText: /^Category/ }).first().isVisible(), 'the column did not persist')
})

await check('the period toggle stores a range', async () => {
  const toggle = page.locator('button[role=switch][aria-label=Period]')
  if ((await toggle.getAttribute('aria-checked')) === 'false') await toggle.click()
  await page.waitForTimeout(400)
  const from = page.locator('input[aria-label="Period start"]')
  ok(await from.isVisible(), 'the period inputs did not appear')
  await from.fill('2025-10-04')
  await page.locator('input[aria-label="Period end"]').fill('2025-10-09')
  await page.waitForTimeout(2200)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('input[aria-label="Period start"]', { timeout: 10000 })
  eq(await page.locator('input[aria-label="Period start"]').inputValue(), '2025-10-04', 'the period did not persist:')
})

await page.screenshot({ path: `${SHOTS}/02-sheet.png`, fullPage: false })

log('\nThe assistant, in the browser')
await check('the assistant answers in the side panel', async () => {
  const input = page.locator('textarea').first()
  ok(await input.isVisible(), 'the assistant panel is not visible on a wide viewport')
  await input.fill('What is the total in this file?')
  await input.press('Enter')
  await page.waitForFunction(
    () => /₹|total|rows/i.test(document.querySelector('aside')?.innerText ?? ''),
    { timeout: 45000 },
  )
  ok(true)
})

await check('a write request raises an approval card that writes nothing yet', async () => {
  const totalBefore = (await page.locator('tfoot td').nth(1).textContent())?.trim()
  ok(totalBefore, 'no footer total to compare against')
  const input = page.locator('textarea').first()
  await input.fill('Add a row for 1234 titled Approval card test')
  await input.press('Enter')
  await page.waitForSelector('text=Needs your approval', { timeout: 60000 })

  ok(await page.getByRole('button', { name: 'Allow', exact: true }).isVisible(), 'no Allow button')
  ok(await page.getByRole('button', { name: 'Deny', exact: true }).isVisible(), 'no Deny button')
  ok(await page.getByRole('button', { name: /Tell it what to do/ }).isVisible(), 'no redirect button')

  eq((await page.locator('tfoot td').nth(1).textContent())?.trim(), totalBefore,
     'the sheet changed before approval:')
})

await check('approving applies the change to the visible sheet', async () => {
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await page.waitForSelector('input[value="Approval card test"]', { timeout: 60000 })
  ok(await page.locator('input[value="Approval card test"]').first().isVisible(), 'the row is not in the grid')
})

await page.screenshot({ path: `${SHOTS}/03-assistant.png`, fullPage: false })

log('\nMobile layout')
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
})
const mobile = await phone.newPage()
await check('signs in and reaches a file on a phone viewport', async () => {
  await mobile.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await mobile.fill('#identifier', 'varad')
  await mobile.fill('#password', 'varad[123]')
  await mobile.click('button[type=submit]')
  await mobile.waitForURL('**/home', { timeout: 15000 })
  await mobile.goto(`${BASE}/file/${fixture.fileId}`, { waitUntil: 'networkidle' })
  await mobile.waitForTimeout(2000)
})
await check('rows render as cards, not a table', async () => {
  const tableVisible = await mobile.locator('table').first().isVisible().catch(() => false)
  ok(!tableVisible, 'the desktop table is showing on a phone')
})
await check('nothing overflows horizontally', async () => {
  const overflow = await mobile.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(overflow <= 1, `the page scrolls sideways by ${overflow}px`)
})
await check('the calculator is absent on a phone', async () => {
  const visible = await mobile.locator('button[aria-label="Open calculator"]').isVisible().catch(() => false)
  ok(!visible, 'the calculator launcher is showing on a phone')
})
await check('an amount cell is editable by touch', async () => {
  // The desktop table is display:none but still in the DOM, so its inputs
  // would match first — scope to what is actually on screen.
  const input = mobile.locator('input[aria-label="INR"]:visible').first()
  ok(await input.isVisible(), 'no amount input on the card layout')
  const box = await input.boundingBox()
  ok(box && box.height >= 24, `the touch target is only ${box?.height}px tall`)
})
await mobile.screenshot({ path: `${SHOTS}/04-mobile.png`, fullPage: false })

log('\nPage hygiene')
await check('no console errors or failed API calls across the session', async () => {
  const realProblems = problems.filter((p) => !/favicon|Download the React DevTools/i.test(p))
  const realBad = badResponses.filter((r) => !r.startsWith('304'))
  ok(realProblems.length === 0 && realBad.length === 0,
     `console: ${realProblems.slice(0, 4).join(' | ')}\n       requests: ${realBad.slice(0, 4).join(' | ')}`)
})

await browser.close()
log(`\n${pass} passed, ${fail} failed`)
log(`screenshots in ${SHOTS}`)
if (fail) { log('\nFailures:'); failures.forEach((f) => log('  - ' + f)); process.exit(1) }
