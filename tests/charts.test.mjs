/**
 * The chart engine.
 *
 * Charts are the one part of this app where being wrong is invisible: a bar of
 * the wrong height still looks like a bar, and nobody checks a picture against
 * the arithmetic behind it. So the geometry is asserted as data - before any
 * SVG is written - which is the whole reason the renderer is split into a plot
 * builder that returns marks and a writer that turns marks into elements.
 *
 * Three properties are worth more than the rest:
 *   1. marks are proportional to the values they stand for
 *   2. nothing is drawn outside the canvas, at any width, for any data
 *   3. no input produces NaN geometry or an unparseable document
 */

import { buildPlot } from '../src/lib/charts/plot.ts'
import { renderChartSvg, renderChartFile } from '../src/lib/charts/svg.ts'
import { KINDS } from '../src/lib/charts/spec.ts'
import { linear, band, niceTicks, extent } from '../src/lib/charts/scale.ts'
import { barPath, hBarPath, arcPath } from '../src/lib/charts/marks.ts'
import { textWidth, truncate, wrap } from '../src/lib/charts/measure.ts'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${extra ? `  ${extra}` : ''}`)
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps
const group = (name) => console.log(`\n${name}`)

/** Pen tracking, so arc radii and sweep flags are never read as coordinates. */
function pathBounds(d) {
  let x = 0, y = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const see = () => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
  const toks = d.match(/[MLHVACZmlhvacz]|-?[\d.]+/g) ?? []
  let i = 0, cmd = ''
  while (i < toks.length) {
    if (/[A-Za-z]/.test(toks[i])) { cmd = toks[i]; i++; if (i >= toks.length) break }
    const num = () => parseFloat(toks[i++])
    switch (cmd) {
      case 'M': case 'L': x = num(); y = num(); see(); break
      case 'm': case 'l': x += num(); y += num(); see(); break
      case 'H': x = num(); see(); break
      case 'V': y = num(); see(); break
      case 'h': x += num(); see(); break
      case 'v': y += num(); see(); break
      case 'a': i += 5; x += num(); y += num(); see(); break
      case 'A': i += 5; x = num(); y = num(); see(); break
      case 'C': i += 4; x = num(); y = num(); see(); break
      case 'c': i += 4; x += num(); y += num(); see(); break
      case 'Z': case 'z': break
      default: i++
    }
  }
  return minX === Infinity ? null : [minX, minY, maxX, maxY]
}

function markBounds(m) {
  switch (m.m) {
    case 'rect': return [m.x, m.y, m.x + m.w, m.y + m.h]
    case 'circle': return [m.cx - m.r, m.cy - m.r, m.cx + m.r, m.cy + m.r]
    case 'line': return [Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.max(m.x1, m.x2), Math.max(m.y1, m.y2)]
    case 'path': return pathBounds(m.d)
    case 'text': {
      const w = textWidth(m.s, m.size, m.weight ?? 400)
      if (m.rotate) {
        const a = (m.rotate * Math.PI) / 180
        const xs = [m.x, m.x - Math.cos(a) * w]
        const ys = [m.y, m.y + Math.sin(a) * w]
        return [Math.min(...xs), Math.min(...ys) - m.size, Math.max(...xs), Math.max(...ys) + m.size * 0.3]
      }
      const x0 = m.anchor === 'end' ? m.x - w : m.anchor === 'middle' ? m.x - w / 2 : m.x
      return [x0, m.y - m.size, x0 + w, m.y + m.size * 0.3]
    }
    default: return null
  }
}

const spec = (over = {}) => ({
  kind: 'column',
  title: 'Travel: Goa vs Bangalore',
  currency: 'INR',
  metric: 'sum',
  points: [
    { key: 'Goa', total: 18400, count: 12, parts: { Cabs: 3200, Food: 4200, Hotel: 6000, Flights: 5000 } },
    { key: 'Bangalore', total: 9600, count: 9, parts: { Cabs: 4600, Food: 2600, Hotel: 1400, Flights: 1000 } },
    { key: 'Mumbai', total: 6100, count: 7, parts: { Cabs: 2100, Food: 1800, Hotel: 1200, Flights: 1000 } },
    { key: 'Lama Max subscription', total: 3900, count: 4, parts: { Cabs: 900, Food: 1200, Hotel: 900, Flights: 900 } },
    { key: 'Delhi', total: 2400, count: 3, parts: { Cabs: 800, Food: 700, Hotel: 500, Flights: 400 } },
  ],
  series: ['Cabs', 'Food', 'Hotel', 'Flights'],
  values: [120, 240, 300, 450, 500, 700, 900, 1200, 1800, 2600, 3400, 5000, 6000],
  note: 'totals from 3 files, all 35 rows, grouped by file, split by category.',
  matchedRows: 35,
  scannedRows: 35,
  ...over,
})

group('Marks span exactly the box they are given')
for (const [w, h, r] of [[40, 200, 4], [40, 6, 4], [10, 3, 4], [100, 50, 0]]) {
  const b = pathBounds(barPath(0, 0, w, h, r))
  ok(`barPath ${w}x${h}`, near(b[2] - b[0], w, 0.05) && near(b[3] - b[1], h, 0.05), JSON.stringify(b))
}
for (const [w, h, r] of [[200, 20, 4], [3, 20, 4], [300, 26, 4]]) {
  const b = pathBounds(hBarPath(0, 0, w, h, r))
  ok(`hBarPath ${w}x${h}`, near(b[2] - b[0], w, 0.05) && near(b[3] - b[1], h, 0.05), JSON.stringify(b))
}
ok('a full turn does not collapse to nothing', arcPath(50, 50, 40, 20, 0, Math.PI * 2).length > 80)

group('Marks are proportional to their values')
{
  const p = buildPlot(spec(), { width: 720, height: 400 })
  const heights = p.marks.filter((m) => m.m === 'path' && m.fill).map((m) => { const b = pathBounds(m.d); return b[3] - b[1] })
  ok('column heights hold the 18400:2400 ratio', near(heights[0] / heights[4], 18400 / 2400, 0.2), `got ${(heights[0] / heights[4]).toFixed(3)}`)
}
{
  const p = buildPlot(spec({ kind: 'bar' }), { width: 720 })
  const widths = p.marks.filter((m) => m.m === 'path').map((m) => { const b = pathBounds(m.d); return b[2] - b[0] })
  ok('bar widths hold the same ratio', near(widths[0] / widths[4], 18400 / 2400, 0.5), `got ${(widths[0] / widths[4]).toFixed(3)}`)
}
{
  const s = spec({ kind: 'stacked', series: ['A', 'B'], points: [
    { key: 'Goa', total: 1000, count: 2, parts: { A: 750, B: 250 } },
    { key: 'Bangalore', total: 400, count: 2, parts: { A: 100, B: 300 } },
  ] })
  const rects = buildPlot(s, { width: 720, height: 400 }).marks.filter((m) => m.m === 'rect' && m.h > 1 && m.w > 10)
  ok('stacked draws one segment per part', rects.length === 4, String(rects.length))
  ok('segments within a bar are 3:1', near(rects[0].h / rects[1].h, 3, 0.05))
  ok('bars against each other are 2.5:1', near((rects[0].h + rects[1].h) / (rects[2].h + rects[3].h), 2.5, 0.05))
}
{
  // Normalising is only legal when there is a breakdown to normalise; without
  // one this used to plot raw totals against a 0-to-1 axis.
  const s = spec({ kind: 'stacked100', series: ['A'], points: [{ key: 'Only', total: 500, count: 1, parts: { A: 500 } }] })
  const p = buildPlot(s, { width: 400, height: 300 })
  ok('stacked100 degrades safely to one series', p.marks.every((m) => markBounds(m) === null || markBounds(m)[1] > -50))
}

group('Nothing is drawn outside the canvas')
{
  const variants = [
    spec(),
    spec({ points: spec().points.map((p) => ({ ...p, key: `${p.key} a much longer label than anyone would type` })) }),
    spec({ points: Array.from({ length: 12 }, (_, i) => ({ key: `Category number ${i} with words`, total: (i + 1) * 900, count: i + 1, parts: { Cabs: i * 100, Food: i * 80, Hotel: i * 60, Flights: i * 40 } })) }),
    spec({ points: [{ key: 'Only one', total: 500, count: 1, parts: { Cabs: 500 } }], series: ['Cabs'] }),
    spec({ points: [{ key: 'a', total: 0, count: 0 }, { key: 'b', total: 0, count: 0 }] }),
    spec({ points: [{ key: 'a', total: -500, count: 1 }, { key: 'b', total: 900, count: 2 }] }),
  ]
  let outside = 0
  let checked = 0
  for (const width of [300, 380, 520, 720, 1000]) {
    for (const k of KINDS) {
      for (const v of variants) {
        const p = buildPlot({ ...v, kind: k.value }, { width, showTitle: true, showNote: true })
        for (const m of p.marks) {
          const b = markBounds(m)
          if (!b) continue
          checked++
          if (b[0] < -1 || b[1] < -1 || b[2] > p.width + 1 || b[3] > p.height + 1) {
            outside++
            if (outside <= 5) console.log(`        ${k.value}@${width}`, m.m, m.s ?? '', JSON.stringify(b.map(Math.round)), `canvas ${p.width}x${p.height}`)
          }
        }
      }
    }
  }
  ok(`${checked} marks all inside their canvas`, outside === 0, `${outside} outside`)
}

group('Every kind survives every shape of data')
{
  const variants = [
    spec(),
    spec({ series: undefined, values: undefined, points: [{ key: 'Solo', total: 500, count: 1 }] }),
    spec({ points: Array.from({ length: 60 }, (_, i) => ({ key: `k${i}`, total: i * 13 + 1, count: i })) }),
    spec({ points: [] }),
    spec({ currency: null }),
    spec({ metric: 'count' }),
  ]
  for (const k of KINDS) {
    for (const v of variants) {
      let threw = null
      let svg = ''
      try {
        const p = buildPlot({ ...v, kind: k.value }, { width: 640, height: 380, showTitle: true, showNote: true })
        ok(`${k.value}: no NaN geometry`, !p.marks.some((m) => Object.values(m).some((x) => typeof x === 'number' && !isFinite(x))))
        svg = renderChartSvg({ ...v, kind: k.value }, { width: 640, height: 380, showTitle: true, showNote: true })
      } catch (e) { threw = e }
      ok(`${k.value}: does not throw`, threw === null, threw?.message)
      if (!threw) {
        ok(`${k.value}: writes a closed document`, svg.startsWith('<svg') && svg.endsWith('</svg>'))
        ok(`${k.value}: no NaN or undefined in the output`, !/NaN|undefined|Infinity/.test(svg))
      }
    }
  }
}

group('The document is valid XML with no external reference')
{
  const svg = renderChartFile(spec({ title: 'Books & "Lunch" <tagged>' }), { width: 900 })
  // The failure this guards against is silent: one stray quote closes an
  // attribute early, the document stops parsing, and an <img> pointed at it
  // simply never fires load. Scan the opening tag only, past the declaration.
  const opening = svg.slice(svg.indexOf('<svg'), svg.indexOf('>', svg.indexOf('<svg')) + 1)
  const quotes = (opening.match(/"/g) ?? []).length
  ok('the opening tag has balanced attribute quotes', quotes % 2 === 0, opening)
  ok('no attribute value holds a raw double quote', !/=\"[^\"]*\"[a-zA-Z]/.test(opening), opening)
  ok('the title is escaped', svg.includes('&amp;') && svg.includes('&quot;') && svg.includes('&lt;'))
  ok('no stylesheet, font file or external image is referenced', !/(<link|@import|url\(|xlink:href|<image)/.test(svg))
  ok('the font stack quotes its multi-word family with apostrophes', svg.includes("'Segoe UI'"))
  // Every tag that opens must close: a malformed document loads as nothing.
  const opens = (svg.match(/<(svg|text|title)\b/g) ?? []).length
  const closes = (svg.match(/<\/(svg|text|title)>/g) ?? []).length
  ok('every element is closed', opens === closes, `${opens} open, ${closes} closed`)
}

group('Scales')
ok('linear maps the midpoint', near(linear([0, 100], [0, 200]).map(50), 100))
ok('a flat domain does not divide by zero', isFinite(linear([5, 5], [0, 100]).map(5)))
ok('band splits its range evenly', near(band(['a', 'b'], [0, 100], 0).step, 50))
ok('extent pins the floor at zero', extent([450, 18735])[0] === 0)
ok('ticks carry no floating point dust', niceTicks(0, 1, 5).every((t) => String(t).length < 6), JSON.stringify(niceTicks(0, 1, 5)))
ok('ticks step by a round number', (() => { const t = niceTicks(0, 18735, 5); const step = t[1] - t[0]; return [1, 2, 2.5, 5, 10].includes(step / 10 ** Math.floor(Math.log10(step))) })())

group('Text measurement never under-estimates enough to overlap')
for (const s of ['Lama Max subscription', 'University Fees', '₹1,20,450', 'Uncategorised', 'Utilities']) {
  for (const max of [40, 60, 90, 140]) {
    ok(`truncate("${s}", ${max}) fits`, textWidth(truncate(s, max, 12.5), 12.5) <= max + 0.01)
  }
}
for (const max of [120, 200, 320]) {
  ok(`wrap to ${max} keeps every line inside`, wrap('totals from "grocery", all 7 rows, grouped by Paid via and then some more text', max, 11, 400, 3).every((l) => textWidth(l, 11) <= max + 0.01))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
