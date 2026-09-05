'use client'

import type { Duration } from '@/lib/model/types'
import { Toggle } from '../HomeView'
import { Icon } from '../ui/Icons'
import { formatDate } from '@/lib/util/format'

/**
 * The optional period.
 *
 * Off by default, because most files don't need one and an always-visible date
 * range is two more empty fields to ignore. When on, the mode switch matters:
 * "October" is a month, not the 1st to the 31st, and storing it as a day range
 * would misrepresent what the user said.
 *
 * The fields carry their own labels rather than sharing a "from - to" row. A
 * native date input needs about 150px before the browser starts clipping its
 * own placeholder, and in the 252px summary rail two of them side by side plus
 * the word "to" produced two squeezed boxes with a calendar button hanging off
 * the edge. Labelled fields that reflow with the card are both narrower where
 * space is tight and clearer everywhere.
 */
export function DurationBar({ duration, onChange }: { duration: Duration; onChange: (d: Duration) => void }) {
  const set = (patch: Partial<Duration>) => onChange({ ...duration, ...patch })
  const backwards = Boolean(duration.from && duration.to && duration.to < duration.from)
  const summary = duration.from || duration.to
    ? [duration.from && formatDate(duration.from), duration.to && formatDate(duration.to)].filter(Boolean).join(' to ')
    : null

  return (
    <section className="card overflow-hidden no-print">
      <header className="flex items-center gap-2.5 px-3.5 py-3">
        <Icon.Calendar size={15} className={duration.enabled ? 'text-accent shrink-0' : 'text-faint shrink-0'} />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium leading-none">Period</p>
          {!duration.enabled && (
            <p className="text-[11px] text-faint mt-1 leading-snug">What span this file covers</p>
          )}
        </div>
        <Toggle checked={duration.enabled} onChange={() => set({ enabled: !duration.enabled })} label="Period" />
      </header>

      {duration.enabled && (
        <div className="px-3.5 pb-3.5 space-y-3 border-t border-line pt-3 animate-rise">
          {/*
            * Three shapes, because this card lives at three widths. In the
            * 252px rail on a wide screen everything stacks. Below `lg` the rail
            * becomes a full-width block, so the mode switch moves beside the
            * dates instead of stretching a two-word toggle across 780px, and
            * the two dates sit side by side. On a phone it stacks again,
            * because a native date input below about 150px clips its own
            * placeholder.
            */}
          <div className="flex flex-col sm:flex-row lg:flex-col gap-3 sm:items-end lg:items-stretch">
            <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-raised border border-line
                            sm:w-[228px] lg:w-full shrink-0">
              {(['date', 'month'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => set({ mode: m, from: undefined, to: undefined })}
                  className={`h-9 sm:h-7 rounded-md text-[12px] sm:text-[11.5px] font-medium transition-colors ${
                    duration.mode === m
                      ? 'bg-surface text-accent border border-line shadow-sm'
                      : 'text-muted hover:text-ink border border-transparent'
                  }`}
                  aria-pressed={duration.mode === m}
                >
                  {m === 'date' ? 'Exact dates' : 'Whole months'}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2.5 flex-1 min-w-0 sm:max-w-md lg:max-w-none">
              <Field
                id="period-from"
                label="From"
                mode={duration.mode}
                value={duration.from}
                onChange={(v) => set({ from: v })}
              />
              <Field
                id="period-to"
                label="To"
                mode={duration.mode}
                value={duration.to}
                min={duration.from}
                onChange={(v) => set({ to: v })}
              />
            </div>
          </div>

          {backwards && (
            <p className="text-[11px] text-warn flex items-start gap-1.5 leading-snug">
              <Icon.Warning size={12} className="mt-px shrink-0" />
              The end is before the start.
            </p>
          )}

          {summary && !backwards && (
            <div className="flex items-center gap-2 pt-0.5">
              <p className="text-[11.5px] text-muted flex-1 min-w-0 truncate">{summary}</p>
              <button
                onClick={() => set({ from: undefined, to: undefined })}
                className="h-8 sm:h-auto px-2 sm:px-0 -mr-2 sm:mr-0 text-[11.5px] sm:text-[11px]
                           text-faint hover:text-ink transition-colors shrink-0"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function Field({
  id,
  label,
  mode,
  value,
  min,
  onChange,
}: {
  id: string
  label: string
  mode: Duration['mode']
  value?: string
  min?: string
  onChange: (v: string | undefined) => void
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-medium text-muted mb-1">{label}</label>
      <input
        id={id}
        type={mode === 'month' ? 'month' : 'date'}
        value={value ?? ''}
        min={min}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="input h-9 text-[12.5px] px-2.5"
      />
    </div>
  )
}
