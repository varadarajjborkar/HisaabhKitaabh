/**
 * Engine tests - the concurrency and merge claims, checked rather than asserted.
 * Run with: node --experimental-strip-types tests/engine.test.mjs
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

let pass = 0, fail = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ok   ${name}`)
  } catch (err) {
    fail++
    failures.push(`${name}: ${err.message}`)
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`)
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy') }

const { newSheet, applyOps, computeTotals, liveRows, parseAmount, checkRev, SYSTEM_COLUMNS } =
  await import('../src/lib/crdt/doc.ts')
const { orderBetween, orderAfter, sortByOrder } = await import('../src/lib/util/order.ts')
const { toEmail, toPlainText, buildGrid } = await import('../src/lib/util/export.ts')
const { displayWidth, graphemes, layoutTable, padTo, wrapCell } = await import('../src/lib/util/textTable.ts')
const { invertOp } = await import('../src/lib/crdt/ops.ts')
const { currencyCode, describeConversion } = await import('../src/lib/util/currency.ts')

const base = () => newSheet({ folderId: 'f1', ownerId: 'u1', name: 'Test' })
const A = SYSTEM_COLUMNS.amount, T = SYSTEM_COLUMNS.title

let n = 0
const op = (o) => ({ id: `op${++n}`, ...o })

console.log('\nAmount parsing')
check('plain number', () => eq(parseAmount('450'), 450))
check('indian grouping', () => eq(parseAmount('1,20,450.50'), 120450.5))
check('rupee symbol', () => eq(parseAmount('₹ 2,300'), 2300))
check('k suffix', () => eq(parseAmount('1.2k'), 1200))
check('lakh suffix', () => eq(parseAmount('2L'), 200000))
check('crore suffix', () => eq(parseAmount('1.5c'), 15000000))
check('parenthesised negative', () => eq(parseAmount('(300)'), -300))
check('garbage is NaN not zero', () => ok(Number.isNaN(parseAmount('abc')), 'should be NaN'))
check('empty is NaN not zero', () => ok(Number.isNaN(parseAmount('')), 'should be NaN'))

console.log('\nFractional ordering')
check('midpoint sorts between', () => {
  const m = orderBetween('a0', 'a1')
  ok(m > 'a0' && m < 'a1', `${m} not between a0 and a1`)
})
check('adjacent integer parts split', () => {
  const m = orderBetween('a0', 'b0')
  ok(m > 'a0' && m < 'b0', `${m} not between a0 and b0`)
})
check('open start', () => ok(orderBetween(null, 'a1') < 'a1'))
check('open end', () => ok(orderBetween('a0', null) > 'a0'))
check('first key of an empty list', () => eq(orderBetween(null, null), 'a0'))
check('appends stay short - 1000 rows, keys under 6 chars', () => {
  let prev = null
  let maxLen = 0
  for (let i = 0; i < 1000; i++) {
    const k = orderAfter(prev)
    ok(prev === null || k > prev, `append ${i} did not increase: ${prev} -> ${k}`)
    maxLen = Math.max(maxLen, k.length)
    prev = k
  }
  ok(maxLen < 6, `keys grew to ${maxLen} characters`)
})
check('repeated insert at the same slot always lands between', () => {
  let lo = 'a0', hi = 'a1'
  for (let i = 0; i < 60; i++) {
    const m = orderBetween(lo, hi)
    ok(m > lo && m < hi, `iteration ${i}: ${m} not strictly between ${lo} and ${hi}`)
    hi = m
  }
})
check('insert at the head repeatedly stays ordered', () => {
  let first = 'a0'
  for (let i = 0; i < 40; i++) {
    const m = orderBetween(null, first)
    ok(m < first, `iteration ${i}: ${m} not before ${first}`)
    first = m
  }
})
check('concurrent inserts at the same slot tie, and the id breaks it', () => {
  const x = orderBetween('a0', 'a1'), y = orderBetween('a0', 'a1')
  eq(x, y, 'keys should be deterministic:')
  const sorted = sortByOrder([{ id: 'r2', order: x }, { id: 'r1', order: y }])
  eq(sorted.map((r) => r.id), ['r1', 'r2'], 'tiebreak was not by id:')
})
check('a malformed neighbour does not block an insert', () => {
  const m = orderBetween('!!bogus!!', null)
  ok(typeof m === 'string' && m.length > 0, 'fallback produced nothing')
  ok(m > '!!bogus!!', 'fallback key does not sort after its predecessor')
})

console.log('\nOperation application')
check('insert then set', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: A, value: 450 })] }).doc
  eq(computeTotals(d).total, 450)
})
check('rev increments only when something applied', () => {
  let d = base()
  const r1 = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] })
  eq(r1.doc.rev, 1)
  const r2 = applyOps(r1.doc, { actor: 'u1', ops: [] })
  eq(r2.doc.rev, 1, 'empty batch bumped rev:')
})
check('amount coerced from string', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: A, value: '1.2k' })] }).doc
  eq(computeTotals(d).total, 1200)
})
check('cell.set on missing row is rejected, not silently dropped', () => {
  const d = base()
  const r = applyOps(d, { actor: 'u1', ops: [op({ type: 'cell.set', rowId: 'nope', columnId: A, value: 1 })] })
  eq(r.rejected.length, 1)
  eq(r.applied.length, 0)
})
check('system column cannot be deleted', () => {
  const r = applyOps(base(), { actor: 'u1', ops: [op({ type: 'column.delete', columnId: A })] })
  eq(r.rejected.length, 1)
})

console.log('\nIdempotency - the retry story')
check('duplicate op id is dropped', () => {
  let d = base()
  const dup = { id: 'same', type: 'row.insert', rowId: 'r1', order: 'a0' }
  d = applyOps(d, { actor: 'u1', ops: [dup] }).doc
  const second = applyOps(d, { actor: 'u1', ops: [dup] })
  eq(second.duplicates, ['same'])
  eq(liveRows(second.doc).length, 1, 'retry created a second row:')
})
check('same rowId inserted twice collapses', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'b0' })] }).doc
  eq(liveRows(d).length, 1, 'duplicate rowId created two rows:')
})
check('replayed batch of 50 adds 50 rows once', () => {
  let d = base()
  const batch = Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, type: 'row.insert', rowId: `r${i}`, order: `a${i}` }))
  d = applyOps(d, { actor: 'u1', ops: batch }).doc
  d = applyOps(d, { actor: 'u1', ops: batch }).doc
  eq(liveRows(d).length, 50)
})

console.log('\nLast-writer-wins - human vs agent')
check('higher lamport wins', () => {
  let d = base()
  d = applyOps(d, { actor: 'human', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  d = applyOps(d, { actor: 'human', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: A, value: 100 })] }).doc
  d = applyOps(d, { actor: 'ai:u1', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: A, value: 200 })] }).doc
  eq(computeTotals(d).total, 200, 'later write did not win:')
})
check('writes to different fields both survive', () => {
  let d = base()
  d = applyOps(d, { actor: 'human', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  d = applyOps(d, { actor: 'human', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: A, value: 500 })] }).doc
  d = applyOps(d, { actor: 'ai:u1', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: T, value: 'Cab' })] }).doc
  const row = liveRows(d)[0]
  eq(row.cells[A], 500, 'agent write clobbered the amount:')
  eq(row.cells[T], 'Cab')
})
check('delete then concurrent edit does not resurrect', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.delete', rowId: 'r1' })] }).doc
  d = applyOps(d, { actor: 'ai', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: A, value: 999 })] }).doc
  eq(liveRows(d).length, 0, 'a deleted row came back:')
  eq(computeTotals(d).total, 0, 'a deleted row still counted:')
})

console.log('\nRevision gate')
check('same rev passes', () => {
  const d = applyOps(base(), { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  eq(checkRev(d, { baseRev: d.rev, actor: 'u1', ops: [] }, []).ok, true)
})
check('stale rev touching an untouched field is allowed to merge', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  const remote = applyOps(d, { actor: 'other', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: T, value: 'theirs' })] })
  const gate = checkRev(remote.doc, { baseRev: d.rev, actor: 'u1', ops: [{ id: 'x', type: 'cell.set', rowId: 'r1', columnId: A, value: 5 }] }, remote.applied)
  eq(gate.ok, true, 'a non-overlapping edit was rejected:')
})
check('stale rev touching the SAME field is refused', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0' })] }).doc
  const remote = applyOps(d, { actor: 'other', ops: [op({ type: 'cell.set', rowId: 'r1', columnId: A, value: 111 })] })
  const gate = checkRev(remote.doc, { baseRev: d.rev, actor: 'u1', ops: [{ id: 'y', type: 'cell.set', rowId: 'r1', columnId: A, value: 222 }] }, remote.applied)
  eq(gate.ok, false, 'an overlapping edit was allowed through:')
})
check('client ahead of server is refused', () => {
  const d = base()
  eq(checkRev(d, { baseRev: 99, actor: 'u1', ops: [] }, []).ok, false)
})

console.log('\nUndo')
check('inverse of cell.set restores prior value', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0', cells: { [A]: 100 } })] }).doc
  const edit = op({ type: 'cell.set', rowId: 'r1', columnId: A, value: 900 })
  const inv = invertOp(edit, { rows: d.rows, columns: d.columns, name: d.name, duration: d.duration }, () => 'inv1')
  d = applyOps(d, { actor: 'u1', ops: [edit] }).doc
  eq(computeTotals(d).total, 900)
  d = applyOps(d, { actor: 'u1', ops: [inv] }).doc
  eq(computeTotals(d).total, 100, 'undo did not restore:')
})
check('inverse of row.delete restores the row', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0', cells: { [A]: 250 } })] }).doc
  const delOp = op({ type: 'row.delete', rowId: 'r1' })
  const inv = invertOp(delOp, { rows: d.rows, columns: d.columns, name: d.name, duration: d.duration }, () => 'inv2')
  d = applyOps(d, { actor: 'u1', ops: [delOp] }).doc
  eq(liveRows(d).length, 0)
  d = applyOps(d, { actor: 'u1', ops: [inv] }).doc
  eq(computeTotals(d).total, 250, 'undo of delete lost the data:')
})

console.log('\nTotals')
check('quantity never multiplies the amount', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'column.insert', column: { id: 'c_q', name: 'Quantity', kind: 'number', order: 'd0' } })] }).doc
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.insert', rowId: 'r1', order: 'a0', cells: { [A]: 240, c_q: 3 } })] }).doc
  eq(computeTotals(d).total, 240, 'quantity multiplied into the total:')
})
check('deleted rows excluded from total', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [
    op({ type: 'row.insert', rowId: 'r1', order: 'a0', cells: { [A]: 100 } }),
    op({ type: 'row.insert', rowId: 'r2', order: 'b0', cells: { [A]: 200 } }),
  ] }).doc
  d = applyOps(d, { actor: 'u1', ops: [op({ type: 'row.delete', rowId: 'r1' })] }).doc
  eq(computeTotals(d).total, 200)
  eq(computeTotals(d).count, 1)
})
check('negative amounts subtract', () => {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [
    op({ type: 'row.insert', rowId: 'r1', order: 'a0', cells: { [A]: 500 } }),
    op({ type: 'row.insert', rowId: 'r2', order: 'b0', cells: { [A]: -100 } }),
  ] }).doc
  eq(computeTotals(d).total, 400)
})
check('1000 rows sum correctly and stay ordered', () => {
  let d = base()
  let order = null
  const ops = []
  for (let i = 0; i < 1000; i++) {
    order = orderAfter(order)
    ops.push({ id: `m${i}`, type: 'row.insert', rowId: `r${i}`, order, cells: { [A]: 10 } })
  }
  d = applyOps(d, { actor: 'u1', ops }).doc
  eq(computeTotals(d).total, 10000)
  const rows = liveRows(d)
  eq(rows.length, 1000)
  ok(rows[0].id === 'r0' && rows[999].id === 'r999', 'ordering broke at scale')
})

console.log('\nText grid')

/**
 * The alignment invariant, checked directly.
 *
 * A grid is aligned if and only if every column occupies the same span of
 * character cells on every physical line - including the continuation lines a
 * wrapped value produces. So rather than eyeballing the output, this walks each
 * line by display column and asserts that the positions between columns hold
 * nothing but spaces. If any value ever bled into its neighbour's span, a
 * non-space would turn up in a gap.
 *
 * Display column, not string index: a CJK glyph is one character and two cells,
 * and counting by index is exactly the bug this is here to catch.
 */
