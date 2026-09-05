/**
 * Browser tests.
 *
 * These exist because the previous suites could not have caught the bug that
 * prompted them: the client sent its optimistically-advanced local revision as
 * `baseRev`, so every save from the UI came back 409 - invisible to API tests,
 * which construct their own requests. Anything that only breaks once React,
 * the network and the server are all in the loop belongs here.
 */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:3111'
const SHOTS = process.env.SHOTS ?? '/tmp/hisaabhkitaabh-shots'

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
/*
 * A ceiling on every action.
 *
 * Playwright's per-action default is generous, and one run of the recents test
 * sat for fourteen minutes before passing rather than failing fast. A bounded
 * timeout turns "something is wedged" into a visible failure instead of a stall
 * that looks like a slow machine.
 */
page.setDefaultTimeout(20_000)

/** Any console error or failed request is a test failure, not background noise. */
const problems = []
page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)}`) })
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`))
const badResponses = []
page.on('response', (r) => {
  if (r.status() >= 400 && r.url().includes('/api/')) badResponses.push(`${r.status()} ${r.url().replace(BASE, '')}`)
})

log('\nSign in')
await check('the password field can be revealed and re-masked', async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await page.fill('#password', 'not-the-real-one')
  eq(await page.getAttribute('#password', 'type'), 'password', 'the field does not start masked:')
  await page.click('button[aria-label="Show password"]')
  eq(await page.getAttribute('#password', 'type'), 'text', 'the eye did not reveal it:')
  await page.click('button[aria-label="Hide password"]')
  eq(await page.getAttribute('#password', 'type'), 'password', 'the eye did not re-mask it:')
})

