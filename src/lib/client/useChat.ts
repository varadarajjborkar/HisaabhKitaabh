'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentRef } from '@/lib/model/types'
import { shortId } from '@/lib/util/ids'
import { toast } from '@/components/ui/Toast'
import { isPdf, pdfToImages, type PdfPage } from './pdf'
import type { ChartSpec } from '@/lib/ai/chart'

/**
 * Chat transport.
 *
 * The stream is a POST, so EventSource is out - it only does GET. Reading the
 * body as a stream and splitting on the SSE framing costs about twenty lines
 * and buys the ability to send attachments and scope with the message.
 *
 * A run that needs approval *ends* its stream. The pending action is held
 * server-side; answering it opens a second stream that continues where the
 * first stopped. That is what lets a long approval sit on screen for minutes
 * without holding a serverless function open.
 */

export type PendingAction = {
  actionId: string
  toolName: string
  risk: 'none' | 'low' | 'medium' | 'high'
  summary: string
  preview: string[]
  diff?: Array<{ label: string; before: string; after: string }>
  baseRev: number
}

export type Turn =
  | { id: string; kind: 'user'; text: string; attachments?: string[] }
  | { id: string; kind: 'chart'; spec: ChartSpec }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean; thinking?: boolean }
  | { id: string; kind: 'tool'; label: string; status: 'running' | 'ok' | 'failed'; detail?: string }
  | { id: string; kind: 'permission'; action: PendingAction; runId: string; resolved?: 'allow' | 'allow_always' | 'deny' | 'guide' }
  | { id: string; kind: 'applied'; summary: string; fileId: string; total: number; rowCount: number; currency?: string }
  | { id: string; kind: 'conflict'; message: string }
  | { id: string; kind: 'ask'; question: string; options: string[]; answered?: boolean }
  | { id: string; kind: 'error'; message: string; fatal: boolean }

export type ChatScope = { fileId: string | null; folderId: string | null }

type Options = {
  scope: ChatScope
  onApplied?: (event: { fileId: string; rowCount: number; total: number }) => void
  threadId?: string
}

/** How many files one message may carry. */
const MAX_ATTACHMENTS = 4

