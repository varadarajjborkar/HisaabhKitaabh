'use client'

import { useRef, useState } from 'react'
import type { Column, Row, SheetDoc } from '@/lib/model/types'
import { Cell } from './Cell'
import { Icon } from '../ui/Icons'
import { formatINR } from '@/lib/util/format'
import { numeric } from '@/lib/crdt/doc'
import type { SheetApi } from '@/lib/client/useSheet'
import { ColumnMenu, NewColumnButton } from './ColumnMenu'

/**
 * The rows.
 *
 * Two layouts, not one responsive compromise: a table on desktop where columns
 * align and totals read down a column, and stacked cards on phones where a
 * six-column table would mean horizontal scrolling for every edit. The data and
 * the operations are identical; only the arrangement differs.
 */
export function Grid({ sheet, onFocusCell }: { sheet: SheetApi; onFocusCell?: (rowId: string, columnId: string) => void }) {
  const { doc, rows, actions, highlighted } = sheet
  const [selected, setSelected] = useState<Set<string>>(new Set())
  if (!doc) return null

  const columns = [...doc.columns].sort((a, b) => (a.order < b.order ? -1 : 1))

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const deleteSelected = () => {
    actions.deleteRows([...selected])
    setSelected(new Set())
  }

  return (
    <>
      {selected.size > 0 && (
        <div className="sticky top-14 z-20 flex items-center gap-2 px-3 py-2 bg-accent-soft border-y border-line animate-rise no-print">
          <span className="text-[12.5px] font-medium text-accent">{selected.size} row{selected.size === 1 ? '' : 's'} selected</span>
          <button onClick={() => setSelected(new Set())} className="btn-ghost h-7 text-[12px]">Clear</button>
          <button onClick={deleteSelected} className="btn-ghost h-7 text-[12px] text-bad ml-auto pressable">
            <Icon.Trash size={14} /> Delete
          </button>
        </div>
      )}

      <DesktopTable doc={doc} rows={rows} columns={columns} sheet={sheet} selected={selected} toggle={toggle} highlighted={highlighted} onFocusCell={onFocusCell} />
      <MobileCards doc={doc} rows={rows} columns={columns} sheet={sheet} selected={selected} toggle={toggle} highlighted={highlighted} />
    </>
  )
}

type SharedProps = {
  doc: SheetDoc
  rows: Row[]
  columns: Column[]
  sheet: SheetApi
  selected: Set<string>
  toggle: (id: string) => void
  highlighted: Set<string>
  onFocusCell?: (rowId: string, columnId: string) => void
}

function DesktopTable({ doc, rows, columns, sheet, selected, toggle, highlighted, onFocusCell }: SharedProps) {
  const { actions, totals } = sheet
  const gridRef = useRef<HTMLDivElement>(null)

  /**
   * Keyboard movement between cells.
   *
   * Enter moves down and stops at the last row. Tab past the final cell of the
   * final row is what adds a new one — that gesture reads as "keep going",
   * where Enter reads as "done with this value".
   *
   * The distinction matters for undo. When Enter auto-appended a row, the last
   * thing on the undo stack after editing the bottom cell was a phantom empty
   * row, so Ctrl+Z removed a row the user never knowingly created instead of
   * reversing the edit they had just made. It also quietly accumulated blank
   * rows in the file.
   */
  const navigate = (rowIndex: number, colIndex: number, dir: 'up' | 'down' | 'next' | 'prev') => {
    let r = rowIndex
    let c = colIndex
    let append = false

    if (dir === 'up') r--
    else if (dir === 'down') r++
    else if (dir === 'next') { c++; if (c >= columns.length) { c = 0; r++; append = true } }
    else { c--; if (c < 0) { c = columns.length - 1; r-- } }

    if (r < 0 || c < 0) return
    if (r >= rows.length) {
      if (!append) return // Enter at the bottom simply commits and stays put.
      const id = actions.addRow()
      if (id) requestAnimationFrame(() => focusCell(gridRef.current, id, columns[0].id))
      return
    }
    focusCell(gridRef.current, rows[r].id, columns[c].id)
  }

  return (
    <div ref={gridRef} className="hidden md:block">
      <div className="card overflow-x-auto">
        <table className="w-full border-collapse min-w-[640px]">
          <thead>
            <tr className="border-b border-line">
              <th className="w-9 px-2 py-2 no-print" />
              {columns.map((col) => (
                <th
                  key={col.id}
                  className={`px-2 py-2 text-[11px] font-medium uppercase tracking-wide text-muted
                              ${col.kind === 'amount' || col.kind === 'number' ? 'text-right' : 'text-left'}`}
                  style={{ width: col.kind === 'amount' ? 130 : col.kind === 'attachment' ? 190 : undefined }}
                >
                  <ColumnMenu column={col} sheet={sheet} />
                </th>
              ))}
              <th className="w-10 px-1 py-2 no-print">
                <NewColumnButton sheet={sheet} />
              </th>
            </tr>
          </thead>

          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                key={row.id}
                className={`border-b border-line last:border-0 group transition-colors animate-row-in
                            ${selected.has(row.id) ? 'bg-accent-soft/50' : 'hover:bg-raised/50'}
                            ${highlighted.has(row.id) ? 'flash-change' : ''}`}
              >
                <td className="px-2 no-print align-middle">
                  <input
                    type="checkbox"
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                    className="accent-accent w-3.5 h-3.5 opacity-0 group-hover:opacity-100 focus:opacity-100 checked:opacity-100 transition-opacity"
                    aria-label={`Select row ${rowIndex + 1}`}
                  />
                </td>

                {columns.map((col, colIndex) => (
                  <td key={col.id} data-cell={`${row.id}:${col.id}`} className="align-middle">
                    <Cell
                      column={col}
                      value={row.cells[col.id] ?? null}
                      rowId={row.id}
                      fileId={doc.id}
                      onChange={(v) => actions.setCell(row.id, col.id, v)}
                      onNavigate={(dir) => navigate(rowIndex, colIndex, dir)}
                    />
                  </td>
                ))}

                <td className="px-1 no-print">
                  <button
                    onClick={() => actions.deleteRows([row.id])}
                    className="h-7 w-7 grid place-items-center rounded text-faint opacity-0 group-hover:opacity-100
                               focus:opacity-100 hover:text-bad hover:bg-bad/10 transition-all"
                    aria-label="Delete row"
                  >
                    <Icon.Trash size={14} />
                  </button>
                </td>
              </tr>
            ))}

            {rows.length === 0 && (
              /* Marked so it is never mistaken for a data row — by a screen
                 reader, by a test, or by anything else counting rows. */
              <tr data-placeholder="empty">
                <td colSpan={columns.length + 2} className="px-4 py-10 text-center text-[13px] text-faint">
                  No rows yet. Add one below, or ask the assistant.
                </td>
              </tr>
            )}
          </tbody>

          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-line bg-raised/40">
                <td className="no-print" />
                {columns.map((col) => (
                  <td key={col.id} className={`px-2 py-2.5 text-[13px] ${col.kind === 'amount' || col.kind === 'number' ? 'text-right tnum font-semibold' : 'text-left text-muted'}`}>
                    {col.kind === 'amount'
                      ? formatINR(totals.byColumn[col.id] ?? 0)
                      : col.kind === 'number'
                        ? (totals.byColumn[col.id] ?? 0).toLocaleString('en-IN')
                        : col.id === columns.find((c) => c.kind === 'text')?.id
                          ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
                          : ''}
                  </td>
                ))}
                <td className="no-print" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <button onClick={() => addAndFocus(gridRef.current, actions, columns[0]?.id)} className="btn-ghost mt-2 text-[12.5px] pressable no-print">
        <Icon.Plus size={15} /> Add row
      </button>
    </div>
  )
}

