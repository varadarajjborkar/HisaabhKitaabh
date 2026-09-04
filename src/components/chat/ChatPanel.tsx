'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icons'
import { PermissionCard } from './PermissionCard'
import type { ChatScope } from '@/lib/client/useChat'
import { useChat } from '@/lib/client/useChat'
import { formatINR, humanSizeSafe } from '@/lib/util/uiformat'
import { get, del } from '@/lib/client/api'

/**
 * The assistant transcript.
 *
 * Shared by the docked overlay and the in-file side panel — the surface differs,
 * the conversation does not. Tool activity is shown as a collapsed line rather
 * than raw JSON: the user needs to know *that* it read the file, not what the
 * payload looked like.
 */
export function ChatPanel({
  scope,
  onApplied,
  suggestions,
  compact = false,
}: {
  scope: ChatScope
  onApplied?: (e: { fileId: string; rowCount: number; total: number }) => void
  suggestions?: string[]
  compact?: boolean
}) {
  const chat = useChat({ scope, onApplied })
  const [input, setInput] = useState('')
  const [threads, setThreads] = useState<Array<{ id: string; title: string; at: number }>>([])
  const [showThreads, setShowThreads] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [chat.turns])

  const loadThreads = async () => {
    const res = await get<{ threads: Array<{ id: string; title: string; at: number }> }>('/api/chat/threads')
    setThreads(res.threads)
    setShowThreads(true)
  }

  const submit = () => {
    const text = input.trim()
    if (!text) return
    setInput('')
    if (textRef.current) textRef.current.style.height = 'auto'
    void chat.send(text)
  }

  const hasConversation = chat.turns.length > 0

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1.5 px-3 h-11 border-b border-line shrink-0">
        <Icon.Sparkle size={15} className="text-accent" />
        <span className="text-[12.5px] font-medium">Assistant</span>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={loadThreads} className="btn-ghost h-7 px-2 text-[11.5px] pressable" title="Recent conversations">
            Recent
          </button>
          {hasConversation && (
            <button onClick={chat.reset} className="btn-ghost h-7 px-2 text-[11.5px] pressable" title="Start a new conversation">
              New
            </button>
          )}
        </div>
      </div>

      {showThreads && (
        <div className="border-b border-line bg-raised/50 max-h-52 overflow-y-auto animate-rise shrink-0">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Recent</span>
            <button onClick={() => setShowThreads(false)} className="text-faint hover:text-ink p-0.5"><Icon.Close size={13} /></button>
          </div>
          {threads.length === 0 ? (
            <p className="px-3 pb-3 text-[12px] text-faint">No earlier conversations.</p>
          ) : (
            <ul className="pb-1.5">
              {threads.map((t) => (
                <li key={t.id} className="group flex items-center">
                  <button
                    onClick={() => { void chat.loadThread(t.id); setShowThreads(false) }}
                    className="flex-1 text-left px-3 py-1.5 text-[12.5px] text-muted hover:text-ink hover:bg-raised truncate transition-colors"
                  >
                    {t.title}
                  </button>
                  <button
                    onClick={async () => { await del('/api/chat/threads', { threadId: t.id }); setThreads((x) => x.filter((y) => y.id !== t.id)) }}
                    className="px-2.5 text-faint hover:text-bad opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label="Delete conversation"
                  >
                    <Icon.Trash size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3.5 space-y-2.5 min-h-0">
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
                  <div className={`text-[13px] leading-relaxed whitespace-pre-wrap break-words ${turn.streaming && !turn.text ? '' : ''}`}>
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
                  <span>{turn.label}</span>
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
                    <span className="text-muted"> — now {turn.rowCount} row{turn.rowCount === 1 ? '' : 's'}, {formatINR(turn.total, { decimals: false })}</span>
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

        <div ref={endRef} />
      </div>

      <div className="border-t border-line p-2.5 shrink-0">
        {chat.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 animate-rise">
            {chat.attachments.map((a) => (
              <span key={a.id} className="chip">
                <Icon.Attach size={11} />
                <span className="truncate max-w-[130px]">{a.name}</span>
                <span className="text-faint">{humanSizeSafe(a.size)}</span>
                <button
                  onClick={() => chat.setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  className="text-faint hover:text-bad ml-0.5"
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
            title="Attach a receipt, CSV or screenshot"
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
            placeholder={scope.fileId ? 'Add 450 for a cab, or ask about this file…' : 'Ask about your files…'}
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
