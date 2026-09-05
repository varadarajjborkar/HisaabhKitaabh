'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, Column, Duration, SheetDoc } from '@/lib/model/types'
import { applyOps, computeTotals, emptyRow, liveRows, type Totals } from '@/lib/crdt/doc'
import { invertOp, type Op } from '@/lib/crdt/ops'
import { shortId, ulid } from '@/lib/util/ids'
import { orderBetween, sortByOrder } from '@/lib/util/order'
import { ApiError, get, post } from './api'
import { toast } from '@/components/ui/Toast'

/**
 * The editing state machine.
 *
 * Local edits apply immediately through the same operation engine the server
 * runs, so typing never waits on a round trip. Operations queue and flush on a
 * short debounce; the queue is the unit of retry, and every batch carries the
 * revision it was built against.
 *
 * Undo is inverse operations, not snapshots. Inverting against the pre-state
 * and re-sending as a fresh edit means undo composes correctly with someone
 * else's concurrent change - it puts *your* value back without reverting
 * theirs.
 */

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error'

type UndoEntry = { label: string; undo: Op[]; redo: Op[] }

const FLUSH_DELAY = 700
const MAX_HISTORY = 60

export function useSheet(fileId: string, initialDoc?: SheetDoc | null) {
  const [doc, setDoc] = useState<SheetDoc | null>(initialDoc ?? null)
  const [loading, setLoading] = useState(!initialDoc)
  const [state, setState] = useState<SaveState>('idle')
  const [error, setError] = useState<string | null>(null)
  /** Row ids touched by the assistant, so the UI can flash what changed. */
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set())

  const queue = useRef<Op[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef(false)
  const undoStack = useRef<UndoEntry[]>([])
  const redoStack = useRef<UndoEntry[]>([])
  const [historyVersion, bumpHistory] = useState(0)
  const docRef = useRef<SheetDoc | null>(null)
  docRef.current = doc

  /**
   * The last revision the SERVER acknowledged.
   *
   * Kept apart from `doc.rev` on purpose: applying an operation locally bumps
   * the local revision immediately, so the document in state is always one or
   * more revisions ahead of the server while edits are queued. Sending that
   * number as `baseRev` would tell the server the client is from the future,
   * and every single save would come back 409.
   */
  const serverRev = useRef<number>(initialDoc?.rev ?? 0)

  const actor = useRef(`local:${shortId(6)}`)

  // ------------------------------------------------------------- loading

  const load = useCallback(async (opts: { fresh?: boolean; quiet?: boolean } = {}) => {
    try {
      if (!opts.quiet) setLoading(true)
      const res = await get<{ doc: SheetDoc }>(`/api/files/${fileId}${opts.fresh ? '?fresh=1' : ''}`, { quiet: opts.quiet })
      if (res.doc) {
        setDoc(res.doc)
        serverRev.current = res.doc.rev
        setError(null)
        if (state === 'conflict') setState('idle')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this file.')
    } finally {
      setLoading(false)
    }
  }, [fileId, state])

  // The page already fetched this document server-side for its own 404 check,
  // so the first paint has real rows rather than a skeleton. Revalidate quietly
  // in the background in case it changed between render and hydration.
  useEffect(() => { void load({ quiet: Boolean(initialDoc), fresh: Boolean(initialDoc) }) }, [fileId]) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------- saving

  const flush = useCallback(async () => {
    if (inFlight.current || queue.current.length === 0) return
    if (!docRef.current) return

    const ops = queue.current
    queue.current = []
    inFlight.current = true
    setState('saving')

    try {
      const res = await post<{ doc: SheetDoc; rejected: Array<{ reason: string }> }>(
        `/api/files/${fileId}/mutate`,
        {
          // The last revision the server confirmed - not the local one, which
          // optimistic edits have already advanced.
          baseRev: serverRev.current,
          ops,
          // Makes a retried POST collapse instead of applying twice.
          requestId: shortId(20),
        },
        { quiet: true },
      )

      serverRev.current = res.doc.rev

      setDoc((prev) => {
        if (!prev) return res.doc
        // Re-apply anything queued while this request was in flight, so a fast
        // typist never sees their last keystrokes vanish on the server echo.
        if (queue.current.length === 0) return res.doc
        return applyOps(res.doc, { actor: actor.current, ops: queue.current }).doc
      })

      if (res.rejected?.length) {
        toast.warn('Some changes could not be applied', res.rejected.map((r) => r.reason).join('; '))
      }
      setState(queue.current.length ? 'dirty' : 'saved')
      setError(null)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Someone else wrote to a cell we also touched. Keep the user's work in
        // the queue and let them decide - never silently discard or overwrite.
        queue.current = [...ops, ...queue.current]
        setState('conflict')
        const current = (err.body as { current?: SheetDoc }).current
        if (current) {
          serverRev.current = current.rev
          setDoc((prev) => (prev && current.rev > prev.rev ? current : prev))
        }
        setError('Someone else changed this file while you were editing.')
      } else if (err instanceof ApiError && err.status === 0) {
        queue.current = [...ops, ...queue.current]
        setState('offline')
      } else {
        queue.current = [...ops, ...queue.current]
        setState('error')
        setError(err instanceof ApiError ? err.message : 'Could not save.')
      }
    } finally {
      inFlight.current = false
      if (queue.current.length > 0 && state !== 'conflict') schedule()
    }
  }, [fileId]) // eslint-disable-line react-hooks/exhaustive-deps

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), FLUSH_DELAY)
  }, [flush])

  const saveNow = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current)
    await flush()
  }, [flush])

  // Flush on tab hide and before unload - closing a tab must not lose an edit.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') void flush() }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (queue.current.length > 0) {
        void flush()
        e.preventDefault()
        e.returnValue = ''
      }
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [flush])

  // ------------------------------------------------------------ mutating

  const apply = useCallback(
    (ops: Op[], label: string, opts: { history?: boolean } = {}) => {
      if (ops.length === 0) return
      const before = docRef.current
      if (!before) return

      const inverse = ops
        .slice()
        .reverse()
        .map((op) => invertOp(op, { rows: before.rows, columns: before.columns, name: before.name, duration: before.duration, currency: before.currency }, () => shortId(12)))
        .filter((op): op is Op => op !== null)

      const result = applyOps(before, { actor: actor.current, ops })
      setDoc(result.doc)
      queue.current.push(...ops)

      if (opts.history !== false && inverse.length > 0) {
        undoStack.current = [...undoStack.current, { label, undo: inverse, redo: ops }].slice(-MAX_HISTORY)
        redoStack.current = []
        bumpHistory((v) => v + 1)
      }

      setState('dirty')
      schedule()
    },
    [schedule],
  )

  const undo = useCallback(() => {
    const entry = undoStack.current[undoStack.current.length - 1]
    if (!entry) return
    undoStack.current = undoStack.current.slice(0, -1)
    // Fresh op ids: an undo is a new edit, not a replay of an old one.
    const ops = entry.undo.map((op) => ({ ...op, id: shortId(12) }))
    apply(ops, `Undo ${entry.label}`, { history: false })
    redoStack.current = [...redoStack.current, entry].slice(-MAX_HISTORY)
    bumpHistory((v) => v + 1)
  }, [apply])

  const redo = useCallback(() => {
    const entry = redoStack.current[redoStack.current.length - 1]
    if (!entry) return
    redoStack.current = redoStack.current.slice(0, -1)
    const ops = entry.redo.map((op) => ({ ...op, id: shortId(12) }))
    apply(ops, entry.label, { history: false })
    undoStack.current = [...undoStack.current, entry].slice(-MAX_HISTORY)
    bumpHistory((v) => v + 1)
  }, [apply])

  // ---------------------------------------------------------- operations

  const setCell = useCallback((rowId: string, columnId: string, value: CellValue) => {
    apply([{ id: shortId(12), type: 'cell.set', rowId, columnId, value }], 'edit')
  }, [apply])

  const addRow = useCallback((after?: string) => {
    const current = docRef.current
    if (!current) return null
    const row = emptyRow(current, after ? { after } : undefined)
    apply([{ id: shortId(12), type: 'row.insert', rowId: row.id, order: row.order, cells: {} }], 'add row')
    return row.id
  }, [apply])

  const addRows = useCallback((cellSets: Array<Record<string, CellValue>>) => {
    const current = docRef.current
    if (!current) return
    const visible = sortByOrder(liveRows(current))
    let cursor = visible.length ? visible[visible.length - 1].order : null
    const ops: Op[] = cellSets.map((cells) => {
      cursor = orderBetween(cursor, null)
      return { id: shortId(12), type: 'row.insert', rowId: ulid(), order: cursor, cells }
    })
    apply(ops, `add ${ops.length} rows`)
  }, [apply])

  const deleteRows = useCallback((rowIds: string[]) => {
    apply(rowIds.map((rowId) => ({ id: shortId(12), type: 'row.delete', rowId }) as Op), `delete ${rowIds.length} row(s)`)
  }, [apply])

  const moveRow = useCallback((rowId: string, targetIndex: number) => {
    const current = docRef.current
    if (!current) return
    const rows = sortByOrder(liveRows(current)).filter((r) => r.id !== rowId)
    const before = targetIndex > 0 ? rows[targetIndex - 1]?.order ?? null : null
    const after = rows[targetIndex]?.order ?? null
    apply([{ id: shortId(12), type: 'row.move', rowId, order: orderBetween(before, after) }], 'reorder')
  }, [apply])

  const addColumn = useCallback((name: string, kind: Column['kind'], options?: string[]) => {
    const current = docRef.current
    if (!current) return
    const last = current.columns.map((c) => c.order).sort().pop() ?? null
    const column: Column = {
      id: `c_${shortId(6).toLowerCase()}`,
      name,
      kind,
      order: orderBetween(last, null),
      ...(kind === 'select' ? { options: options ?? [] } : {}),
    }
    apply([{ id: shortId(12), type: 'column.insert', column }], `add column "${name}"`)
  }, [apply])

  const renameColumn = useCallback((columnId: string, name: string) => {
    apply([{ id: shortId(12), type: 'column.rename', columnId, name }], 'rename column')
  }, [apply])

  const retypeColumn = useCallback((columnId: string, kind: Column['kind'], options?: string[]) => {
    apply([{ id: shortId(12), type: 'column.retype', columnId, kind, options }], 'change column type')
  }, [apply])

  const deleteColumn = useCallback((columnId: string) => {
    apply([{ id: shortId(12), type: 'column.delete', columnId }], 'delete column')
  }, [apply])

  const renameDoc = useCallback((name: string) => {
    apply([{ id: shortId(12), type: 'doc.rename', name }], 'rename file')
  }, [apply])

  const setDuration = useCallback((duration: Duration) => {
    apply([{ id: shortId(12), type: 'doc.duration', duration }], 'set period')
  }, [apply])

  /**
   * Change what the amount column is denominated in.
   *
   * The column's *name* follows the currency only when it was still the old
   * code - a file whose amount column has been renamed to "Cost" or "Spend"
   * keeps that name, because the user chose it and a currency switch is not a
   * licence to overwrite it. Both ops go in one batch so it is one undo.
   */
  const setCurrency = useCallback((code: string) => {
    const next = code.trim().toUpperCase()
    const current = docRef.current
    if (!current || next === current.currency) return

    const ops: Op[] = [{ id: shortId(12), type: 'doc.currency', currency: next }]
    const amount = current.columns.find((c) => c.kind === 'amount' && c.system)
    if (amount && amount.name.trim().toUpperCase() === current.currency.toUpperCase()) {
      ops.push({ id: shortId(12), type: 'column.rename', columnId: amount.id, name: next })
    }
    apply(ops, 'change currency')
  }, [apply])

  // --------------------------------------------------------- conflict fix

  /** Take the server's version, keeping the local queue for the user to redo. */
  const resolveConflict = useCallback(async (choice: 'theirs' | 'retry') => {
    if (choice === 'theirs') {
      queue.current = []
      undoStack.current = []
      redoStack.current = []
      await load({ fresh: true })
      setState('idle')
      setError(null)
      toast.info('Reloaded the current version', 'Your unsaved edits were dropped.')
      return
    }
    await load({ fresh: true, quiet: true })
    setState('dirty')
    schedule()
  }, [load, schedule])

  /** Called after the assistant writes, so the grid picks up its changes. */
  const adoptRemote = useCallback(async (touchedRows?: string[]) => {
    await load({ fresh: true, quiet: true })
    if (touchedRows?.length) {
      setHighlighted(new Set(touchedRows))
      setTimeout(() => setHighlighted(new Set()), 1400)
    }
  }, [load])

  const totals: Totals = useMemo(() => (doc ? computeTotals(doc) : { total: 0, count: 0, min: 0, max: 0, mean: 0, byColumn: {} }), [doc])
  const rows = useMemo(() => (doc ? liveRows(doc) : []), [doc])

  return {
    doc,
    rows,
    totals,
    loading,
    state,
    error,
    highlighted,
    dirty: queue.current.length > 0,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
    historyVersion,
    actions: {
      setCell, addRow, addRows, deleteRows, moveRow,
      addColumn, renameColumn, retypeColumn, deleteColumn,
      renameDoc, setDuration, setCurrency,
      undo, redo, saveNow, refresh: () => load({ fresh: true }),
      resolveConflict, adoptRemote,
    },
  }
}

export type SheetApi = ReturnType<typeof useSheet>
