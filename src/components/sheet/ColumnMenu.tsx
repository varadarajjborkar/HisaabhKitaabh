'use client'

import { useState } from 'react'
import type { Column, ColumnKind } from '@/lib/model/types'
import { Icon } from '../ui/Icons'
import { Modal } from '../ui/Modal'
import { useDismiss } from '@/lib/client/useDismiss'
import type { SheetApi } from '@/lib/client/useSheet'

const KINDS: Array<{ value: ColumnKind; label: string; hint: string }> = [
  { value: 'amount', label: 'Amount', hint: 'Money. Sums into the total.' },
  { value: 'number', label: 'Number', hint: 'A count. Never multiplied by anything.' },
  { value: 'text', label: 'Text', hint: 'Anything written.' },
  { value: 'date', label: 'Date', hint: 'A day.' },
  { value: 'select', label: 'Choice', hint: 'Pick from a fixed list.' },
  { value: 'attachment', label: 'File', hint: 'Receipts, invoices, screenshots.' },
]

export function ColumnMenu({ column, sheet }: { column: Column; sheet: SheetApi }) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(column.name)
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))

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
    <div ref={ref} className="relative inline-flex items-center gap-1 group/col max-w-full">
      <span className="truncate">{column.name}</span>
      <button
        onClick={() => setOpen((v) => !v)}
        className="shrink-0 opacity-0 group-hover/col:opacity-100 focus:opacity-100 text-faint hover:text-ink transition-opacity no-print"
        aria-label={`Options for ${column.name}`}
        aria-expanded={open}
      >
        <Icon.Down size={12} />
      </button>

      {open && (
        <>
          <div className="absolute left-0 top-6 z-50 w-48 card shadow-pop py-1 animate-scale-in origin-top-left normal-case tracking-normal text-left font-normal">
            <button
              onClick={() => { setOpen(false); setRenaming(true) }}
              className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-raised transition-colors"
            >
              Rename
            </button>

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
        </>
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
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ColumnKind>('text')
  const [options, setOptions] = useState('')

  const create = () => {
    if (!name.trim()) return
    sheet.actions.addColumn(
      name.trim(),
      kind,
      kind === 'select' ? options.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
    )
    setOpen(false)
    setName('')
    setKind('text')
    setOptions('')
  }

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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a column"
        description="Name it after what it holds: quantity, category, receipt."
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
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
