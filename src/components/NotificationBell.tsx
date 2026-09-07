'use client'

import { useCallback, useEffect, useState } from 'react'
import { Icon } from './ui/Icons'
import { ExportDialog } from './ExportDialog'
import { ProfileDialog } from './ProfileDialog'
import { FeedbackDialog } from './FeedbackDialog'
import { useDismiss } from '@/lib/client/useDismiss'
import { get, post } from '@/lib/client/api'
import type { Notice, NoticeAction } from '@/lib/notices'

/**
 * The bell.
 *
 * There is exactly one thing it has to say today - that an account is running
 * out of room - and the reason it is a bell rather than a banner across the top
 * of the page is that running out of room is not urgent until it is. A banner
 * would be in the way of the work for the weeks between the first warning and
 * the day uploads stop; a dot on a bell is visible from anywhere and demands
 * nothing.
 *
 * The dot means "worse than the last time you looked", not "unread". Opening
 * the panel at 76% acknowledges that; crossing 90% lights it again. A person
 * who is told the same thing every session stops reading it.
 *
 * The notice does not just report the problem, it carries the three ways out,
 * in the order they should be taken: take a copy, clear the account, or write
 * to whoever runs this and ask for more. A warning with no action attached is
 * only a way of making someone feel bad about a number.
 */

const REFRESH_MS = 5 * 60 * 1000

type Feed = { notices: Notice[]; unseen: boolean }

export function NotificationBell({ email, feedbackEnabled }: { email: string; feedbackEnabled: boolean }) {
  const [feed, setFeed] = useState<Feed>({ notices: [], unseen: false })
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<NoticeAction | null>(null)
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))

  const load = useCallback(async () => {
    try { setFeed(await get<Feed>('/api/notifications', { quiet: true })) } catch { /* the bell is not worth a toast */ }
  }, [])

  useEffect(() => {
    void load()
    /*
     * Slowly. Storage moves when a receipt is uploaded, not on its own, and a
     * poll that keeps a serverless function warm to learn nothing costs more
     * than the freshness is worth. An upload that fails for want of room says
     * so in its own error; this is for the weeks before that.
     */
    const t = setInterval(() => void load(), REFRESH_MS)
    const onChange = () => void load()
    window.addEventListener('storageChanged', onChange)
    return () => { clearInterval(t); window.removeEventListener('storageChanged', onChange) }
  }, [load])

  const toggle = async () => {
    const next = !open
    setOpen(next)
    // Opening is reading. Acknowledged at the level shown, so an escalation
    // later still lights the dot.
    if (next && feed.unseen) {
      setFeed((f) => ({ ...f, unseen: false }))
      try { await post('/api/notifications', {}, { quiet: true }) } catch { /* it will settle next load */ }
    }
  }

  const empty = feed.notices.length === 0

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => void toggle()}
        className="btn-ghost h-9 w-9 px-0 pressable relative"
        aria-label={feed.unseen ? 'Notifications, one is new' : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Notifications"
      >
        <Icon.Bell size={17} />
        {feed.unseen && (
          /* On the rim of the bell rather than beside it, and ringed in the bar's
             own background so it reads as a dot on the glyph at any zoom. */
          <span
            className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-bad ring-2 ring-bg"
            aria-hidden
          />
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-11 z-50 w-[min(340px,calc(100vw-24px))] card shadow-pop
                     animate-scale-in origin-top-right overflow-hidden"
          role="menu"
        >
          <p className="px-3.5 pt-3 pb-2 text-[11px] uppercase tracking-wide text-faint">Notifications</p>

          {empty ? (
            <p className="px-3.5 pb-4 text-[12.5px] text-muted leading-relaxed">
              Nothing needs you right now. Warnings about storage arrive here.
            </p>
          ) : (
            feed.notices.map((n) => (
              <NoticeRow
                key={n.id}
                notice={n}
                feedbackEnabled={feedbackEnabled}
                onAct={(action) => { setOpen(false); setDialog(action) }}
              />
            ))
          )}
        </div>
      )}

      <ExportDialog open={dialog === 'export'} onClose={() => setDialog(null)} />
      <ProfileDialog open={dialog === 'empty'} onClose={() => setDialog(null)} />
      <FeedbackDialog open={dialog === 'feedback'} onClose={() => setDialog(null)} topic="storage" email={email} />
    </div>
  )
}

const LABELS: Record<NoticeAction, string> = {
  export: 'Take a copy of everything',
  empty: 'Clear this account out',
  feedback: 'Ask for more space',
  storage: 'Where files live',
}

function NoticeRow({
  notice,
  feedbackEnabled,
  onAct,
}: {
  notice: Notice
  feedbackEnabled: boolean
  onAct: (a: NoticeAction) => void
}) {
  const pct =
    notice.used !== undefined && notice.limit ? Math.min(100, Math.round((notice.used / notice.limit) * 100)) : null
  const bad = notice.level !== 'warning'
  const actions = notice.actions.filter((a) => a !== 'feedback' || feedbackEnabled)

  return (
    <div className="px-3.5 pb-3 border-t border-line pt-3">
      <p className={`text-[13px] font-medium flex items-center gap-1.5 ${bad ? 'text-bad' : 'text-ink'}`}>
        <Icon.Warning size={14} className="shrink-0" />
        {notice.title}
      </p>

      {pct !== null && (
        <div className="h-1.5 rounded-full bg-raised overflow-hidden mt-2">
          <div
            className={`h-full rounded-full transition-[width] duration-500 ${bad ? 'bg-bad' : 'bg-accent'}`}
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
      )}

      <p className="text-[12px] text-muted leading-relaxed mt-2">{notice.body}</p>

      <div className="mt-2.5 -mx-1">
        {actions.map((a) => (
          <button
            key={a}
            role="menuitem"
            onClick={() => onAct(a)}
            className="w-full text-left px-1 py-1.5 rounded-md text-[12.5px] text-muted hover:text-ink
                       hover:bg-raised transition-colors flex items-center gap-2"
          >
            <Icon.Chevron size={12} className="text-faint shrink-0" />
            {LABELS[a]}
          </button>
        ))}
      </div>
    </div>
  )
}
