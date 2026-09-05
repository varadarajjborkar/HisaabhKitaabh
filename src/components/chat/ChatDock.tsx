'use client'

import { useEffect } from 'react'
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
export function ChatDock({
  open,
  onClose,
  scope,
  onApplied,
  incoming,
  onIncomingConsumed,
}: {
  open: boolean
  onClose: () => void
  scope: ChatScope
  onApplied?: () => void
  incoming?: File[] | null
  onIncomingConsumed?: () => void
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <button
        className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] animate-fade cursor-default no-print"
        onClick={onClose}
        aria-label="Close assistant"
        tabIndex={-1}
      />
      <aside
        className="fixed z-50 bg-surface border-line shadow-pop no-print overflow-hidden flex flex-col
                   inset-x-0 bottom-0 h-[86dvh] rounded-t-xl2 border-t animate-rise
                   sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[min(400px,100vw)] sm:h-auto sm:rounded-none sm:border-l sm:border-t-0 sm:animate-slide-l"
        role="dialog"
        aria-label="Assistant"
      >
        <ChatPanel
          scope={scope}
          onApplied={onApplied}
          onClose={onClose}
          incoming={incoming}
          onIncomingConsumed={onIncomingConsumed}
          compact
        />
      </aside>
    </>
  )
}
