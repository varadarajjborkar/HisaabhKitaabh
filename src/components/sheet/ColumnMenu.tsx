'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Column, ColumnKind } from '@/lib/model/types'
import { Icon } from '../ui/Icons'
import { Modal } from '../ui/Modal'
import { useDismiss } from '@/lib/client/useDismiss'
import { CURRENCIES } from '@/lib/util/format'
import type { SheetApi } from '@/lib/client/useSheet'

const KINDS: Array<{ value: ColumnKind; label: string; hint: string }> = [
  { value: 'amount', label: 'Amount', hint: 'Money. Sums into the total.' },
  { value: 'number', label: 'Number', hint: 'A count. Never multiplied by anything.' },
  { value: 'text', label: 'Text', hint: 'Anything written.' },
  { value: 'date', label: 'Date', hint: 'A day.' },
  { value: 'select', label: 'Choice', hint: 'Pick from a fixed list.' },
  { value: 'attachment', label: 'File', hint: 'Receipts, invoices, screenshots.' },
]

/**
 * Where the menu should sit, in viewport coordinates.
 *
 * It has to be fixed and portalled rather than absolute inside the header: the
 * table lives in a card with `overflow-x-auto`, which is a clipping context, so
 * an absolutely-positioned menu taller than the visible table simply gets cut
 * off. That was survivable when the menu was three short items and stopped
 * being survivable the moment it held a currency list.
 */
function useAnchoredMenu(open: boolean, trigger: React.RefObject<HTMLElement | null>) {
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }

    const place = () => {
      const el = trigger.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 16
      const above = r.top - 16
      // Prefer below; go above only when there is meaningfully more room there.
      const flip = below < 240 && above > below
      setPos({
        left: Math.max(8, Math.min(r.left, window.innerWidth - 240)),
        top: flip ? Math.max(8, r.top - Math.min(above, 420) - 6) : r.bottom + 6,
        maxHeight: Math.max(180, Math.min(flip ? above : below, 420)),
      })
    }

    place()
    // Anything that moves the trigger moves the menu with it.
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, trigger])

  return pos
}