function gapPositions(widths, gap) {
  const gaps = new Set()
  let at = 0
  for (let i = 0; i < widths.length; i++) {
    at += widths[i]
    if (i < widths.length - 1) {
      for (let g = 0; g < gap; g++) gaps.add(at + g)
      at += gap
    }
  }
  return gaps
}

function assertAligned(lines, widths, gap = 2) {
  const gaps = gapPositions(widths, gap)
  const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1)
  for (const line of lines) {
    if (displayWidth(line) > total) throw new Error(`line is ${displayWidth(line)} cells, grid is ${total}: ${JSON.stringify(line)}`)
    let col = 0
    for (const g of graphemes(line)) {
      const w = displayWidth(g)
      for (let c = col; c < col + w; c++) {
        if (gaps.has(c) && g !== ' ') {
          throw new Error(`"${g}" sits in the gap at column ${c}: ${JSON.stringify(line)}`)
        }
      }
      col += w
    }
  }
}

check('a wide character counts as two cells and a combining mark as none', () => {
  eq(displayWidth('abc'), 3)
  eq(displayWidth('日本語'), 6)
  eq(displayWidth('é'), 1)      // e + combining acute
  eq(displayWidth('₹1,234'), 6)
})

check('padding reaches the requested cell width, not string length', () => {
  eq(displayWidth(padTo('日本', 8, 'left')), 8)
  eq(displayWidth(padTo('₹95', 8, 'right')), 8)
  eq(padTo('ab', 5, 'right'), '   ab')
})

