'use client'

import { useMemo, useState } from 'react'
import { compactINR, formatDate, formatINR } from '@/lib/util/format'
import { niceTicks, seriesColor } from './palette'
import { useIsDark } from './useTheme'

/**
 * Charts, hand-rolled in SVG.
 *
 * No charting library: the three forms this app needs are a few dozen lines
 * each, and a library would ship a hundred kilobytes to draw them plus a theme
 * system fighting ours. Every chart here carries a hover layer, direct labels
 * on the values that matter, and a table fallback where colour alone would
 * otherwise be doing the work.
 */

// ------------------------------------------------------------------ bar chart

export function BarChart({
  data,
  title,
  emptyHint = 'Nothing to show yet.',
  maxBars = 10,
  onSelect,
}: {
  data: Array<{ key: string; total: number; count?: number }>
  title?: string
  emptyHint?: string
  maxBars?: number
  onSelect?: (key: string) => void
}) {
  const dark = useIsDark()
  const [hover, setHover] = useState<number | null>(null)

  const rows = useMemo(() => [...data].sort((a, b) => b.total - a.total).slice(0, maxBars), [data, maxBars])
  const max = Math.max(...rows.map((r) => Math.abs(r.total)), 1)

  if (rows.length === 0) {
    return (
      <figure className="card p-4">
        {title && <figcaption className="text-[13px] font-medium mb-3">{title}</figcaption>}
        <p className="text-[12.5px] text-faint py-6 text-center">{emptyHint}</p>
      </figure>
    )
  }

  return (
    <figure className="card p-4">
      {title && <figcaption className="text-[13px] font-medium mb-3.5">{title}</figcaption>}
      <ul className="space-y-2.5">
        {rows.map((r, i) => {
          const pct = (Math.abs(r.total) / max) * 100
          const color = seriesColor(i, dark)
          return (
            <li
              key={`${i}-${r.key}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(r.key)}
              className={`group ${onSelect ? 'cursor-pointer' : ''}`}
            >
              <div className="flex items-baseline justify-between gap-3 mb-1">
                <span className="text-[12.5px] text-ink truncate min-w-0" title={r.key}>{r.key}</span>
                {/* Direct label on every bar: the light palette needs the relief. */}
                <span className="text-[12.5px] text-muted tnum shrink-0">
                  {formatINR(r.total, { decimals: false })}
                  {r.count != null && <span className="text-faint ml-1.5">·{r.count}</span>}
                </span>
              </div>
              {/* Track is a lighter step of the surface; the fill carries the value. */}
              <div className="h-2 rounded-full bg-raised overflow-hidden">
                <div
                  className="h-full rounded-r-[4px] transition-[width,opacity] duration-300"
                  style={{
                    width: `${Math.max(pct, 1.5)}%`,
                    background: color,
                    opacity: hover === null || hover === i ? 1 : 0.4,
                  }}
                />
              </div>
            </li>
          )
        })}
      </ul>
      {data.length > maxBars && (
        <p className="text-[11.5px] text-faint mt-3">{data.length - maxBars} more not shown</p>
      )}
    </figure>
  )
}

// ----------------------------------------------------------------- line chart

export function LineChart({
  data,
  title,
  cumulative = false,
}: {
  data: Array<{ day: string; total: number }>
  title?: string
  cumulative?: boolean
}) {
  const dark = useIsDark()
  const [hover, setHover] = useState<number | null>(null)

  const points = useMemo(() => {
    if (cumulative) {
      let run = 0
      return data.map((d) => ({ ...d, value: (run += d.total) }))
    }
    return data.map((d) => ({ ...d, value: d.total }))
  }, [data, cumulative])

  if (points.length < 2) {
    return (
      <figure className="card p-4">
        {title && <figcaption className="text-[13px] font-medium mb-3">{title}</figcaption>}
        <p className="text-[12.5px] text-faint py-8 text-center">
          {points.length === 0 ? 'No dated rows yet.' : 'One data point — add more rows to see a trend.'}
        </p>
      </figure>
    )
  }

  const W = 640, H = 190, PAD_L = 52, PAD_R = 16, PAD_T = 14, PAD_B = 26
  const max = Math.max(...points.map((p) => p.value), 1)
  const ticks = niceTicks(max, 3)
  const scaleMax = Math.max(ticks[ticks.length - 1], max)

  const x = (i: number) => PAD_L + (i / (points.length - 1)) * (W - PAD_L - PAD_R)
  const y = (v: number) => PAD_T + (1 - v / scaleMax) * (H - PAD_T - PAD_B)

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')
  const area = `${line} L ${x(points.length - 1).toFixed(1)} ${y(0)} L ${x(0).toFixed(1)} ${y(0)} Z`
  const color = seriesColor(0, dark)
  const last = points[points.length - 1]
  const active = hover != null ? points[hover] : null

  return (
    <figure className="card p-4">
      {title && (
        <figcaption className="flex items-baseline justify-between mb-2">
          <span className="text-[13px] font-medium">{title}</span>
          <span className="text-[12px] text-muted tnum">
            {active ? `${formatDate(active.day)} · ${formatINR(active.value, { decimals: false })}` : `${formatINR(last.value, { decimals: false })} latest`}
          </span>
        </figcaption>
      )}

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[190px]" role="img"
             aria-label={`${title ?? 'Trend'} from ${formatDate(points[0].day)} to ${formatDate(last.day)}`}
             onMouseLeave={() => setHover(null)}
             onMouseMove={(e) => {
               const rect = e.currentTarget.getBoundingClientRect()
               const rel = ((e.clientX - rect.left) / rect.width) * W
               const i = Math.round(((rel - PAD_L) / (W - PAD_L - PAD_R)) * (points.length - 1))
               setHover(Math.max(0, Math.min(points.length - 1, i)))
             }}>
          {/* Hairline gridlines, solid, one step off the surface. */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)} className="stroke-line" strokeWidth={1} />
              <text x={PAD_L - 8} y={y(t) + 4} textAnchor="end" className="fill-faint text-[10px] tnum">
                {compactINR(t).replace('₹', '')}
              </text>
            </g>
          ))}

          <path d={area} fill={color} opacity={0.1} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {active && hover != null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={H - PAD_B} className="stroke-faint" strokeWidth={1} />
              {/* 2px surface ring keeps the marker legible where it crosses the line. */}
              <circle cx={x(hover)} cy={y(active.value)} r={5} fill={color} stroke="rgb(var(--surface))" strokeWidth={2} />
            </g>
          )}

          <circle cx={x(points.length - 1)} cy={y(last.value)} r={4.5} fill={color} stroke="rgb(var(--surface))" strokeWidth={2} />

          <text x={PAD_L} y={H - 8} className="fill-faint text-[10px]">{formatDate(points[0].day)}</text>
          <text x={W - PAD_R} y={H - 8} textAnchor="end" className="fill-faint text-[10px]">{formatDate(last.day)}</text>
        </svg>
      </div>
    </figure>
  )
}

// ------------------------------------------------------------------ stat tile

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'good' | 'bad'
}) {
  return (
    <div className="card px-4 py-3.5">
      <p className="text-[11.5px] text-muted">{label}</p>
      {/* Proportional figures: a standalone value reads loose with tabular digits. */}
      <p className={`text-[21px] font-semibold leading-tight mt-1 tracking-tight ${
        tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : 'text-ink'
      }`}>
        {value}
      </p>
      {hint && <p className="text-[11.5px] text-faint mt-0.5">{hint}</p>}
    </div>
  )
}

// -------------------------------------------------------------- table fallback

/** The relief the light palette owes: every charted number, readable as text. */
export function DataTable({ rows, columns }: { rows: Array<Record<string, string | number>>; columns: string[] }) {
  if (rows.length === 0) return null
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="border-b border-line">
            {columns.map((c, i) => (
              <th key={c} className={`px-3.5 py-2.5 font-medium text-muted text-[11px] uppercase tracking-wide ${i > 0 ? 'text-right' : 'text-left'}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              {columns.map((c, j) => (
                <td key={c} className={`px-3.5 py-2 ${j > 0 ? 'text-right tnum text-muted' : 'text-ink'}`}>
                  {typeof r[c] === 'number' ? formatINR(r[c] as number, { decimals: false }) : r[c]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
