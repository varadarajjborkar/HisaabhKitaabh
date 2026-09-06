'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icons'
import { del, patch } from '@/lib/client/api'
import { relativeTime } from '@/lib/util/format'
import { toast } from '../ui/Toast'

export type Thread = { id: string; title: string; at: number; renamed?: boolean; snippet?: string }

/**
 * Recent conversations, as a drawer inside the assistant.
 *
 * It used to be a list that pushed itself in above the transcript, which shoved
 * the whole conversation down by a third of the panel and, once more than a
 * few threads existed, gave the panel a second scrollbar next to the first.
 * Sliding in over the panel instead keeps the assistant exactly where it was
 * and gives the list the full height it needs. It is scoped to the panel's own
 * width, so on the file editor the ledger beside it is never covered.
 *
 * Renaming is inline rather than a modal: a conversation title is one short
 * string, and a dialog for it would be three interactions where one will do.
 */
export function RecentPanel({
  threads,
  loading,
  onClose,
  onOpen,
  onChange,
  onSearch,
  query,
}: {
  threads: Thread[]
  loading: boolean
  onClose: () => void
  onOpen: (id: string) => void
  onChange: (next: Thread[]) => void
  /** Runs the search; the caller owns fetching, this owns the box. */
  onSearch: (query: string) => void
  query: string
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Escape backs out one layer at a time: the edit first, then the drawer.
      if (editing) { setEditing(null); return }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, onClose])

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const startRename = (t: Thread) => {
    setConfirming(null)
    setDraft(t.title)
    setEditing(t.id)
  }

  const commitRename = async (id: string) => {
    const title = draft.trim()
    setEditing(null)
    const before = threads
    const current = threads.find((t) => t.id === id)
    if (!current || title === current.title) return
    onChange(threads.map((t) => (t.id === id ? { ...t, title: title || t.title, renamed: Boolean(title) } : t)))
    try {
      const res = await patch<{ title: string }>('/api/chat/threads', { threadId: id, title })
      // An empty name asks the server to fall back to the derived title, so
      // take whatever it hands back rather than trusting the optimistic guess.
      onChange(threads.map((t) => (t.id === id ? { ...t, title: res.title || t.title, renamed: Boolean(res.title) } : t)))
    } catch {
      onChange(before)
      toast.error('That name could not be saved.')
    }
  }

  const remove = async (id: string) => {
    const before = threads
    onChange(threads.filter((t) => t.id !== id))
    setConfirming(null)
    try {
      await del('/api/chat/threads', { threadId: id })
    } catch {
      onChange(before)
    }
  }

  return (
    <div className="absolute inset-0 z-40 bg-surface flex flex-col animate-slide-in-left" role="dialog" aria-label="Recent conversations">
      <header className="flex items-center gap-1.5 px-3 h-11 border-b border-line shrink-0">
        <Icon.History size={14} className="text-muted shrink-0" />
        <span className="text-[12.5px] font-medium">Recent</span>
        <span className="text-[11.5px] text-faint">{threads.length > 0 && threads.length}</span>
        <button
          onClick={onClose}
          className="ml-auto btn-ghost h-7 px-2 text-[11.5px] gap-1.5 pressable"
          aria-label="Back to the conversation"
        >
          <Icon.Back size={13} /> Back
        </button>
      </header>

      {/*
        * Searching what was said, not only what it was called.
        *
        * A conversation is often remembered by a thing inside it - "the one
        * where we worked out the Goa split" - which no title carries. Titles
        * still rank first, because a title is what somebody remembers a
        * conversation *as*, and a match there is nearly always the one meant.
        */}
      <div className="px-3 py-2 border-b border-line shrink-0 relative">
        <Icon.Search size={13} className="absolute left-[22px] top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
        <input
          value={query}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search conversations"
          aria-label="Search conversations"
          className="input h-8 pl-7 pr-7 text-[12.5px]"
        />
        {query && (
          <button
            onClick={() => onSearch('')}
            aria-label="Clear search"
            className="absolute right-[22px] top-1/2 -translate-y-1/2 text-faint hover:text-ink transition-colors"
          >
            <Icon.Close size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 scroller">
        {loading && threads.length === 0 && (
          <div className="p-3 space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="skeleton h-11" />)}
          </div>
        )}

        {!loading && threads.length === 0 && (
          <div className="p-8 text-center">
            <Icon.History size={20} className="mx-auto text-faint" />
            <p className="text-[12.5px] text-muted mt-2.5">
              {query ? `Nothing matches “${query}”.` : 'No earlier conversations.'}
            </p>
            <p className="text-[11.5px] text-faint mt-1">
              {query ? 'Titles are searched first, then what was said inside.' : 'They appear here once you have sent a message.'}
            </p>
          </div>
        )}

        <ul className="py-1">
          {threads.map((t) => (
            <li key={t.id} className="border-b border-line/70 last:border-0">
              {editing === t.id ? (
                <div className="flex items-center gap-1.5 px-2.5 py-2">
                  <input
                    ref={inputRef}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(t.id)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    onBlur={() => void commitRename(t.id)}
                    maxLength={60}
                    placeholder="Name this conversation"
                    className="input h-8 text-[12.5px]"
                    aria-label="Conversation name"
                  />
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void commitRename(t.id)}
                    className="btn-primary h-8 w-8 px-0 shrink-0"
                    aria-label="Save name"
                  >
                    <Icon.Check size={14} />
                  </button>
                </div>
              ) : confirming === t.id ? (
                <div className="flex items-center gap-2 px-3 py-2 bg-bad/8">
                  <p className="text-[12px] text-muted flex-1 min-w-0 truncate">Delete this conversation?</p>
                  <button onClick={() => setConfirming(null)} className="btn-ghost h-7 px-2 text-[11.5px]">Cancel</button>
                  <button onClick={() => void remove(t.id)} className="btn-danger h-7 px-2.5 text-[11.5px]">Delete</button>
                </div>
              ) : (
                <div className="group flex items-center">
                  <button
                    onClick={() => onOpen(t.id)}
                    className="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-raised transition-colors"
                  >
                    <p className="text-[12.5px] text-ink truncate leading-snug">{t.title}</p>
                    {/* The line that matched, when the title was not the
                        reason this thread is in the list. */}
                    {t.snippet && <p className="text-[11px] text-muted truncate leading-snug mt-0.5">{t.snippet}</p>}
                    <p className="text-[11px] text-faint mt-0.5 flex items-center gap-1.5">
                      {relativeTime(t.at)}
                      {t.renamed && <span className="text-faint/70">renamed</span>}
                    </p>
                  </button>
                  <div className="flex items-center pr-1.5 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <button
                      onClick={() => startRename(t)}
                      className="h-7 w-7 grid place-items-center rounded text-faint hover:text-ink hover:bg-raised transition-colors"
                      aria-label={`Rename "${t.title}"`}
                      title="Rename"
                    >
                      <Icon.Pencil size={13} />
                    </button>
                    <button
                      onClick={() => setConfirming(t.id)}
                      className="h-7 w-7 grid place-items-center rounded text-faint hover:text-bad hover:bg-bad/10 transition-colors"
                      aria-label={`Delete "${t.title}"`}
                      title="Delete"
                    >
                      <Icon.Trash size={13} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