await check('login page renders and accepts the developer account', async () => {
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

log('\nThe sheet - where the save bug lived')

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
  // The fields are named by their visible <label>, not by an aria-label that
  // would disagree with what is on screen; address them by id.
  const from = page.locator('#period-from')
  ok(await from.isVisible(), 'the period inputs did not appear')
  await from.fill('2025-10-04')
  await page.locator('#period-to').fill('2025-10-09')
  await page.waitForTimeout(2200)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('#period-from', { timeout: 10000 })
  eq(await page.locator('#period-from').inputValue(), '2025-10-04', 'the period did not persist:')
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

/**
 * Chrome and gestures.
 *
 * Everything here is invisible to an API test and easy to break with a CSS
 * change: which element owns a scroll, whether a popover closes, whether a
 * pointer drag actually reorders anything.
 */
log('\nChrome and gestures')

await check('the theme switch stamps the document and can go back to system', async () => {
  await page.click('button[aria-label="Account and settings"]')
  await page.click('button[role=radio]:has-text("Dark")')
  await page.waitForTimeout(200)
  eq(await page.getAttribute('html', 'data-theme'), 'dark', 'dark was not stamped:')
  eq(await page.evaluate(() => localStorage.getItem('hisaabhkitaabh-theme')), 'dark', 'the choice was not stored:')
  await page.click('button[role=radio]:has-text("System")')
  await page.waitForTimeout(200)
  ok((await page.getAttribute('html', 'data-theme')) === null, 'system left an explicit stamp behind')
  await page.click('button[role=radio]:has-text("Light")')
  await page.waitForTimeout(200)
  eq(await page.getAttribute('html', 'data-theme'), 'light', 'light was not stamped:')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  eq(await page.locator('div[role=menu]').count(), 0, 'Escape did not close the account menu:')
})

await check('opening one popover closes the other', async () => {
  await page.click('button[aria-label="Account and settings"]')
  ok(await page.locator('div[role=menu]').isVisible(), 'the account menu did not open')
  await page.locator('th button[aria-label^="Options for"]').first().click({ force: true })
  await page.waitForTimeout(200)
  eq(await page.locator('div[role=menu]').count(), 0, 'the account menu stayed open behind the column menu:')
  ok(await page.locator('button:has-text("Rename")').first().isVisible(), 'the column menu did not open')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(150)
  eq(await page.locator('button:has-text("Rename")').count(), 0, 'the column menu survived Escape:')
})

await check('storage offers both homes and marks the one in use', async () => {
  await page.click('button[aria-label="Account and settings"]')
  await page.click('button[role=menuitem]:has-text("Storage"), button:has-text("Storage")')
  await page.waitForSelector('dialog[open]:has-text("Where your files live")')
  const dialog = page.locator('dialog[open]')
  const app = dialog.locator('button:has-text("In this app")')
  const drive = dialog.locator('button:has-text("In my Google Drive")')
  eq(await app.getAttribute('aria-pressed'), 'true', 'app storage was not shown as the one in use:')
  eq(await drive.getAttribute('aria-pressed'), 'false', 'drive was shown as in use:')
  ok(await app.isDisabled(), 'the backend already in use was offered as a switch')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  eq(await page.locator('dialog[open]').count(), 0, 'the storage dialog survived Escape:')
})

await check('holding the theme button opens a stack you can swipe and release on', async () => {
  /*
   * Two gestures on one control, so both need proving: a tap still cycles, and
   * a hold opens the picker. The hold also has to survive the finger leaving
   * the 36px button - without pointer capture the gesture dies halfway and the
   * release selects nothing, which is exactly how it first behaved.
   */
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const p2 = await ctx2.newPage()
  p2.setDefaultTimeout(20_000)
  await p2.goto(`${BASE}/login`)

  const btn = p2.locator('button[aria-haspopup="listbox"]')
  await btn.waitFor()
  eq(await btn.getAttribute('aria-expanded'), 'false', 'the picker started open:')

  // A short tap cycles rather than opening anything.
  await btn.click()
  await p2.waitForTimeout(250)
  eq(await p2.locator('[role=listbox]').count(), 0, 'a tap opened the picker instead of cycling:')
  // A fresh context has no stored preference, so it starts on "system" and one
  // tap lands on "light" - the first card. Swiping down is therefore the
  // direction with somewhere to go.
  const afterTap = await p2.evaluate(() => localStorage.getItem('hisaabhkitaabh-theme'))
  eq(afterTap, 'light', 'a tap from the default did not cycle to light:')

  // A hold opens the stack; swiping up one card and releasing commits it.
  const box = await btn.boundingBox()
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await p2.mouse.move(cx, cy)
  await p2.mouse.down()
  await p2.waitForTimeout(700)
  ok(await p2.locator('[role=listbox]').isVisible(), 'holding did not open the picker')
  const cards = await p2.locator('[role=option]').count()
  eq(cards, 3, 'the stack should hold all three choices:')

  await p2.mouse.move(cx, cy + 46) // one card down: light -> dark
  await p2.waitForTimeout(200)
  await p2.mouse.up()
  await p2.waitForTimeout(300)

  const afterSwipe = await p2.evaluate(() => localStorage.getItem('hisaabhkitaabh-theme'))
  eq(afterSwipe, 'dark', 'releasing on the second card did not select it:')
  eq(await p2.getAttribute('html', 'data-theme'), 'dark', 'the choice never reached the document:')
  eq(await p2.locator('[role=listbox]').count(), 0, 'the picker stayed open after releasing:')
  await ctx2.close()
})

await check('the amount column can be switched to another currency', async () => {
  // The currency lives on the file, but the column header is where a user goes
  // looking for it, so that is where the control has to be.
  await page.locator('th button[aria-label^="Options for"]').first().click({ force: true })
  await page.waitForSelector('text=Currency')
  const menu = page.locator('body > div.card').last()
  ok(await menu.isVisible(), 'the column menu did not open')

  await page.locator('button:has-text("US dollar")').first().click()
  await page.waitForTimeout(1200)

  const header = await page.locator('thead th').nth(1).innerText()
  eq(header.trim(), 'USD', 'the column header did not follow the currency:')
  const foot = (await page.locator('tfoot').innerText()).replace(/\s+/g, ' ')
  ok(foot.includes('$'), `the total is not in dollars: ${foot}`)
  ok(!foot.includes('₹'), `the rupee symbol survived the switch: ${foot}`)

  // Back to rupees so the rest of the suite sees what it expects.
  await page.locator('th button[aria-label^="Options for"]').first().click({ force: true })
  await page.waitForSelector('text=Currency')
  await page.locator('button:has-text("Indian rupee")').first().click()
  await page.waitForTimeout(1200)
  eq((await page.locator('thead th').nth(1).innerText()).trim(), 'INR', 'it did not switch back:')
})

await check('the column menu is not clipped by the table it belongs to', async () => {
  // The table sits in a card with overflow-x-auto, which clips an absolutely
  // positioned child. The menu is portalled to the body precisely so a long
  // list is scrollable rather than cut off at the card's edge.
  await page.locator('th button[aria-label^="Options for"]').first().click({ force: true })
  await page.waitForSelector('text=Currency')
  const shape = await page.evaluate(() => {
    const p = [...document.querySelectorAll('p')].find((e) => e.textContent === 'Currency')
    const menu = p.closest('div.card')
    return { onBody: menu.parentElement === document.body, scrollable: menu.scrollHeight > menu.clientHeight }
  })
  ok(shape.onBody, 'the menu is still inside the clipping card')
  ok(shape.scrollable, 'the long menu is not scrollable')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
})

await check('dragging a row grip reorders the sheet', async () => {
  const titles = () =>
    page.locator('tbody tr[data-drag-index] input[aria-label="Title"]').evaluateAll((els) => els.map((e) => e.value))
  const before = await titles()
  ok(before.length >= 2, `need at least two rows to reorder, have ${before.length}`)

  const first = page.locator('tbody tr[data-drag-index]').first()
  const last = page.locator('tbody tr[data-drag-index]').nth(before.length - 1)
  await first.hover()
  const grip = await first.locator('span[aria-label^="Reorder row"]').boundingBox()
  const target = await last.boundingBox()
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2, target.y + target.height * 0.9, { steps: 12 })
  await page.waitForTimeout(150)
  await page.mouse.up()
  await page.waitForTimeout(800)

  const after = await titles()
  eq(after[after.length - 1], before[0], 'the dragged row did not land last:')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('tbody tr[data-drag-index]', { timeout: 15000 })
  eq((await titles())[before.length - 1], before[0], 'the new order did not persist:')
})

await check('the calculator computes, clears an entry separately from all, and drags', async () => {
  await page.locator('button:has-text("Calculator"):visible').first().click()
  const calc = page.locator('div[role=dialog][aria-label=Calculator]')
  await calc.waitFor({ state: 'visible', timeout: 5000 })
  const expr = calc.locator('input[aria-label=Expression]')

  for (const k of ['1', '2', '0', '0', '+', '3', '5']) await calc.locator(`button:text-is("${k}")`).click()
  await page.waitForTimeout(250)
  ok(/= 1,235/.test(await calc.innerText()), `wrong running result: ${(await calc.innerText()).replace(/\n/g, ' ')}`)

  await calc.locator('button:text-is("CE")').click()
  await page.waitForTimeout(150)
  eq(await expr.inputValue(), '1200+', 'CE cleared more than the current entry:')

  await calc.locator('button:text-is("AC")').click()
  await page.waitForTimeout(150)
  eq(await expr.inputValue(), '', 'AC did not clear the line:')

  const start = await calc.boundingBox()
  const header = await calc.locator('header').boundingBox()
  await page.mouse.move(header.x + 30, header.y + header.height / 2)
  await page.mouse.down()
  await page.mouse.move(header.x + 30 - 200, header.y + header.height / 2 - 150, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(250)
  const moved = await calc.boundingBox()
  ok(Math.abs(moved.x - (start.x - 200)) < 6 && Math.abs(moved.y - (start.y - 150)) < 6,
     `the panel did not follow the drag: ${Math.round(start.x)},${Math.round(start.y)} to ${Math.round(moved.x)},${Math.round(moved.y)}`)
  await calc.locator('button[aria-label="Close calculator"]').click()
})

await check('scrolling the assistant does not move the page behind it', async () => {
  const main = page.locator('main')
  const before = await main.evaluate((el) => el.scrollTop)
  await page.locator('aside:has-text("Assistant") .scroller').first().evaluate((el) => { el.scrollTop = 250 })
  await page.waitForTimeout(200)
  eq(await main.evaluate((el) => el.scrollTop), before, 'the sheet scrolled with the transcript:')
  eq(await page.evaluate(() => document.documentElement.scrollTop), 0, 'the document scrolled:')
})

const openRecents = async () => {
  await page.locator('button[title="Recent conversations"]:visible').first().click()
  const drawer = page.locator('div[role=dialog][aria-label="Recent conversations"]')
  await drawer.waitFor({ state: 'visible', timeout: 8000 })
  // The list arrives from a fetch. Wait for it to settle into one state or the
  // other, otherwise "is there a thread to rename?" is a race against the
  // response and the test silently skips half of what it claims to cover.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('div[role=dialog][aria-label="Recent conversations"]')
      return Boolean(el) && (el.querySelector('li') !== null || /No earlier conversations/.test(el.textContent ?? ''))
    },
    { timeout: 15000 },
  )
  return drawer
}

