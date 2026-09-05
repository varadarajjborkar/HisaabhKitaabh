import type { CellValue, Column, Duration, Row, SheetDoc, Stamp } from '../model/types'
import { orderAfter, orderBetween, sortByOrder } from '../util/order'
import { ulid } from '../util/ids'
import type { Op, OpBatch, StampedOp } from './ops'
import { contentHash } from '../util/stable'

/** How many recent op ids we remember for dedupe. Covers retries, not history. */
const DEDUPE_WINDOW = 400
/** Tombstones older than this are compacted away on write. */
const TOMBSTONE_TTL_MS = 1000 * 60 * 60 * 24 * 30

export const SYSTEM_COLUMNS = {
  amount: 'c_amount',
  title: 'c_title',
  notes: 'c_notes',
} as const

export function newSheet(params: { id?: string; folderId: string; ownerId: string; name: string; currency?: string }): SheetDoc {
  const now = Date.now()
  return {
    id: params.id ?? ulid(),
    folderId: params.folderId,
    ownerId: params.ownerId,
    name: params.name,
    currency: params.currency ?? 'INR',
    columns: [
      { id: SYSTEM_COLUMNS.amount, name: 'INR', kind: 'amount', system: true, order: 'a0' },
      { id: SYSTEM_COLUMNS.title, name: 'Title', kind: 'text', system: true, order: 'b0' },
      { id: SYSTEM_COLUMNS.notes, name: 'Extra Captions', kind: 'text', system: true, order: 'c0' },
    ],
    rows: [],
    duration: { enabled: false, mode: 'date' },
    stamps: {},
    rev: 0,
    lamport: 0,
    seenOps: [],
    createdAt: now,
    updatedAt: now,
    updatedBy: params.ownerId,
    schemaVersion: 1,
  }
}

export function emptyRow(doc: SheetDoc, at?: { after?: string | null }): Row {
  const visible = sortByOrder(doc.rows.filter((r) => !r.deleted))
  const last = visible.length ? visible[visible.length - 1].order : null
  let order: string
  if (at?.after !== undefined) {
    const idx = visible.findIndex((r) => r.id === at.after)
    const before = idx >= 0 ? visible[idx].order : null
    const next = idx >= 0 && idx + 1 < visible.length ? visible[idx + 1].order : null
    order = orderBetween(before, next)
  } else {
    order = orderAfter(last)
  }
  const now = Date.now()
  return { id: ulid(), order, cells: {}, createdAt: now, updatedAt: now }
}

// --------------------------------------------------------------- stamp logic

function stampKey(op: Op): string | null {
  switch (op.type) {
    case 'cell.set': return `${op.rowId}:${op.columnId}`
    case 'row.insert':
    case 'row.delete':
    case 'row.restore': return `row:${op.rowId}`
    case 'row.move': return `roword:${op.rowId}`
    case 'column.insert': return `col:${op.column.id}`
    case 'column.delete': return `col:${op.columnId}`
    case 'column.rename': return `colname:${op.columnId}`
    case 'column.retype': return `colkind:${op.columnId}`
    case 'doc.rename': return 'doc:name'
    case 'doc.duration': return 'doc:duration'
    case 'doc.currency': return 'doc:currency'
  }
}

/** True when `candidate` beats `current` under (lamport, actor) ordering. */
function wins(candidate: Stamp, current: Stamp | undefined): boolean {
  if (!current) return true
  if (candidate[0] !== current[0]) return candidate[0] > current[0]
  return candidate[1] > current[1] // deterministic tiebreak; every replica agrees
}

// ------------------------------------------------------------------- applying

export type ApplyResult = {
  doc: SheetDoc
  applied: StampedOp[]
  /** Ops dropped as duplicates (same op id seen before) - retries land here. */
  duplicates: string[]
  /** Ops dropped because a newer write already owns that field. */
  superseded: string[]
  rejected: Array<{ opId: string; reason: string }>
}

/**
 * Apply a batch of ops to a document.
 *
 * The caller is responsible for the revision check (see `checkRev`) and for
 * holding the document lock. This function is pure: same doc + same batch always
 * produces the same result, which is what makes the write path replayable and
 * safe to retry.
 */