export function useChat({ scope, onApplied, threadId: fixedThread }: Options) {
  const [threadId, setThreadId] = useState(() => fixedThread ?? `t_${shortId(12)}`)
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  /** The name of a PDF currently being turned into pages, for the composer. */
  const [converting, setConverting] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const runId = useRef<string | null>(null)

  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const appliedRef = useRef(onApplied)
  appliedRef.current = onApplied

  const push = useCallback((turn: Turn) => setTurns((t) => [...t, turn]), [])

  /** Consume one SSE stream, folding events into the transcript. */
  const consume = useCallback(async (res: Response) => {
    if (!res.body) throw new Error('No response stream')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const assistantId = `a_${shortId(8)}`
    let assistantOpen = false

    const ensureAssistant = () => {
      if (assistantOpen) return
      assistantOpen = true
      push({ id: assistantId, kind: 'assistant', text: '', streaming: true })
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue

        let evt: Record<string, unknown>
        try {
          evt = JSON.parse(line.slice(6))
        } catch {
          continue
        }

        switch (evt.type) {
          case 'run':
            runId.current = String(evt.runId)
            break

          case 'thinking':
            ensureAssistant()
            setTurns((t) => t.map((x) => (x.id === assistantId && x.kind === 'assistant' ? { ...x, thinking: true } : x)))
            break

          case 'text': {
            ensureAssistant()
            const delta = String(evt.delta)
            setTurns((t) =>
              t.map((x) => (x.id === assistantId && x.kind === 'assistant' ? { ...x, text: x.text + delta, thinking: false } : x)),
            )
            break
          }

          case 'tool_start':
            push({ id: `tool_${shortId(8)}`, kind: 'tool', label: String(evt.label), status: 'running' })
            break

          case 'tool_result':
            setTurns((t) => {
              const i = t.map((x) => x.kind).lastIndexOf('tool')
              if (i < 0) return t
              const copy = [...t]
              const prev = copy[i] as Extract<Turn, { kind: 'tool' }>
              copy[i] = { ...prev, status: evt.ok ? 'ok' : 'failed', detail: String(evt.summary ?? '') }
              return copy
            })
            break

          case 'permission':
            // A write tool hands off to the approval card instead of returning
            // a result, so its "working…" line would otherwise spin forever.
            setTurns((t) => {
              const i = t.map((x) => x.kind).lastIndexOf('tool')
              if (i < 0) return t
              const prev = t[i] as Extract<Turn, { kind: 'tool' }>
              if (prev.status !== 'running') return t
              const copy = [...t]
              copy[i] = { ...prev, status: 'ok', detail: 'waiting for you' }
              return copy
            })
            push({
              id: `perm_${shortId(8)}`,
              kind: 'permission',
              action: evt.action as PendingAction,
              runId: runId.current ?? '',
            })
            break

          case 'applied': {
            const applied = { fileId: String(evt.fileId), total: Number(evt.total), rowCount: Number(evt.rowCount), currency: evt.currency ? String(evt.currency) : undefined }
            push({ id: `app_${shortId(8)}`, kind: 'applied', summary: String(evt.summary), ...applied })
            appliedRef.current?.(applied)
            break
          }

          case 'conflict':
            push({ id: `cf_${shortId(8)}`, kind: 'conflict', message: String(evt.message) })
            break

          case 'ask':
            push({ id: `ask_${shortId(8)}`, kind: 'ask', question: String(evt.question), options: (evt.options as string[]) ?? [] })
            break

          case 'chart':
            push({ id: `chart_${shortId(8)}`, kind: 'chart', spec: evt.spec as ChartSpec })
            break

          case 'error':
            push({ id: `err_${shortId(8)}`, kind: 'error', message: String(evt.message), fatal: Boolean(evt.fatal) })
            break

          case 'done':
            setTurns((t) =>
              t.map((x) => (x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'ok' } : x)),
            )
            setTurns((t) =>
              t.map((x) =>
                x.id === assistantId && x.kind === 'assistant' ? { ...x, streaming: false, thinking: false } : x,
              ),
            )
            // Drop an assistant turn that never produced text (a pure tool turn).
            setTurns((t) => t.filter((x) => !(x.id === assistantId && x.kind === 'assistant' && !x.text.trim())))
            break
        }
      }
    }
  }, [push])

  /*
   * Graph mode is a per-message flag, not a memory.
   *
   * It is sent with the request and read once while the prompt is built.
   * Nothing about it is stored in the thread, so there is no state to keep in
   * sync, no summary that can disagree with the switch, and turning it off
   * takes effect on the very next message rather than whenever the history
   * happens to be re-read.
   */
  const send = useCallback(async (message: string, options?: { graphMode?: boolean }) => {
    const text = message.trim()
    if (!text || busy) return

    abort.current?.abort()
    abort.current = new AbortController()

    push({ id: `u_${shortId(8)}`, kind: 'user', text, attachments: attachments.map((a) => a.name) })
    setBusy(true)
    const sending = attachments
    setAttachments([])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: abort.current.signal,
        body: JSON.stringify({
          threadId,
          message: text,
          fileId: scopeRef.current.fileId,
          folderId: scopeRef.current.folderId,
          attachments: sending,
          graphMode: options?.graphMode ?? false,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        push({ id: `err_${shortId(8)}`, kind: 'error', message: String(body.message ?? `Request failed (${res.status})`), fatal: res.status === 503 })
        return
      }
      await consume(res)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        push({ id: `err_${shortId(8)}`, kind: 'error', message: 'The connection dropped. Your message was not lost. Send it again.', fatal: false })
      }
    } finally {
      setBusy(false)
    }
  }, [attachments, busy, consume, push, threadId])

  const decide = useCallback(async (
    turnId: string,
    action: PendingAction,
    decision: 'allow' | 'allow_always' | 'deny' | 'guide',
    guidance?: string,
  ) => {
    setTurns((t) => t.map((x) => (x.id === turnId && x.kind === 'permission' ? { ...x, resolved: decision } : x)))
    setBusy(true)
    try {
      const res = await fetch('/api/chat/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: runId.current, actionId: action.actionId, decision, guidance }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        push({ id: `err_${shortId(8)}`, kind: 'error', message: String(body.message ?? 'That approval could not be sent.'), fatal: false })
        return
      }
      await consume(res)
    } catch {
      push({ id: `err_${shortId(8)}`, kind: 'error', message: 'The connection dropped while applying that.', fatal: false })
    } finally {
      setBusy(false)
    }
  }, [consume, push])

  const upload = useCallback(async (file: File): Promise<AttachmentRef | null> => {
    const form = new FormData()
    form.append('file', file)
    if (scopeRef.current.folderId) form.append('folderId', scopeRef.current.folderId)
    const res = await fetch('/api/chat/attach', { method: 'POST', body: form })
    const body = await res.json()
    if (!res.ok) {
      toast.error(String(body.message ?? 'That file could not be attached.'))
      return null
    }
    return body.attachment as AttachmentRef
  }, [])

  /**
   * Attach a file, turning a PDF into pictures of itself on the way.
   *
   * The assistant can read an image and could not read a PDF at all - it
   * accepted one, stored it, and then said the format was unreadable, after the
   * user had already spent the upload. Rendering the pages in the browser and
   * sending those puts the document on a path that already works, without a PDF
   * parser on the server or a native binary on a serverless host.
   */
  const attach = useCallback(async (file: File) => {
    try {
      if (!isPdf(file)) {
        const ref = await upload(file)
        if (ref) setAttachments((prev) => [...prev, ref].slice(0, MAX_ATTACHMENTS))
        return
      }

      setConverting(file.name)
      let pages: PdfPage[]
      try {
        pages = await pdfToImages(file)
      } finally {
        setConverting(null)
      }
      if (pages.length === 0) {
        toast.error('That PDF has no pages to read.')
        return
      }
      if (pages[0].pages > pages.length) {
        toast.info(`Reading the first ${pages.length} of ${pages[0].pages} pages`, 'For anything longer, a CSV is a better shape.')
      }

      // Sequential, because each upload counts against the same slot budget and
      // firing them together makes the cap a race.
      for (const page of pages) {
        const ref = await upload(page.file)
        if (!ref) break
        setAttachments((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, ref]))
      }
    } catch (err) {
      toast.error('Could not attach that', err instanceof Error ? err.message : undefined)
    }
  }, [upload])

  const reset = useCallback(() => {
    abort.current?.abort()
    setTurns([])
    setAttachments([])
    setThreadId(`t_${shortId(12)}`)
    runId.current = null
    setBusy(false)
  }, [])

  const loadThread = useCallback(async (id: string) => {
    abort.current?.abort()
    setThreadId(id)
    setTurns([])
    try {
      const res = await fetch(`/api/chat/threads?threadId=${encodeURIComponent(id)}`)
      const body = await res.json()
      const messages = (body.messages ?? []) as Array<{
        id: string
        role: string
        content: string
        meta?: { chart?: ChartSpec }
      }>
      setTurns(
        messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m): Turn => {
            // A stored chart comes back as a chart. Reopening a conversation
            // and finding the text that described a picture, with no picture,
            // is worse than not keeping the conversation at all.
            if (m.meta?.chart) return { id: m.id, kind: 'chart', spec: m.meta.chart }
            return m.role === 'user'
              ? { id: m.id, kind: 'user', text: m.content }
              : { id: m.id, kind: 'assistant', text: m.content, streaming: false }
          }),
      )
    } catch {
      toast.error('Could not load that conversation.')
    }
  }, [])

  useEffect(() => () => abort.current?.abort(), [])

  return { threadId, turns, busy, attachments, converting, send, decide, attach, reset, loadThread, setAttachments }
}
