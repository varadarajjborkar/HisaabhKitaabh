import type { CellValue, Column, Duration, Row } from '../model/types'

/**
 * Operation types.
 *
 * Mutations travel as *operations*, never as whole-document PUTs. That's what
 * lets a human edit and an agent edit land in either order without one erasing
 * the other: each op touches exactly the fields it names, and every field
 * carries its own version stamp.
 */
export type Op =
  | { id: string; type: 'row.insert'; rowId: string; order: string; cells?: Record<string, CellValue> }
  | { id: string; type: 'cell.set'; rowId: string; columnId: string; value: CellValue }
  | { id: string; type: 'row.move'; rowId: string; order: string }
  | { id: string; type: 'row.delete'; rowId: string }
  | { id: string; type: 'row.restore'; rowId: string }
  | { id: string; type: 'column.insert'; column: Column }
  | { id: string; type: 'column.rename'; columnId: string; name: string }
  | { id: string; type: 'column.retype'; columnId: string; kind: Column['kind']; options?: string[] }
  | { id: string; type: 'column.delete'; columnId: string }
  | { id: string; type: 'doc.rename'; name: string }
  | { id: string; type: 'doc.duration'; duration: Duration }
  | { id: string; type: 'doc.currency'; currency: string }

export type OpType = Op['type']

/** An op plus the provenance we need for stamping and for the audit trail. */
export type StampedOp = Op & { actor: string; lamport: number; at: number }

export type OpBatch = {
  /** Revision the client believes it is editing. Server rejects if it has moved on. */
  baseRev: number
  actor: string
  ops: Op[]
  /** Optional label shown in the undo stack and the activity log. */
  label?: string
}

/** Human-readable one-liner for an op - used in the AI approval dialog. */
export function describeOp(op: Op, columns: Column[], rows: Row[]): string {
  const col = (id: string) => columns.find((c) => c.id === id)?.name ?? id
  const rowLabel = (id: string) => {
    const r = rows.find((x) => x.id === id)
    if (!r) return 'new row'
    const titleCol = columns.find((c) => c.kind === 'text' && c.system)
    const t = titleCol ? r.cells[titleCol.id] : null
    return typeof t === 'string' && t ? `"${t}"` : `row ${id.slice(-4)}`
  }
  switch (op.type) {
    case 'row.insert': return `Add a row`
    case 'cell.set': return `Set ${col(op.columnId)} on ${rowLabel(op.rowId)} to ${formatValue(op.value)}`
    case 'row.move': return `Reorder ${rowLabel(op.rowId)}`
    case 'row.delete': return `Delete ${rowLabel(op.rowId)}`
    case 'row.restore': return `Restore ${rowLabel(op.rowId)}`
    case 'column.insert': return `Add column "${op.column.name}" (${op.column.kind})`
    case 'column.rename': return `Rename column ${col(op.columnId)} to "${op.name}"`
    case 'column.retype': return `Change column ${col(op.columnId)} to ${op.kind}`
    case 'column.delete': return `Delete column ${col(op.columnId)}`
    case 'doc.rename': return `Rename this file to "${op.name}"`
    case 'doc.duration': return op.duration.enabled ? `Set period to ${op.duration.from ?? '…'} → ${op.duration.to ?? '…'}` : `Turn off the period`
    case 'doc.currency': return `Record amounts in ${op.currency}`
  }
}

function formatValue(v: CellValue): string {
  if (v === null || v === '') return 'empty'
  if (Array.isArray(v)) return `${v.length} attachment${v.length === 1 ? '' : 's'}`
  return `"${String(v)}"`
}

/** Build the inverse of an op against the pre-state - the basis of undo. */
export function invertOp(op: Op, before: { rows: Row[]; columns: Column[]; name: string; duration: Duration; currency: string }, nextId: () => string): Op | null {
  const row = before.rows.find((r) => r.id === (op as { rowId?: string }).rowId)
  switch (op.type) {
    case 'row.insert':
      return { id: nextId(), type: 'row.delete', rowId: op.rowId }
    case 'row.delete':
      return row ? { id: nextId(), type: 'row.restore', rowId: op.rowId } : null
    case 'row.restore':
      return { id: nextId(), type: 'row.delete', rowId: op.rowId }
    case 'cell.set':
      return { id: nextId(), type: 'cell.set', rowId: op.rowId, columnId: op.columnId, value: row?.cells[op.columnId] ?? null }
    case 'row.move':
      return row ? { id: nextId(), type: 'row.move', rowId: op.rowId, order: row.order } : null
    case 'column.insert':
      return { id: nextId(), type: 'column.delete', columnId: op.column.id }
    case 'column.rename': {
      const c = before.columns.find((x) => x.id === op.columnId)
      return c ? { id: nextId(), type: 'column.rename', columnId: op.columnId, name: c.name } : null
    }
    case 'column.retype': {
      const c = before.columns.find((x) => x.id === op.columnId)
      return c ? { id: nextId(), type: 'column.retype', columnId: op.columnId, kind: c.kind, options: c.options } : null
    }
    case 'column.delete': {
      const c = before.columns.find((x) => x.id === op.columnId)
      return c ? { id: nextId(), type: 'column.insert', column: c } : null
    }
    case 'doc.rename':
      return { id: nextId(), type: 'doc.rename', name: before.name }
    case 'doc.duration':
      return { id: nextId(), type: 'doc.duration', duration: before.duration }
    case 'doc.currency':
      return { id: nextId(), type: 'doc.currency', currency: before.currency }
  }
}