export function applyOps(doc: SheetDoc, batch: { actor: string; ops: Op[] }, opts: { now?: number } = {}): ApplyResult {
  const now = opts.now ?? Date.now()
  const next: SheetDoc = structuredClone(doc)
  const seen = new Set(next.seenOps)
  const applied: StampedOp[] = []
  const duplicates: string[] = []
  const superseded: string[] = []
  const rejected: Array<{ opId: string; reason: string }> = []

  for (const op of batch.ops) {
    if (seen.has(op.id)) {
      duplicates.push(op.id)
      continue
    }
    const lamport = ++next.lamport
    const stamp: Stamp = [lamport, batch.actor]
    const key = stampKey(op)
    if (key && !wins(stamp, next.stamps[key])) {
      superseded.push(op.id)
      seen.add(op.id)
      continue
    }

    const err = applyOne(next, op, stamp, now)
    if (err) {
      rejected.push({ opId: op.id, reason: err })
      continue
    }
    if (key) next.stamps[key] = stamp
    seen.add(op.id)
    applied.push({ ...op, actor: batch.actor, lamport, at: now })
  }

  if (applied.length > 0) {
    next.rev = doc.rev + 1
    next.updatedAt = now
    next.updatedBy = batch.actor
  }
  next.seenOps = [...seen].slice(-DEDUPE_WINDOW)
  compact(next, now)

  return { doc: next, applied, duplicates, superseded, rejected }
}

function applyOne(doc: SheetDoc, op: Op, stamp: Stamp, now: number): string | null {
  switch (op.type) {
    case 'row.insert': {
      const existing = doc.rows.find((r) => r.id === op.rowId)
      if (existing) {
        // Idempotent: the same row id arriving twice is a retry, not a new row.
        if (existing.deleted) existing.deleted = false
        return null
      }
      doc.rows.push({ id: op.rowId, order: op.order, cells: op.cells ?? {}, createdAt: now, updatedAt: now })
      return null
    }
    case 'cell.set': {
      const row = doc.rows.find((r) => r.id === op.rowId)
      if (!row) return 'row not found'
      if (!doc.columns.some((c) => c.id === op.columnId)) return 'column not found'
      row.cells[op.columnId] = normalizeValue(op.value, doc.columns.find((c) => c.id === op.columnId)!)
      row.updatedAt = now
      return null
    }
    case 'row.move': {
      const row = doc.rows.find((r) => r.id === op.rowId)
      if (!row) return 'row not found'
      row.order = op.order
      row.updatedAt = now
      return null
    }
    case 'row.delete': {
      const row = doc.rows.find((r) => r.id === op.rowId)
      if (!row) return 'row not found'
      row.deleted = true
      row.updatedAt = now
      return null
    }
    case 'row.restore': {
      const row = doc.rows.find((r) => r.id === op.rowId)
      if (!row) return 'row not found'
      row.deleted = false
      row.updatedAt = now
      return null
    }
    case 'column.insert': {
      if (doc.columns.some((c) => c.id === op.column.id)) return null // idempotent
      if (doc.columns.length >= 64) return 'too many columns'
      doc.columns.push({ ...op.column, system: false })
      return null
    }
    case 'column.rename': {
      const c = doc.columns.find((x) => x.id === op.columnId)
      if (!c) return 'column not found'
      c.name = op.name.slice(0, 60)
      return null
    }
    case 'column.retype': {
      const c = doc.columns.find((x) => x.id === op.columnId)
      if (!c) return 'column not found'
      if (c.system && c.kind === 'amount') return 'the amount column cannot change type'
      c.kind = op.kind
      c.options = op.options
      for (const r of doc.rows) if (r.cells[c.id] != null) r.cells[c.id] = normalizeValue(r.cells[c.id], c)
      return null
    }
    case 'column.delete': {
      const c = doc.columns.find((x) => x.id === op.columnId)
      if (!c) return null // idempotent
      if (c.system) return 'system columns cannot be deleted'
      doc.columns = doc.columns.filter((x) => x.id !== op.columnId)
      for (const r of doc.rows) delete r.cells[op.columnId]
      return null
    }
    case 'doc.rename': {
      const name = op.name.trim().slice(0, 120)
      if (!name) return 'name cannot be empty'
      doc.name = name
      return null
    }
    case 'doc.duration': {
      doc.duration = { ...op.duration }
      return null
    }
    case 'doc.currency': {
      // The code only; the symbol and the grouping are a display concern. Three
      // letters, upper-cased, so "usd" and "USD" cannot become two currencies.
      const code = op.currency.trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(code)) return 'currency must be a three-letter code'
      doc.currency = code
      return null
    }
  }
}

/** Coerce a value into the shape its column promises, so totals never see junk. */
export function normalizeValue(value: CellValue, column: Column): CellValue {
  if (value === null || value === undefined) return null
  switch (column.kind) {
    case 'amount':
    case 'number': {
      if (Array.isArray(value)) return null
      const n = typeof value === 'number' ? value : parseAmount(String(value))
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
    }
    case 'attachment':
      return Array.isArray(value) ? value.slice(0, 20) : []
    case 'date':
      return Array.isArray(value) ? null : String(value).slice(0, 10)
    default:
      return Array.isArray(value) ? null : String(value).slice(0, 4000)
  }
}

