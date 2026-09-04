/**
 * Engine tests — the concurrency and merge claims, checked rather than asserted.
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
const { invertOp } = await import('../src/lib/crdt/ops.ts')

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
check('appends stay short — 1000 rows, keys under 6 chars', () => {
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

console.log('\nIdempotency — the retry story')
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

console.log('\nLast-writer-wins — human vs agent')
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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1) }
