'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icons'
import { PermissionCard } from './PermissionCard'
import { RecentPanel, type Thread } from './RecentPanel'
import type { ChatScope } from '@/lib/client/useChat'
import { useChat } from '@/lib/client/useChat'
import { formatINR, humanSizeSafe } from '@/lib/util/uiformat'
import { get } from '@/lib/client/api'

/**
 * The assistant transcript.
 *
 * Shared by the docked overlay and the in-file side panel: the surface differs,
 * the conversation does not. Tool activity is shown as a collapsed line rather
 * than raw JSON, because the user needs to know *that* it read the file, not
 * what the payload looked like.
 *
 * The whole panel is a fixed-height box that clips its own overflow, and only
 * the transcript scrolls. Two things follow from that. Reaching the top or
 * bottom of the transcript cannot hand momentum to the page behind it, so a
 * flick through the conversation no longer drags the ledger, the toolbar and
 * the header off screen. And the composer stays welded to the bottom edge
 * instead of riding up with the content.
 */
export function ChatPanel({
  scope,
  onApplied,
  suggestions,
  compact = false,
  onClose,
  incoming,
  onIncomingConsumed,
}: {
  scope: ChatScope
  onApplied?: (e: { fileId: string; rowCount: number; total: number }) => void
  suggestions?: string[]
  compact?: boolean
  /** Present when the panel is an overlay that can be dismissed. */
  onClose?: () => void
  /** Files dropped on a surface outside the panel, handed over to attach. */
  incoming?: File[] | null
  onIncomingConsumed?: () => void
}) {
  const chat = useChat({ scope, onApplied })
  const [input, setInput] = useState('')
  const [threads, setThreads] = useState<Thread[]>([])
  const [showThreads, setShowThreads] = useState(false)
  const [loadingThreads, setLoadingThreads] = useState(false)
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)

  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  /*
   * Stick to the bottom by driving the container's own scrollTop.
   *
   * The previous version called scrollIntoView() on a sentinel at the end of
   * the list. That scrolls *every* scrollable ancestor, not just the nearest
   * one, so each streamed token also nudged the page behind the panel; on the
   * file editor the sheet crept upward for the whole of a long reply. Setting
   * scrollTop touches exactly one element.
   *
   * It also only follows when the reader is already near the bottom, so
   * scrolling up to re-read something earlier is not fought by the next token.
   */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distance > 220) return
    el.scrollTop = el.scrollHeight
  }, [chat.turns])

  // Files dropped on the page behind this panel arrive here rather than
  // opening a second, competing upload path.
  const attachRef = useRef(chat.attach)
  attachRef.current = chat.attach
  const consumedRef = useRef(onIncomingConsumed)
  consumedRef.current = onIncomingConsumed
  useEffect(() => {
    if (!incoming || incoming.length === 0) return
    for (const file of incoming.slice(0, 4)) void attachRef.current(file)
    consumedRef.current?.()
  }, [incoming])

  const loadThreads = useCallback(async () => {
    setShowThreads(true)
    setLoadingThreads(true)
    try {
      const res = await get<{ threads: Thread[] }>('/api/chat/threads')
      setThreads(res.threads)
    } finally {
      setLoadingThreads(false)
    }
  }, [])

  const submit = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    if (textRef.current) textRef.current.style.height = 'auto'
    void chat.send(text)
  }

  /*
   * Dropping a file anywhere on the panel attaches it.
   *
   * dragenter/dragleave fire for every child element the pointer crosses, so a
   * naive boolean flickers off the moment the cursor moves from the transcript
   * onto a message bubble. Counting enters and leaves keeps the highlight
   * steady until the pointer genuinely leaves the panel.
   */
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  const onDragEnter = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current++
    setDropping(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropping(false)
  }
  const onDrop = (e: React.DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    for (const file of Array.from(e.dataTransfer.files).slice(0, 4)) void chat.attach(file)
  }

  const hasConversation = chat.turns.length > 0

  return (
    <div
      className="relative flex flex-col h-full min-h-0 overflow-hidden"
      onDragEnter={onDragEnter}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault() }}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1.5 px-3 h-11 border-b border-line shrink-0">
        <Icon.Sparkle size={15} className="text-accent shrink-0" />
        <span className="text-[12.5px] font-medium">Assistant</span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={() => void loadThreads()}
            className="btn-ghost h-7 px-2 text-[11.5px] gap-1.5 pressable"
            title="Recent conversations"
          >
            <Icon.History size={13} />
            <span className="hidden sm:inline">Recent</span>
          </button>
          {hasConversation && (
            <button onClick={chat.reset} className="btn-ghost h-7 px-2 text-[11.5px] gap-1.5 pressable" title="Start a new conversation">
              <Icon.Plus size={13} />
              <span className="hidden sm:inline">New</span>
            </button>
          )}
          {/* The dismiss control belongs in the header row, not floating over
              it. As an absolutely-positioned overlay it landed on top of the
              "New" button at every width below the panel's widest. */}
          {onClose && (
            <button
              onClick={onClose}
              className="h-7 w-7 grid place-items-center rounded-md text-faint hover:text-ink hover:bg-raised transition-colors ml-0.5"
              aria-label="Close assistant"
            >
              <Icon.Close size={15} />
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 scroller px-3 py-3.5 space-y-2.5 min-h-0">
        {!hasConversation && <Welcome scope={scope} suggestions={suggestions} onPick={(s) => void chat.send(s)} compact={compact} />}

        {chat.turns.map((turn) => {
          switch (turn.kind) {
            case 'user':
              return (
                <div key={turn.id} className="flex justify-end animate-slide-l">
                  <div className="bg-accent text-white rounded-xl2 rounded-br-md px-3 py-2 max-w-[85%]">
                    <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">{turn.text}</p>
                    {turn.attachments && turn.attachments.length > 0 && (
                      <p className="text-[11px] opacity-80 mt-1.5 flex items-center gap-1">
                        <Icon.Attach size={11} /> {turn.attachments.join(', ')}
                      </p>
                    )}
                  </div>
                </div>
              )

            case 'assistant':
              return (
                <div key={turn.id} className="animate-slide-r">
                  <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                    {turn.thinking && !turn.text ? (
                      <span className="text-faint text-[12.5px] animate-pulse-soft">Thinking…</span>
                    ) : (
                      <span className={turn.streaming ? 'caret' : ''}>{turn.text}</span>
                    )}
                  </div>
                </div>
              )

            case 'tool':
              return (
                <div key={turn.id} className="flex items-center gap-2 text-[12px] text-faint animate-fade">
                  {turn.status === 'running'
                    ? <Icon.Spinner size={12} />
                    : turn.status === 'ok'
                      ? <Icon.Check size={12} className="text-good" />
                      : <Icon.Warning size={12} className="text-warn" />}
                  <span className="truncate">{turn.label}</span>
                  {turn.detail && turn.status === 'ok' && <span className="text-faint/70 truncate">· {turn.detail}</span>}
                  {turn.detail && turn.status === 'failed' && <span className="text-warn truncate">· {turn.detail}</span>}
                </div>
              )

            case 'permission':
              return (
                <PermissionCard
                  key={turn.id}
                  action={turn.action}
                  resolved={turn.resolved}
                  busy={chat.busy}
                  onDecide={(decision, guidance) => void chat.decide(turn.id, turn.action, decision, guidance)}
                />
              )

            case 'applied':
              return (
                <div key={turn.id} className="flex items-start gap-2 text-[12.5px] text-good animate-rise">
                  <Icon.Check size={14} className="mt-px shrink-0" />
                  <span>
                    {turn.summary}
                    <span className="text-muted"> · now {turn.rowCount} row{turn.rowCount === 1 ? '' : 's'}, {formatINR(turn.total, { decimals: false })}</span>
                  </span>
                </div>
              )

            case 'conflict':
              return (
                <div key={turn.id} className="card border-warn/40 px-3 py-2.5 animate-rise">
                  <p className="text-[12.5px] text-warn flex items-start gap-1.5">
                    <Icon.Warning size={14} className="mt-px shrink-0" />
                    <span>{turn.message}</span>
                  </p>
                </div>
              )

            case 'ask':
              return (
                <div key={turn.id} className="card px-3.5 py-3 animate-rise">
                  <p className="text-[13px] leading-snug">{turn.question}</p>
                  {turn.options.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      {turn.options.map((o) => (
                        <button key={o} onClick={() => void chat.send(o)} className="chip hover:bg-accent-soft hover:border-accent/40 hover:text-accent transition-colors pressable">
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )

            case 'error':
              return (
                <div key={turn.id} className="card border-bad/35 px-3 py-2.5 animate-rise">
                  <p className="text-[12.5px] text-bad flex items-start gap-1.5">
                    <Icon.Warning size={14} className="mt-px shrink-0" />
                    <span>{turn.message}</span>
                  </p>
                </div>
              )
          }
        })}
      </div>

      <div className="border-t border-line p-2.5 shrink-0 bg-surface">
        {chat.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 animate-rise">
            {chat.attachments.map((a) => (
              <span key={a.id} className="chip max-w-full">
                <Icon.Attach size={11} className="shrink-0" />
                <span className="truncate max-w-[130px]">{a.name}</span>
                <span className="text-faint shrink-0">{humanSizeSafe(a.size)}</span>
                <button
                  onClick={() => chat.setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="text-faint hover:text-bad ml-0.5 shrink-0"
                  aria-label={`Remove ${a.name}`}
                >
                  <Icon.Close size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-1.5">
          <button
            onClick={() => fileRef.current?.click()}
            className="btn-ghost h-9 w-9 px-0 shrink-0 pressable"
            title="Attach a receipt, CSV or screenshot, or drop one anywhere here"
            aria-label="Attach a file"
          >
            <Icon.Attach size={17} />
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept="image/*,.pdf,.csv,.tsv,.txt,.json,.md,.doc,.docx,.xls,.xlsx,.ods,.odt"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void chat.attach(f)
              e.target.value = ''
            }}
          />

          <textarea
            ref={textRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
            }}
            rows={1}
            placeholder={scope.fileId ? 'Ask, or add a row…' : 'Ask about your files…'}
            className="input h-9 min-h-9 py-2 resize-none text-[13px] leading-snug"
            disabled={chat.busy}
          />

          <button
            onClick={submit}
            disabled={!input.trim() || chat.busy}
            className="btn-primary h-9 w-9 px-0 shrink-0 pressable"
            aria-label="Send"
          >
            {chat.busy ? <Icon.Spinner /> : <Icon.Chevron size={17} />}
          </button>
        </div>
      </div>

      {dropping && (
        <div className="absolute inset-2 z-30 rounded-xl2 grid place-items-center bg-bg/85 backdrop-blur-sm
                        border-2 border-dashed border-accent pointer-events-none animate-fade">
          <div className="text-center">
            <Icon.Upload size={22} className="mx-auto text-accent" />
            <p className="text-[13px] font-medium mt-2">Drop to attach</p>
            <p className="text-[11.5px] text-muted mt-0.5">Receipts, CSVs, screenshots. Not video.</p>
          </div>
        </div>
      )}

      {showThreads && (
        <RecentPanel
          threads={threads}
          loading={loadingThreads}
          onClose={() => setShowThreads(false)}
          onOpen={(id) => { void chat.loadThread(id); setShowThreads(false) }}
          onChange={setThreads}
        />
      )}
    </div>
  )
}

function Welcome({ scope, suggestions, onPick, compact }: { scope: ChatScope; suggestions?: string[]; onPick: (s: string) => void; compact: boolean }) {
  const defaults = scope.fileId
    ? ['What did I spend the most on?', 'Add 450 for a cab to the airport, paid by UPI', 'Find anything entered twice']
    : ['What are my biggest files?', 'Create a folder for November', 'How much have I logged in total?']

  const list = suggestions ?? defaults

  return (
    <div className={`text-center ${compact ? 'py-6' : 'py-10'} animate-rise`}>
      <Icon.Sparkle size={22} className="mx-auto text-faint" />
      <p className="text-[13px] font-medium mt-2.5">Ask, or tell it what to change</p>
      <p className="text-[12px] text-muted mt-1.5 max-w-[260px] mx-auto leading-relaxed">
        It reads your data freely. Anything that writes waits for your approval first.
      </p>
      <div className="flex flex-col gap-1.5 mt-4 max-w-[300px] mx-auto">
        {list.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="text-left text-[12.5px] px-3 py-2 rounded-lg border border-line text-muted
                       hover:bg-raised hover:text-ink hover:border-faint transition-colors pressable"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