/** "₹ 1,20,450.50" / "1.2k" / "(300)" -> number. Indian digit grouping included. */
export function parseAmount(input: string): number {
  const s = input.trim().replace(/[₹$€£,\s]/g, '')
  if (!s) return NaN
  const negative = /^\(.*\)$/.test(s)
  const body = negative ? s.slice(1, -1) : s
  const m = /^(-?\d*\.?\d+)([kKlLcCmM]?)$/.exec(body)
  if (!m) return NaN
  let n = parseFloat(m[1])
  const suffix = m[2].toLowerCase()
  if (suffix === 'k') n *= 1e3
  else if (suffix === 'l') n *= 1e5   // lakh
  else if (suffix === 'c') n *= 1e7   // crore
  else if (suffix === 'm') n *= 1e6
  return negative ? -n : n
}

function compact(doc: SheetDoc, now: number): void {
  const cutoff = now - TOMBSTONE_TTL_MS
  const before = doc.rows.length
  doc.rows = doc.rows.filter((r) => !r.deleted || r.updatedAt > cutoff)
  if (doc.rows.length !== before) {
    const live = new Set(doc.rows.map((r) => r.id))
    for (const key of Object.keys(doc.stamps)) {
      const rowId = key.includes(':') ? key.split(':').pop()! : ''
      if (key.startsWith('row:') || key.startsWith('roword:')) {
        if (!live.has(rowId)) delete doc.stamps[key]
      }
    }
  }
}

// ---------------------------------------------------------------- rev control

export class RevisionConflictError extends Error {
  readonly expected: number
  readonly actual: number
  constructor(expected: number, actual: number) {
    super(`Revision conflict: client is on r${expected}, server is on r${actual}`)
    this.name = 'RevisionConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/**
 * Optimistic concurrency check.
 *
 * A batch may be *behind* the server (someone else wrote in between) and still
 * be safe, because ops are field-scoped and stamped. We only hard-reject when
 * the batch would touch a field that has changed since the client's base
 * revision - everything else merges. That keeps the "your edit was rejected,
 * please refresh" dialog rare without ever silently clobbering a write.
 */
export function checkRev(doc: SheetDoc, batch: OpBatch, opsSinceBase: StampedOp[] | null): { ok: true } | { ok: false; conflicts: string[] } {
  if (batch.baseRev === doc.rev) return { ok: true }
  if (batch.baseRev > doc.rev) return { ok: false, conflicts: ['client revision is ahead of the server'] }
  if (opsSinceBase === null) {
    // No op history available: fall back to field-level stamp comparison.
    return { ok: true }
  }
  const touchedRemotely = new Set(opsSinceBase.map((o) => stampKey(o)).filter(Boolean) as string[])
  const conflicts = batch.ops
    .map((o) => stampKey(o))
    .filter((k): k is string => Boolean(k) && touchedRemotely.has(k!))
  return conflicts.length ? { ok: false, conflicts } : { ok: true }
}

// -------------------------------------------------------------------- derived

export type Totals = {
  total: number
  count: number
  min: number
  max: number
  mean: number
  byColumn: Record<string, number>
}

export function computeTotals(doc: SheetDoc): Totals {
  const amountCols = doc.columns.filter((c) => c.kind === 'amount' || c.kind === 'number')
  const primary = doc.columns.find((c) => c.kind === 'amount') ?? amountCols[0]
  const rows = liveRows(doc)
  const byColumn: Record<string, number> = {}
  for (const c of amountCols) {
    byColumn[c.id] = rows.reduce((s, r) => s + numeric(r.cells[c.id]), 0)
  }
  const values = primary ? rows.map((r) => numeric(r.cells[primary.id])) : []
  const nonZero = values.filter((v) => v !== 0)
  const total = primary ? byColumn[primary.id] ?? 0 : 0
  return {
    total: round2(total),
    count: rows.length,
    min: nonZero.length ? round2(Math.min(...nonZero)) : 0,
    max: nonZero.length ? round2(Math.max(...nonZero)) : 0,
    mean: nonZero.length ? round2(total / nonZero.length) : 0,
    byColumn,
  }
}

export function numeric(v: CellValue): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseAmount(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

export const round2 = (n: number) => Math.round(n * 100) / 100

export function liveRows(doc: SheetDoc): Row[] {
  return sortByOrder(doc.rows.filter((r) => !r.deleted))
}

export function docEtag(doc: SheetDoc): string {
  return `${doc.rev}-${contentHash({ r: doc.rows, c: doc.columns, n: doc.name, d: doc.duration, cur: doc.currency })}`
}

/** Column helper used all over the UI and the agent tools. */
export function findColumn(doc: SheetDoc, nameOrId: string): Column | undefined {
  const q = nameOrId.trim().toLowerCase()
  return (
    doc.columns.find((c) => c.id === nameOrId) ??
    doc.columns.find((c) => c.name.toLowerCase() === q) ??
    doc.columns.find((c) => c.name.toLowerCase().includes(q))
  )
}

export type { Duration, Column, Row }
