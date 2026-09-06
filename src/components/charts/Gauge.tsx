'use client'

import { useMemo, useState } from 'react'
import { compactMoney, formatMoney } from '@/lib/util/format'
import { seriesColor, withOther } from './palette'
import { useIsDark } from './useTheme'

/**
 * The live total, as a half-donut.
 *
 * A speedometer needs a maximum, and an expense file has no inherent one - a
 * needle against an invented ceiling would be a made-up number dressed as
 * information. So the arc encodes *composition* instead: the total broken into
 * its largest parts, which is real and updates as rows are added. When the user
 * sets a budget, the ceiling becomes real too, and a tick mark plus a fill
 * fraction appear.
 */

export type Slice = { key: string; total: number }

const R_OUTER = 92
const R_INNER = 64
const CX = 110
const CY = 104
/** 2px of surface between segments - the separator is the gap, never a stroke. */
const GAP_DEG = 1.6

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 180) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function arcPath(startDeg: number, endDeg: number, rOuter: number, rInner: number): string {
  const large = endDeg - startDeg > 180 ? 1 : 0
  const o1 = polar(CX, CY, rOuter, startDeg)
  const o2 = polar(CX, CY, rOuter, endDeg)
  const i2 = polar(CX, CY, rInner, endDeg)
  const i1 = polar(CX, CY, rInner, startDeg)
  return [
    `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)}`,
    `L ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    'Z',
  ].join(' ')
}

export function Gauge({
  total,
  slices,
  rowCount,
  budget,
  label = 'Total',
  compact = false,
  currency = 'INR',
}: {
  total: number
  slices: Slice[]
  rowCount: number
  budget?: number | null
  label?: string
  compact?: boolean
  currency?: string
}) {
  const dark = useIsDark()
  const [hover, setHover] = useState<number | null>(null)

  const parts = useMemo(() => withOther(slices.filter((s) => s.total > 0), 7), [slices])
  const sum = parts.reduce((s, p) => s + p.total, 0)

  const segments = useMemo(() => {
    if (sum <= 0) return []
    let cursor = 0
    return parts.map((p, i) => {
      const span = (p.total / sum) * 180
      const start = cursor
      cursor += span
      // Shrink each segment by the gap so the surface shows through between them.
      const inset = Math.min(GAP_DEG / 2, span / 3)
      return {
        ...p,
        index: i,
        start: start + inset,
        end: Math.max(start + inset, cursor - inset),
        share: p.total / sum,
        color: p.isOther ? (dark ? '#5c6270' : '#aeb3bd') : seriesColor(i, dark),
      }
    })
  }, [parts, sum, dark])

  const budgetPct = budget && budget > 0 ? total / budget : null
  const overBudget = budgetPct != null && budgetPct > 1
  const budgetDeg = budgetPct == null ? null : Math.min(budgetPct, 1) * 180

  const size = compact ? 'h-[124px]' : 'h-[150px]'

  /*
   * The hero figure has to live inside the hole in the middle of the donut,
   * which is 128px across and does not grow just because the total did. A fixed
   * size was fine until the first six-figure total, which ran out over the arc
   * on both sides. So the type shrinks to fit, and past the point where
   * shrinking would make it unreadable the figure goes compact instead: 3.1L in
   * type you can read beats 3,14,020 in type you cannot.
   */
  const hover3 = hover !== null && segments[hover] ? segments[hover] : null
  const shown = hover3 ? hover3.total : total
  const full = formatMoney(shown, currency)
  const exact = formatMoney(shown, currency, { decimals: true })
  const ceiling = compact ? 24 : 30
  /*
   * The hole is 128 across at its widest and narrower where the type actually
   * sits, so the budget is 104: it leaves a clear ten pixels either side rather
   * than letting the figure graze the arc, which is what "just fits" looks like.
   * 0.55em per character is measured, not guessed - a seven-character total
   * renders 114.8px wide at 30px in this face.
   */
  const fit = (text: string) => Math.max(14, Math.min(ceiling, Math.floor(104 / (text.length * 0.55))))
  /*
   * Shrink the type to fit the figure, and past the point where shrinking would
   * make it unreadable, shorten the figure instead: 3.1L in type you can read
   * beats 3,14,020 in type you cannot. The exact amount is on the element
   * either way, so nothing is lost by rounding it here.
   */
  const hero = fit(full) > 16 ? full : compactMoney(shown, currency)
  const heroSize = fit(hero)

  return (
    <div className="flex flex-col items-center">
      <div className={`relative w-[220px] ${size}`}>
        <svg viewBox="0 0 220 118" className="w-full h-full overflow-visible" role="img"
             aria-label={`${label} ${formatMoney(total, currency)} across ${rowCount} rows`}>
          {/* Track - one step off the surface, recessive. */}
          <path
            d={arcPath(0, 180, R_OUTER, R_INNER)}
            className="fill-raised"
          />

          {segments.map((s) => (
            <path
              key={`seg-${s.index}`}
              d={arcPath(s.start, s.end, R_OUTER, R_INNER)}
              fill={s.color}
              opacity={hover === null || hover === s.index ? 1 : 0.32}
              onMouseEnter={() => setHover(s.index)}
              onMouseLeave={() => setHover(null)}
              className="transition-opacity duration-150 cursor-default"
            >
              <title>{`${s.key}: ${formatMoney(s.total, currency)} (${Math.round(s.share * 100)}%)`}</title>
            </path>
          ))}

          {budgetDeg != null && (
            <g>
              <line
                x1={polar(CX, CY, R_INNER - 5, budgetDeg).x}
                y1={polar(CX, CY, R_INNER - 5, budgetDeg).y}
                x2={polar(CX, CY, R_OUTER + 5, budgetDeg).x}
                y2={polar(CX, CY, R_OUTER + 5, budgetDeg).y}
                stroke={overBudget ? 'rgb(var(--bad))' : 'rgb(var(--ink))'}
                strokeWidth={2}
                strokeLinecap="round"
              />
            </g>
          )}
        </svg>

        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center pointer-events-none">
          {/* Hero figure: proportional digits, not tabular - tabular looks loose at display size. */}
          <span
            className={`font-semibold leading-none tracking-tight max-w-[130px] truncate pointer-events-auto ${hero === full ? '' : 'cursor-help'}`}
            style={{ fontSize: `${heroSize}px` }}
            title={exact}
          >
            {hero}
          </span>
          <span className="text-[11.5px] text-muted mt-1.5 max-w-[180px] truncate">
            {hover !== null && segments[hover]
              ? segments[hover].key
              : `${label} · ${rowCount} row${rowCount === 1 ? '' : 's'}`}
          </span>
          {budgetPct != null && hover === null && (
            <span className={`text-[11px] mt-1 font-medium ${overBudget ? 'text-bad' : 'text-muted'}`}>
              {Math.round(budgetPct * 100)}% of {formatMoney(budget!, currency)}
              {overBudget && ` · over by ${formatMoney(total - budget!, currency)}`}
            </span>
          )}
        </div>
      </div>

      {segments.length > 1 && (
        <ul className="flex flex-wrap justify-center gap-x-3.5 gap-y-1.5 mt-3 px-2 max-w-[300px]">
          {segments.map((s) => (
            <li
              key={`leg-${s.index}`}
              className="flex items-center gap-1.5 text-[11.5px] cursor-default"
              onMouseEnter={() => setHover(s.index)}
              onMouseLeave={() => setHover(null)}
            >
              <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: s.color }} />
              <span className={`truncate max-w-[92px] ${hover === s.index ? 'text-ink' : 'text-muted'}`}>{s.key}</span>
              <span className="text-faint tnum">{Math.round(s.share * 100)}%</span>
            </li>
          ))}
        </ul>
      )}

      {/* Only say "empty" when it genuinely is. A total with no breakdown is
          not the same thing as no data, and saying so contradicts the figure
          printed directly above it. */}
      {total === 0 && rowCount === 0 && (
        <p className="text-[12px] text-faint mt-2">Add a row and this fills in.</p>
      )}
      {total !== 0 && segments.length === 0 && (
        <p className="text-[12px] text-faint mt-2">No breakdown column yet.</p>
      )}
    </div>
  )
}
