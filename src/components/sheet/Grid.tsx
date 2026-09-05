'use client'

import { useRef, useState } from 'react'
import type { Column, Row, SheetDoc } from '@/lib/model/types'
import { Cell } from './Cell'
import { Icon } from '../ui/Icons'
import { formatINR } from '@/lib/util/format'
import { numeric } from '@/lib/crdt/doc'
import type { SheetApi } from '@/lib/client/useSheet'
import { ColumnMenu, ColumnsModal, NewColumnButton } from './ColumnMenu'
import { dropEdge, useDragReorder } from '@/lib/client/useDragReorder'

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
        <div className="sticky top-0 z-20 flex items-center gap-2 px-3 py-2 mb-2 rounded-lg
                        bg-accent-soft border border-line animate-rise no-print">
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
  const drag = useDragReorder((from, to) => actions.moveRow(rows[from].id, to))

  /**
   * Keyboard movement between cells.
   *
   * Enter moves down and stops at the last row. Tab past the final cell of the
   * final row is what adds a new one: that gesture reads as "keep going", where
   * Enter reads as "done with this value".
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
        <table className="w-full border-collapse min-w-[680px]">
          <thead>
            <tr className="border-b border-line">
              <th className="w-16 px-2 py-2 no-print" aria-label="Row controls" />
              {columns.map((col) => (
                <th
                  key={col.id}
                  className={`px-2.5 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted align-bottom
                              ${col.kind === 'amount' || col.kind === 'number' ? 'text-right' : 'text-left'}`}
                  style={{ width: col.kind === 'amount' ? 132 : col.kind === 'attachment' ? 190 : undefined }}
                >
                  <ColumnMenu column={col} sheet={sheet} />
                </th>
              ))}
              <th className="w-10 px-1 py-2 no-print">
                <NewColumnButton sheet={sheet} />
              </th>
            </tr>
          </thead>

          <tbody ref={(el) => { drag.containerRef.current = el }}>
            {rows.map((row, rowIndex) => {
              const edge = dropEdge(drag, rowIndex, rows.length)
              return (
                <tr
                  key={row.id}
                  data-drag-index={rowIndex}
                  className={`border-b border-line last:border-0 group transition-colors animate-row-in
                              ${selected.has(row.id) ? 'bg-accent-soft/50' : 'hover:bg-raised/50'}
                              ${highlighted.has(row.id) ? 'flash-change' : ''}
                              ${drag.from === rowIndex ? 'dragging-row' : ''}
                              ${edge === 'above' ? 'drop-line-above' : edge === 'below' ? 'drop-line-below' : ''}`}
                >
                  <td className="no-print align-middle">
                    <div className="flex items-center gap-0.5 pl-1.5 pr-1">
                      <span
                        {...drag.handleProps(rowIndex)}
                        role="button"
                        tabIndex={-1}
                        aria-label={`Reorder row ${rowIndex + 1}`}
                        title="Drag to reorder"
                        className="h-7 w-5 grid place-items-center rounded text-faint opacity-0
                                   group-hover:opacity-100 hover:text-ink hover:bg-raised transition-all select-none"
                      >
                        <Icon.Grip size={14} />
                      </span>
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggle(row.id)}
                        className="accent-accent w-3.5 h-3.5 opacity-0 group-hover:opacity-100 focus:opacity-100 checked:opacity-100 transition-opacity"
                        aria-label={`Select row ${rowIndex + 1}`}
                      />
                    </div>
                  </td>

                  {columns.map((col, colIndex) => (
                    <td key={col.id} data-cell={`${row.id}:${col.id}`} className="align-middle px-0.5 py-0.5">
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

                  <td className="px-1 no-print align-middle">
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
              )
            })}

            {rows.length === 0 && (
              /* Marked so it is never mistaken for a data row: not by a screen
                 reader, not by a test, not by anything else counting rows. */
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
                  <td key={col.id} className={`px-2.5 py-3 text-[13px] ${col.kind === 'amount' || col.kind === 'number' ? 'text-right tnum font-semibold' : 'text-left text-muted'}`}>
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

      <button onClick={() => addAndFocus(gridRef.current, actions, columns[0]?.id)} className="btn-ghost mt-2.5 text-[12.5px] pressable no-print">
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
  const [columnsOpen, setColumnsOpen] = useState(false)
  const drag = useDragReorder((from, to) => actions.moveRow(rows[from].id, to))

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  /**
   * One line summarising the fields that are folded away.
   *
   * The collapsed card used to say "3 more fields", which is a count of things
   * you cannot see rather than a look at them. Showing the values themselves
   * means most rows never need expanding at all, and the chevron is there for
   * the ones that do.
   */
  const restSummary = (row: Row) =>
    rest
      .map((col) => {
        const v = row.cells[col.id]
        if (v == null || v === '') return null
        if (Array.isArray(v)) return v.length ? `${v.length} file${v.length === 1 ? '' : 's'}` : null
        return String(v)
      })
      .filter(Boolean)
      .join(' · ')

  return (
    <div className="md:hidden">
      {/*
        A header line above the cards.

        Without it the two halves of a card are just text at opposite ends, and
        which one is the amount has to be inferred from it being a number. The
        offset matches the row below it exactly - grip, checkbox, gap - so the
        labels sit over the things they name.
      */}
      <div className="flex items-center pl-[58px] pr-2 pb-1.5 text-[10px] uppercase tracking-wide text-faint">
        <span className="min-w-0 flex-1 truncate">{titleCol?.name ?? 'Item'}</span>
        {amountCol && <span className="w-[104px] shrink-0 pl-2 text-right">{amountCol.name}</span>}
      </div>

      <div className="space-y-2" ref={(el) => { drag.containerRef.current = el }}>
        {rows.map((row, index) => {
          const open = expanded.has(row.id)
          const edge = dropEdge(drag, index, rows.length)
          const summary = restSummary(row)
          return (
            <div
              key={row.id}
              data-drag-index={index}
              className={`card px-2 py-2 animate-row-in transition-colors
                          ${selected.has(row.id) ? 'border-accent/50 bg-accent-soft/40' : ''}
                          ${highlighted.has(row.id) ? 'flash-change' : ''}
                          ${drag.from === index ? 'dragging-row' : ''}
                          ${edge === 'above' ? 'drop-line-above' : edge === 'below' ? 'drop-line-below' : ''}`}
            >
              <div className="flex items-center gap-1">
                <span
                  {...drag.handleProps(index)}
                  role="button"
                  tabIndex={-1}
                  aria-label={`Reorder row ${index + 1}`}
                  className="h-11 w-6 grid place-items-center rounded text-faint active:text-accent active:bg-raised shrink-0 select-none"
                >
                  <Icon.Grip size={16} />
                </span>

                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                  className="accent-accent w-[18px] h-[18px] shrink-0 mr-1"
                  aria-label={`Select row ${index + 1}`}
                />

                <div className="min-w-0 flex-1">
                  {titleCol && (
                    <Cell column={titleCol} value={row.cells[titleCol.id] ?? null} rowId={row.id} fileId={doc.id}
                          size="lg" onChange={(v) => actions.setCell(row.id, titleCol.id, v)} />
                  )}
                </div>

                {/*
                  The one rule that earns its pixel: a title and an amount are
                  different kinds of thing, and on a phone they are two pieces
                  of text at opposite ends of a line with nothing between them.
                  self-stretch so it spans the row rather than the number.
                */}
                {amountCol && (
                  <div className="w-[104px] shrink-0 self-stretch flex items-center pl-2 border-l border-line">
                    <Cell column={amountCol} value={row.cells[amountCol.id] ?? null} rowId={row.id} fileId={doc.id}
                          size="lg" onChange={(v) => actions.setCell(row.id, amountCol.id, v)} />
                  </div>
                )}
              </div>

              {rest.length > 0 && (
                <>
                  <button
                    onClick={() => toggleExpand(row.id)}
                    className="w-full flex items-center gap-1.5 pl-8 pr-1 py-2.5 min-h-[38px] mt-1.5
                               border-t border-line text-left active:bg-raised transition-colors"
                    aria-expanded={open}
                  >
                    <span className={`text-[12px] flex-1 min-w-0 truncate ${summary ? 'text-muted' : 'text-faint'}`}>
                      {open ? 'Hide fields' : summary || `Add ${rest.map((c) => c.name.toLowerCase()).slice(0, 2).join(', ')}`}
                    </span>
                    <Icon.Down size={14} className={`text-faint shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                  </button>

                  {open && (
                    <div className="mt-1 ml-8 mr-1 space-y-2 animate-rise">
                      {rest.map((col) => (
                        <div key={col.id}>
                          <span className="block text-[11px] font-medium text-muted mb-0.5">{col.name}</span>
                          <Cell column={col} value={row.cells[col.id] ?? null} rowId={row.id} fileId={doc.id}
                                size="lg" variant="field" onChange={(v) => actions.setCell(row.id, col.id, v)} />
                        </div>
                      ))}
                      <div className="flex items-center gap-3 pt-1">
                        <button
                          onClick={() => setColumnsOpen(true)}
                          className="h-9 -ml-1.5 px-1.5 rounded text-[12px] text-accent flex items-center gap-1.5 active:bg-accent-soft"
                        >
                          <Icon.Plus size={14} /> Add a column
                        </button>
                        <button
                          onClick={() => actions.deleteRows([row.id])}
                          className="h-9 -mr-1.5 px-1.5 rounded text-[12px] text-bad flex items-center gap-1.5 ml-auto active:bg-bad/10"
                        >
                          <Icon.Trash size={14} /> Delete row
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {rows.length === 0 && (
        <div className="card p-8 text-center">
          <Icon.File size={22} className="mx-auto text-faint" />
          <p className="text-[13px] font-medium mt-2.5">No rows yet</p>
          <p className="text-[12px] text-muted mt-1">An amount and a title is all a row needs.</p>
        </div>
      )}

      <button onClick={() => actions.addRow()} className="btn-primary w-full h-12 mt-2.5 text-[14px] pressable">
        <Icon.Plus size={17} /> Add row
      </button>

      {rows.length > 0 && (
        <div className="card px-3.5 py-3 mt-2.5 flex items-center justify-between">
          <span className="text-[12.5px] text-muted">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
          <span className="text-[17px] font-semibold tnum">{formatINR(totals.total)}</span>
        </div>
      )}

      <ColumnsModal open={columnsOpen} onClose={() => setColumnsOpen(false)} sheet={sheet} />
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