check('wrapping breaks on words and hard-splits a word that cannot fit', () => {
  eq(wrapCell('one two three', 9), ['one two', 'three'])
  eq(wrapCell('supercalifragilistic', 8), ['supercal', 'ifragili', 'stic'])
  eq(wrapCell('', 8), [''])
})

check('a table stays inside its budget and keeps every column in its own span', () => {
  const lines = layoutTable([
    { header: 'INR', align: 'right', noWrap: true, cells: ['4,820', '1,28,000', '95'] },
    { header: 'Title', align: 'left', cells: ['Train tickets', 'Supercalifragilisticexpialidocious', '日本のコーヒー'] },
    { header: 'Extra Captions', align: 'left', cells: ['Return, sleeper class', '-', 'Kyoto in the rain, twice over'] },
  ], { maxWidth: 60, gap: 2, footer: ['1,32,915', 'TOTAL', ''] })
  const rule = lines.find((l) => /^-/.test(l))
  const widths = rule.split('  ').map((r) => r.length)
  assertAligned(lines, widths)
  ok(displayWidth(rule) <= 60, `the grid is ${displayWidth(rule)} cells against a 60 budget`)
})

check('a number column is never wrapped, however narrow the budget', () => {
  const lines = layoutTable([
    { header: 'INR', align: 'right', noWrap: true, cells: ['1,28,000'] },
    { header: 'Title', align: 'left', cells: ['A rather long description of the thing'] },
  ], { maxWidth: 20, gap: 2 })
  ok(lines.some((l) => l.includes('1,28,000')), 'the amount was broken up')
  eq(lines.filter((l) => /1,28,000/.test(l)).length, 1, 'the amount appears on more than one line:')
})

