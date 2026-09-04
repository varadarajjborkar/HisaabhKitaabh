'use client'

import { useEffect } from 'react'
import { ChatPanel } from './ChatPanel'
import type { ChatScope } from '@/lib/client/useChat'
import { Icon } from '../ui/Icons'

/**
 * The assistant outside the editor.
 *
 * A right-hand drawer on desktop, a near-full-height sheet on phones. It sits
 * over the content rather than pushing it, because on the home and folder
 * screens the user is usually asking *about* what's behind the panel.
 */
export function ChatDock({
  open,
  onClose,
  scope,
  onApplied,
}: {
  open: boolean
  onClose: () => void
  scope: ChatScope
  onApplied?: () => void
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
        className="fixed z-50 bg-surface border-line shadow-pop no-print
                   inset-x-0 bottom-0 h-[86dvh] rounded-t-xl2 border-t animate-rise
                   sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[390px] sm:h-auto sm:rounded-none sm:border-l sm:border-t-0 sm:animate-slide-l"
        role="dialog"
        aria-label="Assistant"
      >
        <button
          onClick={onClose}
          className="absolute top-2.5 right-2.5 z-10 h-7 w-7 grid place-items-center rounded-md text-faint hover:text-ink hover:bg-raised transition-colors"
          aria-label="Close"
        >
          <Icon.Close size={15} />
        </button>
        <ChatPanel scope={scope} onApplied={onApplied} compact />
      </aside>
    </>
  )
}
