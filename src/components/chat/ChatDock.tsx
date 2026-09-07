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
          behind it would only be visible during the animation.

          The drawer's scrim is a hint - the page behind it is still the thing
          being discussed and should stay readable. The centred window's is not:
          nothing out there is in play while it is open, so the page goes soft
          and out of focus and the window is the only thing with an edge.

          Which is also why it outranks the floating calculator when centred.
          At z-40 the calculator sat level with the scrim and later in the DOM,
          so it stayed sharp and clickable on top of a blurred page - one button
          poking through the frosting. Beside the drawer it can stay: the page
          there is still live, and reaching for a calculator mid-conversation is
          a reasonable thing to do. */}
      <button
        className={`hidden sm:block fixed inset-0 animate-fade cursor-default no-print transition-colors ${
          wide ? 'z-[45] bg-black/40 backdrop-blur-md' : 'z-40 bg-black/25 backdrop-blur-[1px]'
        }`}
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
        * Two shapes, because there are two ways to use this.
        *
        * A 400px drawer down the right edge is right for "add 450 for a cab":
        * the page stays where it was, and the answer arrives beside the thing
        * it is about. It is wrong for a chart comparing four categories across
        * three files - the bars end up too short to compare, which is the one
        * thing a bar chart is for.
        *
        * So the other shape is a window in the middle of the screen at nine
        * tenths of it, with the page blurred out behind. Not a wider drawer:
        * a drawer that grows to fill the screen is still hung off one edge,
        * still reads as an attachment to the page, and still puts the reading
        * column wherever the right margin happens to leave it. Centred, it is
        * the thing you are doing, and the margin is even on both sides.
        *
        * A tenth of the screen of page left showing on every side is what keeps
        * it a window rather than a second app - enough blurred context to know
        * what you are still on top of, and an obvious place to click to leave.
        *
        * On a phone it is already the whole screen, so the control is desktop
        * only and neither shape applies below `sm`.
        */}
      <aside
        className={`fixed z-50 bg-surface border-line shadow-pop no-print overflow-hidden flex flex-col
                   inset-0 h-dvh animate-rise ${
                     wide
                       ? 'sm:inset-0 sm:m-auto sm:w-[90vw] sm:h-[90dvh] sm:border sm:rounded-xl2 sm:animate-scale-in'
                       : 'sm:inset-y-0 sm:right-0 sm:left-auto sm:h-auto sm:w-[min(400px,100vw)] sm:border-l sm:animate-slide-l'
                   }`}
        role="dialog"
        aria-modal={wide}
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