console.log('\nExport rendering')

function sampleDoc() {
  let d = base()
  d = applyOps(d, { actor: 'u1', ops: [
    { id: 'e1', type: 'column.insert', column: { id: 'c_qty', name: 'Quantity', kind: 'number', order: 'zz1' } },
    { id: 'e2', type: 'row.insert', rowId: 'x1', order: 'a1', cells: { [A]: 4820, [T]: 'Train tickets', c_qty: 2 } },
    { id: 'e3', type: 'row.insert', rowId: 'x2', order: 'a2', cells: { [A]: 1250, [T]: '日本のホテル 🏨 with a caption long enough to need wrapping' } },
    { id: 'e4', type: 'doc.duration', duration: { enabled: true, mode: 'date', from: '2025-10-04', to: '2025-10-09' } },
  ] }).doc
  return d
}

check('the mail body is a grid: INR, then Title, then the rest', () => {
  const { body } = toEmail(sampleDoc())
  const lines = body.split('\n')
  const header = lines.find((l) => /INR/.test(l))
  ok(header, `no header row:\n${body}`)
  ok(header.indexOf('INR') < header.indexOf('Title'), `columns are out of order: ${header}`)
  ok(/^\s*INR/.test(header), 'the amount column is not first')
})

check('every line of the mail grid respects the column spans', () => {
  const grid = buildGrid(sampleDoc())
  const rule = grid.find((l) => /^-/.test(l))
  const widths = rule.split('  ').map((r) => r.length)
  assertAligned(grid, widths)
})

check('the mail grid fits a mail window', () => {
  const grid = buildGrid(sampleDoc())
  const widest = Math.max(...grid.map(displayWidth))
  ok(widest <= 72, `the grid is ${widest} cells wide`)
})

check('choosing columns changes what the grid holds', () => {
  const doc = sampleDoc()
  const all = toEmail(doc).body
  ok(all.includes('Quantity'), 'the full table is missing a column')
  const narrow = toEmail(doc, { columnIds: [A, T] }).body
  ok(!narrow.includes('Quantity'), `an excluded column is still in the body:\n${narrow}`)
  ok(narrow.includes('Train tickets'), 'the kept columns lost their data')
})

