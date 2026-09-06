'use client'

import { useEffect, useMemo, useState } from 'react'
import type { SheetDoc } from '@/lib/model/types'
import { Modal } from '../ui/Modal'
import { Icon } from '../ui/Icons'
import { exportableColumns, toEmail, GRID_STYLES, type GridStyle } from '@/lib/util/export'
import { copyToClipboard, openMailDraft } from '@/lib/client/exports'
import { displayWidth } from '@/lib/util/textTable'

const KEY = (fileId: string) => `hisaabhkitaabh-mail-columns:${fileId}`
const STYLE_KEY = 'hisaabhkitaabh-mail-style'

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
  const [style, setStyle] = useState<GridStyle>('grid')
  /*
   * What is in the box, which is not always what the generator produced.
   *
   * Once someone has typed in the preview it is theirs, so changing a column or
   * a format does not reach in and overwrite it. The dialog says the two have
   * diverged and offers to rebuild, which is a button rather than a surprise.
   */
  const [draft, setDraft] = useState('')
  const [edited, setEdited] = useState(false)

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
    try {
      const savedStyle = localStorage.getItem(STYLE_KEY)
      if (savedStyle && GRID_STYLES.some((s) => s.value === savedStyle)) setStyle(savedStyle as GridStyle)
    } catch { /* the default format is a fine starting point */ }
    setEdited(false)
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

  const { body } = useMemo(() => toEmail(doc, { columnIds: selected, style }), [doc, selected, style])

  // Follow the generator until the moment the user takes over.
  useEffect(() => {
    if (!edited) setDraft(body)
  }, [body, edited])

  const text = edited ? draft : body
  const width = useMemo(() => Math.max(0, ...text.split('\n').map(displayWidth)), [text])
  const stale = edited && draft !== body

  const rebuild = () => { setDraft(body); setEdited(false) }

  const chooseStyle = (next: GridStyle) => {
    setStyle(next)
    try { localStorage.setItem(STYLE_KEY, next) } catch { /* preference only */ }
  }

  const send = () => {
    openMailDraft(doc, { columnIds: selected, style }, text)
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
          <button className="btn-outline pressable" onClick={() => void copyToClipboard(doc, { columnIds: selected, style }, text)}>
            <Icon.Copy size={15} /> Copy
          </button>
          <button className="btn-primary pressable" onClick={send}>
            <Icon.Mail size={15} /> Open draft
          </button>
        </>
      }
    >
      <p className="label">Format</p>
      <div className="flex flex-wrap gap-1.5">
        {GRID_STYLES.map((s) => (
          <button
            key={s.value}
            onClick={() => chooseStyle(s.value)}
            aria-pressed={style === s.value}
            title={s.hint}
            className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] border transition-colors pressable ${
              style === s.value
                ? 'bg-accent-soft border-accent/45 text-accent font-medium'
                : 'bg-surface border-line text-muted hover:bg-raised hover:text-ink'
            }`}
          >
            {s.label}
            <span className="text-[11px] opacity-70">{s.hint}</span>
          </button>
        ))}
      </div>

      <p className="label mt-5">Columns</p>
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

      <div className="flex items-baseline justify-between mt-5 mb-1.5 gap-3">
        <p className="label mb-0">Preview{edited && <span className="text-faint font-normal"> · edited</span>}</p>
        <p className={`text-[11px] tnum shrink-0 ${width > 78 ? 'text-warn' : 'text-faint'}`}>
          {width} characters wide
          {width > 78 && ' - some mail clients will fold this'}
        </p>
      </div>

      <textarea
        value={text}
        onChange={(e) => { setDraft(e.target.value); setEdited(true) }}
        spellCheck={false}
        aria-label="Message"
        className="w-full text-[11.5px] leading-[1.45] font-mono bg-raised border border-line rounded-lg
                   px-3 py-2.5 whitespace-pre overflow-x-auto h-[38dvh] min-h-[180px] resize-y
                   outline-none focus:border-accent/50 overscroll-contain"
      />

      {stale && (
        <div className="flex items-center gap-2 mt-2 text-[11.5px] text-warn animate-rise">
          <Icon.Warning size={13} className="shrink-0" />
          <span className="min-w-0">Your edits are still here; the columns or format have moved on.</span>
          <button onClick={rebuild} className="btn-ghost h-7 text-[11.5px] ml-auto shrink-0">Rebuild</button>
        </div>
      )}

      <p className="text-[11.5px] text-faint mt-2.5 leading-relaxed">
        This box is the message. Edit it freely - add a line at the top, drop a
        row, say what it is for. Columns are padded to a fixed grid and long
        values wrap under their own heading, so nothing runs into the next
        column; if you retype inside the table, keep the spacing to keep it
        aligned.
      </p>
    </Modal>
  )
}