await check('recents slides in at the panel width and back out', async () => {
  const drawer = await openRecents()
  const panel = await page.locator('aside:has-text("Assistant")').last().boundingBox()
  const box = await drawer.boundingBox()
  ok(Math.abs(box.width - panel.width) < 2, `the drawer is ${box.width}px inside a ${panel.width}px panel`)

  await page.locator('button[aria-label="Back to the conversation"]:visible').first().click()
  await page.waitForTimeout(300)
  eq(await drawer.count(), 0, 'the drawer did not close:')
})

await check('a conversation can be renamed, and the name sticks', async () => {
  const drawer = await openRecents()
  // The assistant section above sent messages, so this thread exists.
  eq(await drawer.locator('li').count() > 0, true, 'no conversation was listed to rename:')

  const name = `Renamed ${Date.now().toString(36)}`
  await drawer.locator('li').first().hover()
  await drawer.locator('button[aria-label^="Rename"]').first().click()
  const field = drawer.locator('input[aria-label="Conversation name"]')
  await field.fill(name)
  await field.press('Enter')
  await page.waitForTimeout(700)
  ok((await drawer.innerText()).includes(name), `the new name is not listed:\n${await drawer.innerText()}`)

  // Close, reopen, and let the list come back from the server.
  await page.locator('button[aria-label="Back to the conversation"]:visible').first().click()
  await page.waitForTimeout(300)
  const again = await openRecents()
  ok((await again.innerText()).includes(name), 'the rename did not survive a refetch of the list')

  await page.locator('button[aria-label="Back to the conversation"]:visible').first().click()
  await page.waitForTimeout(300)
})