check('an empty or stale column choice falls back to every column', () => {
  const doc = sampleDoc()
  ok(toEmail(doc, { columnIds: [] }).body.includes('Quantity'), 'an empty choice produced an empty table')
  ok(toEmail(doc, { columnIds: ['c_gone'] }).body.includes('Quantity'), 'a stale choice produced an empty table')
})

check('the total row sits under the amount column', () => {
  const grid = buildGrid(sampleDoc())
  const totalLine = grid[grid.length - 1]
  const header = grid[0]
  ok(/TOTAL/.test(totalLine), `no total row:\n${grid.join('\n')}`)
  // The amount column is right-aligned, so both figures end at the same cell.
  const amountEnd = header.indexOf('INR') + 3
  eq(totalLine.slice(0, amountEnd).trimEnd().length, amountEnd, 'the total does not end where the header does:')
})

check('the mail keeps the period, the count and the sign-off', () => {
  const { subject, body } = toEmail(sampleDoc())
  ok(subject.includes('4 Oct 2025') && subject.includes('9 Oct 2025'), `subject lost the period: ${subject}`)
  ok(body.includes('Rows: 2'), 'no row count')
  ok(body.includes('Period: 4 Oct 2025 to 9 Oct 2025'), 'no period line')
  ok(body.trimEnd().endsWith('made from HisaabhKitaabh'), `wrong sign-off:\n${body}`)
  // Written as an escape so the file that forbids the character does not
  // contain it, and a repo-wide grep for em dashes stays at zero.
  ok(!body.includes('\u2014'), 'an em dash survived into the draft')
})

check('the clipboard copy uses the same grid at a wider budget', () => {
  const text = toPlainText(sampleDoc(), { maxWidth: 100 })
  const lines = text.split('\n')
  const rule = lines.find((l) => /^-/.test(l))
  const widths = rule.split('  ').map((r) => r.length)
  assertAligned(lines.slice(lines.indexOf(rule) - 1), widths)
  ok(displayWidth(rule) > 40, 'the wider budget was ignored')
  ok(/TOTAL/.test(text), 'no total row')
})

// --------------------------------------------------------- currency codes

/*
 * Reading what people write.
 *
 * Nobody types ISO 4217. They type "$", "890 dollars", "aed", "Rs.". Getting
 * this wrong is worse than not converting at all, because the wrong rate is
 * applied silently to a number that goes into someone's accounts.
 */
console.log('\nCurrency codes')

check('a bare code is taken as written', () => {
  eq(currencyCode('USD'), 'USD')
  eq(currencyCode('inr'), 'INR')
  eq(currencyCode(' eur '), 'EUR')
})

check('symbols map to the currency people mean by them', () => {
  eq(currencyCode('$'), 'USD')
  eq(currencyCode('€'), 'EUR')
  eq(currencyCode('£'), 'GBP')
  eq(currencyCode('₹'), 'INR')
})

check('the names of currencies work too', () => {
  eq(currencyCode('dollars'), 'USD')
  eq(currencyCode('Rupees'), 'INR')
  eq(currencyCode('dirham'), 'AED')
  eq(currencyCode('yen'), 'JPY')
  eq(currencyCode('quid'), 'GBP')
})

check('punctuation around a code is ignored', () => {
  eq(currencyCode('USD.'), 'USD')
  eq(currencyCode('Rs.'), 'INR')
  eq(currencyCode('(gbp)'), 'GBP')
})

check('an unknown three-letter code is passed through, not guessed at', () => {
  // The rate lookup is what decides whether a code exists. Rejecting anything
  // not in the alias table would mean this file has to know all 160.
  eq(currencyCode('XYZ'), 'XYZ')
  eq(currencyCode('kes'), 'KES')
})

check('nonsense is rejected rather than turned into a currency', () => {
  eq(currencyCode(''), null)
  eq(currencyCode('   '), null)
  eq(currencyCode('a very long sentence'), null)
  eq(currencyCode('12'), null)
})

check('a conversion says where the number came from', () => {
  const note = describeConversion({
    original: 890,
    amount: 84096.1,
    rate: { from: 'USD', to: 'INR', rate: 94.49, asOf: '2026-09-04', source: 'European Central Bank' },
  })
  ok(note.includes('890'), 'the original amount is missing')
  ok(note.includes('USD'), 'the original currency is missing')
  ok(note.includes('94.49'), 'the rate is missing')
  ok(note.includes('2026-09-04'), 'the date the rate is from is missing')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