export function ColumnMenu({ column, sheet }: { column: Column; sheet: SheetApi }) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(column.name)
  const trigger = useRef<HTMLDivElement | null>(null)
  // The menu owns dismissal; the trigger is ignored so its own click can toggle.
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false), { ignore: trigger })
  const pos = useAnchoredMenu(open, trigger)

  const commitRename = () => {
    const trimmed = name.trim()
    if (trimmed && trimmed !== column.name) sheet.actions.renameColumn(column.id, trimmed)
    setRenaming(false)
  }

  if (renaming) {
    return (
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={commitRename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename()
          if (e.key === 'Escape') { setName(column.name); setRenaming(false) }
        }}
        autoFocus
        maxLength={60}
        className="w-full bg-surface border border-accent rounded px-1.5 py-1 text-[11px] uppercase tracking-wide outline-none"
        aria-label="Column name"
      />
    )
  }

  return (
    <div ref={trigger} className="relative inline-flex items-center gap-1 group/col max-w-full">
      <span className="truncate">{column.name}</span>
      <button
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 opacity-0 group-hover/col:opacity-100 focus:opacity-100 text-faint hover:text-ink transition-opacity no-print"
        aria-label={`Options for ${column.name}`}
        aria-expanded={open}
      >
        <Icon.Down size={12} />
      </button>

      {open && pos && createPortal(
        (
          <div
            ref={ref}
            className="fixed z-[60] w-[232px] card shadow-pop py-1 animate-scale-in origin-top-left
                       normal-case tracking-normal text-left font-normal overflow-y-auto overscroll-contain"
            style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
          >
            <button
              onClick={() => { setOpen(false); setRenaming(true) }}
              className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-raised transition-colors"
            >
              Rename
            </button>

            {/*
              The currency lives on the file, not the column, but this is where
              a user looks for it: they see a column headed INR and want it to
              say something else. Offering it anywhere but here would be asking
              them to know our data model.
            */}
            {column.kind === 'amount' && (
              <div className="border-t border-line mt-1 pt-1">
                <p className="px-3 py-1 text-[10.5px] uppercase tracking-wide text-faint">Currency</p>
                {CURRENCIES.map((c) => {
                  const active = (sheet.doc?.currency ?? 'INR').toUpperCase() === c.code
                  return (
                    <button
                      key={c.code}
                      onClick={() => { sheet.actions.setCurrency(c.code); setOpen(false) }}
                      className={`w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-raised flex items-center gap-2
                                  transition-colors ${active ? 'text-accent' : ''}`}
                    >
                      {active ? <Icon.Check size={12} /> : <span className="w-3" />}
                      <span className="w-9 shrink-0 tabular-nums">{c.code}</span>
                      <span className="w-4 shrink-0 text-muted">{c.symbol}</span>
                      <span className="truncate text-muted text-[11.5px]">{c.name}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {!column.system && (
              <div className="border-t border-line mt-1 pt-1">
                <p className="px-3 py-1 text-[10.5px] uppercase tracking-wide text-faint">Type</p>
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    onClick={() => { sheet.actions.retypeColumn(column.id, k.value, k.value === 'select' ? column.options ?? [] : undefined); setOpen(false) }}
                    className={`w-full text-left px-3 py-1.5 text-[12.5px] hover:bg-raised flex items-center gap-2 transition-colors ${
                      column.kind === k.value ? 'text-accent' : ''
                    }`}
                  >
                    {column.kind === k.value ? <Icon.Check size={12} /> : <span className="w-3" />}
                    {k.label}
                  </button>
                ))}
              </div>
            )}

            {!column.system && (
              <div className="border-t border-line mt-1 pt-1">
                <button
                  onClick={() => { sheet.actions.deleteColumn(column.id); setOpen(false) }}
                  className="w-full text-left px-3 py-2 text-[12.5px] text-bad hover:bg-raised flex items-center gap-2 transition-colors"
                >
                  <Icon.Trash size={13} /> Delete column
                </button>
              </div>
            )}

            {column.system && (
              <p className="px-3 py-2 text-[11px] text-faint border-t border-line mt-1 leading-snug">
                Built-in column. It can be renamed but not removed.
              </p>
            )}
          </div>
        ),
        document.body,
      )}
    </div>
  )
}

/**
 * The "+" that adds a column.
 *
 * This is the mechanism the whole file model rests on: three columns are given,
 * and everything else - quantity, category, a receipt slot - is something the
 * user names themselves. So it asks for a name and a type and nothing more.
 */
export function NewColumnButton({ sheet }: { sheet: SheetApi }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="h-7 w-7 grid place-items-center rounded text-faint hover:text-accent hover:bg-accent-soft transition-colors pressable"
        aria-label="Add a column"
        title="Add a column"
      >
        <Icon.Plus size={15} />
      </button>
      <AddColumnModal open={open} onClose={() => setOpen(false)} sheet={sheet} />
    </>
  )
}

/**
 * The add-column form, separated from the "+" in the table header.
 *
 * That header does not exist on a phone: the sheet renders as cards, so the
 * only way to add a column was to find a wider screen. The form is its own
 * component now, opened from the header on desktop and from the columns manager
 * on a phone.
 */
export function AddColumnModal({ open, onClose, sheet }: { open: boolean; onClose: () => void; sheet: SheetApi }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ColumnKind>('text')
  const [options, setOptions] = useState('')

  useEffect(() => {
    if (open) { setName(''); setKind('text'); setOptions('') }
  }, [open])

  const create = () => {
    if (!name.trim()) return
    sheet.actions.addColumn(
      name.trim(),
      kind,
      kind === 'select' ? options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
    )
    onClose()
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Add a column"
        description="Name it after what it holds: quantity, category, receipt."
        footer={
          <>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary pressable" onClick={create} disabled={!name.trim()}>Add column</button>
          </>
        }
      >
        <label className="label" htmlFor="col-name">Name</label>
        <input
          id="col-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && kind !== 'select') create() }}
          placeholder="Quantity"
          autoFocus
          maxLength={60}
        />

        <p className="label mt-4">Type</p>
        <div className="grid grid-cols-2 gap-1.5">
          {KINDS.map((k) => (
            <button
              key={k.value}
              onClick={() => setKind(k.value)}
              className={`text-left px-3 py-2 rounded-lg border transition-all pressable ${
                kind === k.value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-raised'
              }`}
              aria-pressed={kind === k.value}
            >
              <span className="text-[13px] font-medium block">{k.label}</span>
              <span className="text-[11px] text-muted block mt-0.5 leading-snug">{k.hint}</span>
            </button>
          ))}
        </div>

        {kind === 'select' && (
          <div className="mt-4 animate-rise">
            <label className="label" htmlFor="col-options">Choices</label>
            <input
              id="col-options"
              className="input"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder="UPI, Cash, Card"
            />
            <p className="text-[11.5px] text-faint mt-1.5">Separate with commas.</p>
          </div>
        )}

        {kind === 'number' && (
          <p className="text-[11.5px] text-muted mt-4 leading-relaxed">
            A number column is a note, not a formula. A quantity of 3 next to
            ₹240 leaves the row at ₹240; the amount you enter is already the
            total.
          </p>
        )}
      </Modal>
    </>
  )
}

/**
 * The columns manager.
 *
 * On a wide screen every column is a table header you can click. On a phone
 * there is no header row at all, so before this existed the only columns a
 * phone user ever had were the three a file starts with: the "+" that the whole
 * file model rests on was desktop-only. This is that "+", plus rename, retype
 * and delete, in a form that works with a thumb.
 */
export function ColumnsModal({ open, onClose, sheet }: { open: boolean; onClose: () => void; sheet: SheetApi }) {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  const doc = sheet.doc
  const columns = doc ? [...doc.columns].sort((a, b) => (a.order < b.order ? -1 : 1)) : []

  const commitRename = (id: string, current: string) => {
    const name = draft.trim()
    setEditing(null)
    if (name && name !== current) sheet.actions.renameColumn(id, name)
  }

  return (
    <>
      <Modal
        open={open && !adding}
        onClose={onClose}
        title="Columns"
        description="Rename, change a type, or add your own: quantity, category, a receipt slot."
        footer={
          <>
            <button className="btn-ghost" onClick={onClose}>Done</button>
            <button className="btn-primary pressable" onClick={() => setAdding(true)}>
              <Icon.Plus size={15} /> Add column
            </button>
          </>
        }
      >
        <ul className="divide-y divide-line -my-1">
          {columns.map((col) => (
            <li key={col.id} className="py-2.5">
              {editing === col.id ? (
                <div className="flex items-center gap-2">
                  <input
                    className="input h-10"
                    value={draft}
                    autoFocus
                    maxLength={60}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(col.id, col.name)
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    onBlur={() => commitRename(col.id, col.name)}
                    aria-label={`Rename ${col.name}`}
                  />
                  <button
                    className="btn-primary h-10 w-10 px-0 shrink-0"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitRename(col.id, col.name)}
                    aria-label="Save name"
                  >
                    <Icon.Check size={15} />
                  </button>
                </div>
              ) : confirming === col.id ? (
                <div className="flex items-center gap-2">
                  <p className="text-[12.5px] text-muted flex-1 min-w-0">Delete "{col.name}" and its values?</p>
                  <button className="btn-ghost h-9 px-2.5 text-[12px]" onClick={() => setConfirming(null)}>Cancel</button>
                  <button
                    className="btn-danger h-9 px-3 text-[12px]"
                    onClick={() => { sheet.actions.deleteColumn(col.id); setConfirming(null) }}
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13.5px] font-medium truncate">{col.name}</p>
                    <p className="text-[11.5px] text-muted mt-0.5">
                      {KINDS.find((k) => k.value === col.kind)?.label ?? col.kind}
                      {col.system && <span className="text-faint"> · built in</span>}
                      {col.kind === 'select' && col.options?.length ? (
                        <span className="text-faint"> · {col.options.join(', ')}</span>
                      ) : null}
                    </p>
                  </div>

                  {!col.system && (
                    <select
                      value={col.kind}
                      onChange={(e) => sheet.actions.retypeColumn(col.id, e.target.value as ColumnKind, col.options)}
                      className="input h-9 w-auto text-[12px] pr-7 shrink-0"
                      aria-label={`Type of ${col.name}`}
                    >
                      {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                    </select>
                  )}

                  <button
                    onClick={() => { setDraft(col.name); setEditing(col.id) }}
                    className="h-9 w-9 grid place-items-center rounded-lg text-faint hover:text-ink hover:bg-raised transition-colors shrink-0"
                    aria-label={`Rename ${col.name}`}
                  >
                    <Icon.Pencil size={15} />
                  </button>

                  {!col.system && (
                    <button
                      onClick={() => setConfirming(col.id)}
                      className="h-9 w-9 grid place-items-center rounded-lg text-faint hover:text-bad hover:bg-bad/10 transition-colors shrink-0"
                      aria-label={`Delete ${col.name}`}
                    >
                      <Icon.Trash size={15} />
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        <p className="text-[11.5px] text-faint mt-4 leading-relaxed">
          A number column is a note, not a formula. A quantity of 3 next to ₹240
          leaves the row at ₹240.
        </p>
      </Modal>

      <AddColumnModal open={adding} onClose={() => setAdding(false)} sheet={sheet} />
    </>
  )
}