await check('dropping a file on the assistant attaches it', async () => {
  const panel = page.locator('aside:has-text("Assistant")').last()
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['Date,Amount\n2025-10-04,4820\n'], 'statement.csv', { type: 'text/csv' }))
    return dt
  })
  // Dispatch on a descendant: the handlers live on the panel's own root div,
  // which is a child of this <aside>, and events bubble up rather than down.
  const inner = panel.locator('.scroller').first()
  await inner.dispatchEvent('dragenter', { dataTransfer: data })
  await page.waitForTimeout(250)
  ok(/Drop to attach/.test(await panel.innerText()), 'no drop target appeared')
  await inner.dispatchEvent('drop', { dataTransfer: data })
  await page.waitForTimeout(1500)
  ok(/statement\.csv/.test(await panel.innerText()), `the file was not attached:\n${await panel.innerText().then((t) => t.slice(-200))}`)
})

await check('the mail dialog previews an aligned grid and follows the column choice', async () => {
  await page.locator('button:has-text("Mail"):visible').first().click()
  const dialog = page.locator('dialog[open]')
  await dialog.waitFor({ state: 'visible', timeout: 8000 })

  const preview = dialog.locator('pre')
  const before = await preview.innerText()
  ok(/INR/.test(before), `the preview has no amount column:\n${before}`)

  // The invariant the whole layout exists for: one grid, and no line wider
  // than the rule that draws it.
  const lines = before.split('\n')
  const rule = lines.find((l) => /^-{3,}/.test(l.trim()))
  ok(rule, `the preview has no rule under its header:\n${before}`)
  const width = rule.length
  for (const line of lines) {
    ok(line.length <= width || !rule, `a line runs past the grid: ${JSON.stringify(line)}`)
  }

  // Every column chip is a real filter.
  const chips = dialog.locator('button[aria-pressed=true]')
  const last = chips.last()
  const name = (await last.innerText()).trim()
  await last.click()
  await page.waitForTimeout(350)
  const after = await preview.innerText()
  ok(!after.split('\n')[0].includes(name), `"${name}" is still in the table after being switched off`)
  ok(after !== before, 'the preview did not react to the column choice')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  eq(await page.locator('dialog[open]').count(), 0, 'the mail dialog did not close:')
})

await page.screenshot({ path: `${SHOTS}/04-gestures.png`, fullPage: false })

