'use client'

import { useState } from 'react'
import { Icon } from '../ui/Icons'
import type { PendingAction } from '@/lib/client/useChat'

/**
 * The approval card.
 *
 * This is where the assistant's authority actually stops. It never applied
 * anything to get here — it produced a plan, and this card is the plan rendered
 * in full: what it would do, to how many rows, with before-and-after values
 * where a value is being replaced.
 *
 * Three answers, because two is not enough. "Deny" ends it; "Tell it what to do
 * instead" is the one people actually want most of the time, when the intent
 * was right and the details were wrong.
 */

const RISK_COPY: Record<PendingAction['risk'], { label: string; tone: string }> = {
  none: { label: 'Read', tone: 'text-muted' },
  low: { label: 'Minor change', tone: 'text-muted' },
  medium: { label: 'Adds data', tone: 'text-accent' },
  high: { label: 'Changes existing data', tone: 'text-warn' },
}

export function PermissionCard({
  action,
  resolved,
  busy,
  onDecide,
}: {
  action: PendingAction
  resolved?: 'allow' | 'allow_always' | 'deny' | 'guide'
  busy: boolean
  onDecide: (decision: 'allow' | 'allow_always' | 'deny' | 'guide', guidance?: string) => void
}) {
  const [guiding, setGuiding] = useState(false)
  const [guidance, setGuidance] = useState('')
  const [expanded, setExpanded] = useState(false)

  const risk = RISK_COPY[action.risk]
  const previewLimit = expanded ? action.preview.length : 4
  const hidden = action.preview.length - previewLimit

  if (resolved) {
    const copy =
      resolved === 'deny' ? 'Declined' :
      resolved === 'guide' ? 'Redirected' :
      resolved === 'allow_always' ? 'Allowed for this chat' : 'Approved'
    return (
      <div className="card px-3.5 py-2.5 text-[12.5px] text-muted flex items-center gap-2 animate-fade">
        {resolved === 'deny' ? <Icon.Close size={14} className="text-bad" /> : <Icon.Check size={14} className="text-good" />}
        <span className="truncate">{copy} — {action.summary}</span>
      </div>
    )
  }

  return (
    <div className="card border-accent/35 shadow-card overflow-hidden animate-rise">
      <header className="px-3.5 py-2.5 bg-accent-soft/60 border-b border-line flex items-center gap-2">
        <Icon.Sparkle size={14} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-accent">Needs your approval</span>
        <span className={`ml-auto text-[11px] ${risk.tone}`}>{risk.label}</span>
      </header>

      <div className="px-3.5 py-3">
        <p className="text-[13.5px] font-medium leading-snug">{action.summary}</p>

        {action.diff && action.diff.length > 0 ? (
          <ul className="mt-2.5 space-y-1.5">
            {action.diff.slice(0, previewLimit).map((d, i) => (
              <li key={i} className="text-[12px] leading-snug">
                <span className="text-muted">{d.label}</span>
                <span className="block mt-0.5 tnum">
                  <span className="text-faint line-through decoration-bad/50">{d.before}</span>
                  <span className="text-faint mx-1.5">→</span>
                  <span className="text-ink font-medium">{d.after}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <ul className="mt-2.5 space-y-1">
            {action.preview.slice(0, previewLimit).map((p, i) => (
              <li key={i} className="text-[12px] text-muted leading-snug flex gap-1.5">
                <span className="text-faint shrink-0">·</span>
                <span className="min-w-0">{p}</span>
              </li>
            ))}
          </ul>
        )}

        {hidden > 0 && (
          <button onClick={() => setExpanded(true)} className="text-[12px] text-accent hover:underline mt-2">
            Show {hidden} more
          </button>
        )}

        {guiding ? (
          <div className="mt-3 animate-rise">
            <label className="label" htmlFor={`guide-${action.actionId}`}>What should it do instead?</label>
            <textarea
              id={`guide-${action.actionId}`}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              rows={2}
              autoFocus
              placeholder="Only the first three rows, and put them under Groceries"
              className="input h-auto py-2 resize-none text-[13px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && guidance.trim()) onDecide('guide', guidance.trim())
                if (e.key === 'Escape') setGuiding(false)
              }}
            />
            <div className="flex gap-2 mt-2 justify-end">
              <button className="btn-ghost h-8 text-[12.5px]" onClick={() => setGuiding(false)}>Back</button>
              <button
                className="btn-primary h-8 text-[12.5px] pressable"
                disabled={!guidance.trim() || busy}
                onClick={() => onDecide('guide', guidance.trim())}
              >
                Send instruction
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2 mt-3.5">
              <button className="btn-primary h-8 text-[12.5px] pressable" disabled={busy} onClick={() => onDecide('allow')}>
                <Icon.Check size={14} /> Allow
              </button>
              <button className="btn-outline h-8 text-[12.5px] pressable" disabled={busy} onClick={() => setGuiding(true)}>
                Tell it what to do
              </button>
              <button className="btn-ghost h-8 text-[12.5px] pressable" disabled={busy} onClick={() => onDecide('deny')}>
                Deny
              </button>
            </div>

            <button
              className="text-[11.5px] text-faint hover:text-muted mt-2.5 transition-colors"
              disabled={busy}
              onClick={() => onDecide('allow_always')}
            >
              Allow {action.toolName.replace(/_/g, ' ')} for the rest of this chat
            </button>
          </>
        )}
      </div>
    </div>
  )
}
