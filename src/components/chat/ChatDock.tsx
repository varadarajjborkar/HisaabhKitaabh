'use client'

import { useEffect, useState } from 'react'
import { ChatPanel } from './ChatPanel'
import type { ChatScope } from '@/lib/client/useChat'

/**
 * The assistant outside the editor.
 *
 * A right-hand drawer on desktop, a near-full-height sheet on phones. It sits
 * over the content rather than pushing it, because on the home and folder
 * screens the user is usually asking *about* what is behind the panel.
 *
 * The drawer is a fixed box with no scroll of its own; the transcript inside it
 * does the scrolling. That is what stops a flick in the conversation from
 * taking the page with it.
 */
const WIDE_KEY = 'hisaabhkitaabh-assistant-wide'

export function ChatDock({
  open,
  onClose,
  scope,
  onApplied,
  subtitle,
  incoming,
  onIncomingConsumed,
}: {
  open: boolean
  onClose: () => void
  scope: ChatScope
  onApplied?: () => void
  subtitle?: string
  incoming?: File[] | null
  onIncomingConsumed?: () => void
}) {
  // Remembered, because someone who wants the wide view usually wants it for
  // the next question too.
  const [wide, setWide] = useState(() => {
    try { return localStorage.getItem(WIDE_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(WIDE_KEY, wide ? '1' : '0') } catch { /* preference only */ }
  }, [wide])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* No scrim on a phone: the panel covers the screen, so a dimmed strip
          behind it would only be visible during the animation. */}
      <button
        className="hidden sm:block fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] animate-fade cursor-default no-print"
        onClick={onClose}
        aria-label="Close assistant"
        tabIndex={-1}
      />
      {/*
        * Full screen on a phone, a drawer from `sm` up.
        *
        * The 86dvh sheet was the worst of both: it kept a sliver of unusable
        * page visible at the top, and once the keyboard opened the composer and
        * the last message were fighting over about two hundred pixels. A phone
        * chat is a screen, not a peek.
        */}
      {/*
        * Wide, when the answer needs the room.
        *
        * A 400px column is right for "add 450 for a cab" and wrong for a chart
        * comparing four categories across three files - the bars end up too
        * short to compare, which is the one thing a bar chart is for. Expanding
        * takes over the screen rather than opening a second window, because
        * the conversation is the task at that point, not a sidebar to it.
        *
        * On a phone it is already full width, so the control is desktop only.
        */}
      <aside
        className={`fixed z-50 bg-surface border-line shadow-pop no-print overflow-hidden flex flex-col
                   inset-0 h-dvh animate-rise sm:inset-y-0 sm:right-0 sm:left-auto sm:h-auto sm:border-l
                   transition-[width] duration-300 ease-out ${
                     wide
                       ? 'sm:w-[min(1100px,100vw)]'
                       : 'sm:w-[min(400px,100vw)] sm:animate-slide-l'
                   }`}
        role="dialog"
        aria-label="Assistant"
      >
        <ChatPanel
          scope={scope}
          onApplied={onApplied}
          onClose={onClose}
          subtitle={subtitle}
          incoming={incoming}
          onIncomingConsumed={onIncomingConsumed}
          compact={!wide}
          wide={wide}
          onToggleWide={() => setWide((w) => !w)}
        />
      </aside>
    </>
  )
}