log('\nMobile layout')
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
})
const mobile = await phone.newPage()
mobile.setDefaultTimeout(20_000)
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
await check('the rows come before the summary on one column', async () => {
  // The rail used to be ordered above the ledger, so opening a file on a phone
  // showed a gauge, four statistics and a date picker before a single row.
  const rowTop = await mobile.locator('input[aria-label="INR"]:visible').first()
    .evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
  const gaugeTop = await mobile.locator('text=This file').first()
    .evaluate((el) => el.getBoundingClientRect().top + window.scrollY)
  ok(rowTop < gaugeTop, `the summary (${Math.round(gaugeTop)}) sits above the first row (${Math.round(rowTop)})`)
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
await check('the header carries the running total, not the folder name', async () => {
  const header = await mobile.locator('header').first().innerText()
  ok(/₹/.test(header), `no total in the phone header: ${JSON.stringify(header)}`)
  ok(/row/.test(header), `no row count in the phone header: ${JSON.stringify(header)}`)
})

await check('columns can be added from a phone', async () => {
  // This is the mechanism the file model rests on, and until the columns
  // manager existed it was reachable only from a table header no phone renders.
  await mobile.locator('button:has-text("Columns")').first().click()
  const dialog = mobile.locator('dialog[open]')
  await dialog.waitFor({ state: 'visible', timeout: 8000 })
  ok(/INR/.test(await dialog.innerText()), 'the columns manager does not list the columns')

  await dialog.locator('button:has-text("Add column")').click()
  await mobile.waitForSelector('#col-name', { timeout: 8000 })
  const name = `Phone ${Date.now().toString(36).slice(-4)}`
  await mobile.fill('#col-name', name)
  await mobile.locator('dialog[open] button:has-text("Add column")').last().click()
  await mobile.waitForTimeout(2200)

  await mobile.reload({ waitUntil: 'networkidle' })
  await mobile.waitForTimeout(1500)
  await mobile.locator('button:has-text("Columns")').first().click()
  await mobile.locator('dialog[open]').waitFor({ state: 'visible', timeout: 8000 })
  ok((await mobile.locator('dialog[open]').innerText()).includes(name), 'the column added from the phone did not persist')
  await mobile.keyboard.press('Escape')
  await mobile.waitForTimeout(300)
})

await check('the rest of the file actions live behind one sheet', async () => {
  await mobile.locator('button:has-text("More")').first().click()
  const dialog = mobile.locator('dialog[open]')
  await dialog.waitFor({ state: 'visible', timeout: 8000 })
  const text = await dialog.innerText()
  for (const action of ['Mail', 'Copy', 'PDF', 'CSV', 'Discard']) {
    ok(text.includes(action), `"${action}" is not reachable from a phone: ${JSON.stringify(text)}`)
  }
  await mobile.keyboard.press('Escape')
  await mobile.waitForTimeout(300)
})

await check('the assistant fills the screen and leaves by a back arrow', async () => {
  await mobile.locator('button[aria-label=Assistant]').first().click()
  const panel = mobile.locator('aside[aria-label=Assistant]')
  await panel.waitFor({ state: 'visible', timeout: 8000 })

  const box = await panel.boundingBox()
  const view = mobile.viewportSize()
  ok(box.height >= view.height - 2, `the assistant is ${Math.round(box.height)}px in a ${view.height}px screen`)
  ok(box.width >= view.width - 2, `the assistant is ${Math.round(box.width)}px in a ${view.width}px screen`)

  const back = panel.locator('button[aria-label="Close assistant"]:visible')
  eq(await back.count(), 1, 'expected exactly one visible dismiss control:')
  const backBox = await back.boundingBox()
  ok(backBox.height >= 38, `the dismiss control is only ${Math.round(backBox.height)}px tall`)

  await back.click()
  await mobile.waitForTimeout(400)
  eq(await mobile.locator('aside[aria-label=Assistant]').count(), 0, 'the assistant did not close:')
})

await check('the controls a thumb has to hit are big enough to hit', async () => {
  const targets = await mobile.evaluate(() => {
    const small = []
    for (const el of document.querySelectorAll('button, input[type=checkbox], select')) {
      const style = getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      // Checkboxes get their target from the padding around them; judge the
      // things people aim at deliberately.
      if (el.tagName === 'INPUT') continue
      if (r.height < 32) small.push(`${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24)} (${Math.round(r.height)}px)`)
    }
    return small
  })
  ok(targets.length === 0, `controls under 32px tall on a phone: ${targets.join(', ')}`)
})

await check('an amount cell is editable by touch', async () => {
  // The desktop table is display:none but still in the DOM, so its inputs
  // would match first - scope to what is actually on screen.
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
