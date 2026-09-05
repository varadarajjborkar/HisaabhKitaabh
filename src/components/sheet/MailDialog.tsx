'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SheetDoc } from '@/lib/model/types'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icons'
import { exportableColumns, toEmail } from '@/lib/util/export'
import { copyToClipboard, openMailDraft } from '@/lib/client/exports'
import { displayWidth } from '@/lib/util/textTable'

const KEY = (fileId: string) => `hisaabkitaab-mail-columns:${fileId}`

/**
 * Choosing what goes in the mail.
 *
 * A file can carry a receipt column, a payment method, a quantity and three
 * fields the user invented, and none of that belongs in a mail to whoever is
 * splitting the bill. Sending everything also has a second cost: the wider the
 * table, the more likely the mail client folds it at its own margin, and a
 * folded table is a destroyed table. Narrowing the column list is therefore the
 * most effective thing a user can do to keep the grid intact, which is why the
 * dialog shows the rendered width as they change it.
 *
 * The preview is the real output, rendered in the same fixed-width font the
 * layout assumes, so what is on screen is what lands in the draft.
 */
export function MailDialog({ open, onClose, doc }: { open: boolean; onClose: () => void; doc: SheetDoc }) {
  const columns = useMemo(() => exportableColumns(doc), [doc])
  const [selected, setSelected] = useState<string[]>(() => columns.map((c) => c.id))

  // Restore the last choice for this file, dropping ids for columns that have
  // since been deleted and adopting any that were added after the choice.
  useEffect(() => {
    if (!open) return
    let stored: string[] | null = null
    try {
      const raw = localStorage.getItem(KEY(doc.id))
      if (raw) stored = JSON.parse(raw) as string[]
    } catch { /* no stored preference is a fine starting point */ }
    const live = new Set(columns.map((c) => c.id))
    const kept = (stored ?? []).filter((id) => live.has(id))
    setSelected(kept.length ? kept : columns.map((c) => c.id))
  }, [open, doc.id, columns])

  const remember = (next: string[]) => {
    setSelected(next)
    try { localStorage.setItem(KEY(doc.id), JSON.stringify(next)) } catch { /* preference only */ }
  }

  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id]
    // One column has to survive, or there is no table to send.
    if (next.length === 0) return
    remember(next)
  }

  const { body } = useMemo(() => toEmail(doc, { columnIds: selected }), [doc, selected])
  const width = useMemo(() => Math.max(0, ...body.split('\n').map(displayWidth)), [body])

  const send = () => {
    openMailDraft(doc, { columnIds: selected })
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mail this file"
      description="Pick the columns to include. The preview is exactly what goes in the draft."
      size="lg"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-outline pressable" onClick={() => void copyToClipboard(doc, { columnIds: selected })}>
            <Icon.Copy size={15} /> Copy
          </button>
          <button className="btn-primary pressable" onClick={send}>
            <Icon.Mail size={15} /> Open draft
          </button>
        </>
      }
    >
      <p className="label">Columns</p>
      <div className="flex flex-wrap gap-1.5">
        {columns.map((col) => {
          const on = selected.includes(col.id)
          return (
            <button
              key={col.id}
              onClick={() => toggle(col.id)}
              aria-pressed={on}
              className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] border transition-colors pressable ${
                on
                  ? 'bg-accent-soft border-accent/45 text-accent font-medium'
                  : 'bg-surface border-line text-muted hover:bg-raised hover:text-ink'
              }`}
            >
              {on ? <Icon.Check size={13} /> : <Icon.Plus size={13} />}
              {col.name}
            </button>
          )
        })}
      </div>

      <div className="flex items-baseline justify-between mt-5 mb-1.5">
        <p className="label mb-0">Preview</p>
        <p className={`text-[11px] tnum ${width > 78 ? 'text-warn' : 'text-faint'}`}>
          {width} characters wide
          {width > 78 && ' - some mail clients will fold this'}
        </p>
      </div>

      <pre
        className="text-[11.5px] leading-[1.45] font-mono bg-raised border border-line rounded-lg
                   px-3 py-2.5 overflow-x-auto whitespace-pre max-h-[38dvh] overscroll-contain"
      >
        {body}
      </pre>

      <p className="text-[11.5px] text-faint mt-2.5 leading-relaxed">
        Columns are padded to a fixed grid and long values wrap under their own
        heading, so nothing ever runs into the next column. Mail is plain text,
        so the grid reads best in a client set to a fixed-width font; fewer
        columns keeps it narrow and safe either way.
      </p>
    </Modal>
  )
}
