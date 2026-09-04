'use client'

import type { Duration } from '@/lib/model/types'
import { Toggle } from '../HomeView'
import { formatDate } from '@/lib/util/format'

/**
 * The optional period.
 *
 * Off by default, because most files don't need one and an always-visible date
 * range is two more empty fields to ignore. When on, the mode switch matters:
 * "October" is a month, not the 1st to the 31st, and storing it as a day range
 * would misrepresent what the user said.
 */
export function DurationBar({ duration, onChange }: { duration: Duration; onChange: (d: Duration) => void }) {
  const set = (patch: Partial<Duration>) => onChange({ ...duration, ...patch })

  return (
    <div className="card px-3 py-2.5 no-print">
      {/* The toggle and label share a row; the mode switch wraps below it when
          the card is narrow, rather than crushing the date range into a
          three-word-per-line column. */}
      <div className="flex items-center gap-2.5">
        <Toggle checked={duration.enabled} onChange={() => set({ enabled: !duration.enabled })} label="Period" />
        <p className="text-[12.5px] font-medium flex-1 min-w-0">Period</p>

        {duration.enabled && (
          <div className="flex rounded-lg border border-line overflow-hidden shrink-0">
            {(['date', 'month'] as const).map((m) => (
              <button
                key={m}
                onClick={() => set({ mode: m, from: undefined, to: undefined })}
                className={`px-2 h-6 text-[11px] transition-colors ${
                  duration.mode === m ? 'bg-accent text-white' : 'text-muted hover:bg-raised'
                }`}
                aria-pressed={duration.mode === m}
              >
                {m === 'date' ? 'Dates' : 'Months'}
              </button>
            ))}
          </div>
        )}
      </div>

      {!duration.enabled && (
        <p className="text-[11.5px] text-faint mt-1.5 leading-snug">
          Off — turn on to record what this file covers.
        </p>
      )}
      {duration.enabled && (duration.from || duration.to) && (
        <p className="text-[11.5px] text-muted mt-1.5 leading-snug">
          {formatDate(duration.from ?? '')}{duration.to && ` — ${formatDate(duration.to)}`}
        </p>
      )}

      {duration.enabled && (
        <div className="flex items-center gap-1.5 mt-2.5 animate-rise">
          <input
            type={duration.mode === 'month' ? 'month' : 'date'}
            value={duration.from ?? ''}
            onChange={(e) => set({ from: e.target.value || undefined })}
            className="input h-8 text-[12.5px] flex-1 min-w-0"
            aria-label="Period start"
          />
          <span className="text-faint text-[12px] shrink-0">to</span>
          <input
            type={duration.mode === 'month' ? 'month' : 'date'}
            value={duration.to ?? ''}
            min={duration.from}
            onChange={(e) => set({ to: e.target.value || undefined })}
            className="input h-8 text-[12.5px] flex-1 min-w-0"
            aria-label="Period end"
          />
        </div>
      )}
    </div>
  )
}