function MobileCards({ doc, rows, columns, sheet, selected, toggle, highlighted }: SharedProps) {
  const { actions, totals } = sheet
  const amountCol = columns.find((c) => c.kind === 'amount')
  const titleCol = columns.find((c) => c.kind === 'text' && c.system)
  const rest = columns.filter((c) => c.id !== amountCol?.id && c.id !== titleCol?.id)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="md:hidden space-y-2">
      {rows.map((row) => {
        const open = expanded.has(row.id)
        return (
          <div
            key={row.id}
            className={`card px-3 py-2.5 animate-row-in transition-colors
                        ${selected.has(row.id) ? 'border-accent/50 bg-accent-soft/40' : ''}
                        ${highlighted.has(row.id) ? 'flash-change' : ''}`}
          >
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                onChange={() => toggle(row.id)}
                className="accent-accent w-4 h-4 mt-2 shrink-0"
                aria-label="Select row"
              />

              <div className="min-w-0 flex-1">
                {titleCol && (
                  <Cell column={titleCol} value={row.cells[titleCol.id] ?? null} rowId={row.id} fileId={doc.id}
                        onChange={(v) => actions.setCell(row.id, titleCol.id, v)} />
                )}
              </div>

              {amountCol && (
                <div className="w-[104px] shrink-0">
                  <Cell column={amountCol} value={row.cells[amountCol.id] ?? null} rowId={row.id} fileId={doc.id}
                        onChange={(v) => actions.setCell(row.id, amountCol.id, v)} />
                </div>
              )}
            </div>

            {rest.length > 0 && (
              <>
                <button
                  onClick={() => toggleExpand(row.id)}
                  className="text-[11.5px] text-faint hover:text-muted mt-1 flex items-center gap-1 transition-colors"
                  aria-expanded={open}
                >
                  <Icon.Down size={12} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                  {open ? 'Fewer fields' : `${rest.length} more field${rest.length === 1 ? '' : 's'}`}
                </button>

                {open && (
                  <div className="mt-1.5 space-y-1.5 animate-rise">
                    {rest.map((col) => (
                      <div key={col.id} className="flex items-center gap-2">
                        <span className="text-[11.5px] text-muted w-24 shrink-0 truncate">{col.name}</span>
                        <div className="flex-1 min-w-0">
                          <Cell column={col} value={row.cells[col.id] ?? null} rowId={row.id} fileId={doc.id}
                                onChange={(v) => actions.setCell(row.id, col.id, v)} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}

      {rows.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-[13px] text-faint">No rows yet.</p>
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={() => actions.addRow()} className="btn-outline flex-1 h-11 pressable">
          <Icon.Plus size={16} /> Add row
        </button>
      </div>

      {rows.length > 0 && (
        <div className="card px-3 py-2.5 flex items-center justify-between">
          <span className="text-[12px] text-muted">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
          <span className="text-[15px] font-semibold tnum">{formatINR(totals.total)}</span>
        </div>
      )}
    </div>
  )
}

function focusCell(root: HTMLElement | null, rowId: string, columnId: string) {
  const cell = root?.querySelector<HTMLElement>(`[data-cell="${rowId}:${columnId}"]`)
  cell?.querySelector<HTMLElement>('input, select')?.focus()
}

function addAndFocus(root: HTMLElement | null, actions: SheetApi['actions'], columnId?: string) {
  const id = actions.addRow()
  if (id && columnId) requestAnimationFrame(() => focusCell(root, id, columnId))
}

export { numeric }
