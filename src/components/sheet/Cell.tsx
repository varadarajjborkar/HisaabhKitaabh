'use client'

import { useEffect, useRef, useState } from 'react'
import type { AttachmentRef, CellValue, Column } from '@/lib/model/types'
import { parseAmount } from '@/lib/crdt/doc'
import { formatMoney } from '@/lib/util/format'
import { humanSize } from '@/lib/util/mime'
import { Icon } from '../ui/Icons'
import { toast } from '../ui/Toast'

/**
 * One editable cell.
 *
 * Commits on blur and on Enter, not on every keystroke - the operation queue
 * should carry "the amount is now 450", not eleven partial numbers. Escape
 * restores the value the cell had when editing began.
 */
/**
 * `lg` is the phone size.
 *
 * A 13.5px input in a 28px box is fine under a mouse and wrong under a thumb:
 * it is below the 44px target everyone's platform guidelines ask for, and the
 * text is small enough that people zoom the page to check what they typed.
 */
export type CellSize = 'md' | 'lg'

/**
 * `field` draws a box; `inline` does not.
 *
 * Inside a table or on the face of a card, a cell should look like the value it
 * holds, with the grid doing the work of saying where one ends and the next
 * begins. In the expanded part of a phone card there is no grid: a label, then
 * a transparent input, then another label reads as a list of text, and people
 * do not realise the values are editable. There the input gets a border.
 */
export type CellVariant = 'inline' | 'field'

export function Cell({
  column,
  value,
  rowId,
  fileId,
  onChange,
  onNavigate,
  autoFocus,
  size = 'md',
  variant = 'inline',
  currency = 'INR',
}: {
  column: Column
  value: CellValue
  rowId: string
  fileId: string
  /** The file's currency. Only the digit grouping depends on it here - the cell
   *  shows a bare number - but 12,34,567 in a dollar file is still wrong. */
  currency?: string
  onChange: (value: CellValue) => void
  onNavigate?: (dir: 'up' | 'down' | 'next' | 'prev') => void
  autoFocus?: boolean
  size?: CellSize
  variant?: CellVariant
}) {
  if (column.kind === 'attachment') {
    return <AttachmentCell value={Array.isArray(value) ? value : []} fileId={fileId} onChange={onChange} size={size} />
  }
  if (column.kind === 'select') {
    return <SelectCell column={column} value={typeof value === 'string' ? value : ''} onChange={onChange} size={size} variant={variant} />
  }
  return (
    <TextCell
      column={column}
      value={value}
      onChange={onChange}
      onNavigate={onNavigate}
      autoFocus={autoFocus}
      size={size}
      variant={variant}
      currency={currency}
      key={`${rowId}:${column.id}`}
    />
  )
}

function TextCell({
  column,
  value,
  onChange,
  onNavigate,
  autoFocus,
  size,
  variant,
  currency,
}: {
  column: Column
  value: CellValue
  onChange: (value: CellValue) => void
  onNavigate?: (dir: 'up' | 'down' | 'next' | 'prev') => void
  autoFocus?: boolean
  size: CellSize
  variant: CellVariant
  currency: string
}) {
  const isNumeric = column.kind === 'amount' || column.kind === 'number'
  const display = (v: CellValue) => {
    if (v == null || v === '') return ''
    if (Array.isArray(v)) return ''
    if (column.kind === 'amount') return formatMoney(Number(v) || 0, currency, { symbol: false })
    return String(v)
  }

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => display(value))
  const committed = useRef(display(value))
  const ref = useRef<HTMLInputElement>(null)

  // Adopt a value that changed underneath us - the assistant writing, or another
  // tab - but never while the user is mid-edit in this very cell.
  useEffect(() => {
    if (editing) return
    const next = display(value)
    committed.current = next
    setDraft(next)
  }, [value, editing]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const commit = () => {
    setEditing(false)
    if (draft === committed.current) return
    if (draft.trim() === '') {
      committed.current = ''
      onChange(null)
      return
    }
    if (isNumeric) {
      const n = parseAmount(draft)
      if (!Number.isFinite(n)) {
        // Reject rather than store junk that would poison the total.
        toast.warn(`"${draft}" is not a number`, 'The cell was left as it was.')
        setDraft(committed.current)
        return
      }
      committed.current = display(n)
      setDraft(display(n))
      onChange(n)
      return
    }
    committed.current = draft
    onChange(draft)
  }

  return (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); onNavigate?.('down') }
        else if (e.key === 'Escape') { setDraft(committed.current); setEditing(false); e.currentTarget.blur() }
        // The grid moves focus itself, because native Tab cannot append a row
        // when it falls off the last cell. Letting the default through as well
        // would move twice and skip a column.
        else if (e.key === 'Tab') { e.preventDefault(); commit(); onNavigate?.(e.shiftKey ? 'prev' : 'next') }
        else if (e.key === 'ArrowUp' && !isNumeric) onNavigate?.('up')
        else if (e.key === 'ArrowDown' && !isNumeric) onNavigate?.('down')
      }}
      inputMode={isNumeric ? 'decimal' : column.kind === 'date' ? 'numeric' : 'text'}
      type={column.kind === 'date' ? 'date' : 'text'}
      placeholder={column.kind === 'amount' ? '0' : ''}
      aria-label={column.name}
      className={`w-full outline-none rounded-lg transition-colors
                  focus:ring-2 focus:ring-accent/25 focus:border-accent
                  ${variant === 'field'
                    ? 'bg-surface border border-line focus:bg-surface'
                    : 'bg-transparent border border-transparent focus:bg-accent-soft/60'}
                  ${size === 'lg' ? 'text-[16px] h-11 px-2.5' : 'text-[13.5px] px-2 py-1.5'}
                  ${isNumeric ? 'text-right tnum' : ''}
                  ${column.kind === 'amount' ? (size === 'lg' ? 'font-semibold' : 'font-medium') : ''}`}
    />
  )
}

function SelectCell({ column, value, onChange, size, variant }: { column: Column; value: string; onChange: (v: CellValue) => void; size: CellSize; variant: CellVariant }) {
  const options = column.options ?? []
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={column.name}
      className={`w-full outline-none rounded-lg transition-colors text-ink cursor-pointer
                  focus:ring-2 focus:ring-accent/25
                  ${size === 'lg' || variant === 'field'
                    ? 'text-[16px] h-11 px-2.5 bg-surface border border-line'
                    : 'text-[13.5px] px-1.5 py-1.5 bg-transparent appearance-none'}`}
    >
      <option value="">Not set</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      {value && !options.includes(value) && <option value={value}>{value}</option>}
    </select>
  )
}

/**
 * Attachments on a cell.
 *
 * Video is refused at the picker, at upload, and on the server - the same rule
 * stated three times so it fails early and explains itself, rather than at the
 * end of a long upload.
 */
function AttachmentCell({
  value,
  fileId,
  onChange,
  size,
}: {
  value: AttachmentRef[]
  fileId: string
  onChange: (v: CellValue) => void
  size: CellSize
}) {
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const input = useRef<HTMLInputElement>(null)

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/files/${fileId}/attachments`, { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) {
        toast.error(String(body.message ?? 'Upload failed'))
        return
      }
      onChange([...value, body.attachment as AttachmentRef])
      toast.success(`Attached ${file.name}`)
    } catch {
      toast.error('Upload failed.')
    } finally {
      setBusy(false)
    }
  }

  const href = (ref: AttachmentRef) =>
    `/api/files/${fileId}/attachments?ref=${btoa(JSON.stringify(ref)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`

  /*
   * Dropping onto the cell uploads.
   *
   * This is where a receipt naturally lands: the user is already looking at the
   * row it belongs to, and the alternative is a file picker that opens on the
   * wrong folder. `dragenter` and `dragleave` fire once per child crossed, so
   * the highlight is driven by a depth counter rather than a bare boolean,
   * which would blink off as the pointer passed over an existing chip.
   */
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  return (
    <div
      className={`flex flex-wrap items-center gap-1 rounded transition-colors
                  ${size === 'lg' ? 'px-1.5 py-2 min-h-11' : 'px-1.5 py-1'}
                  ${over ? 'drop-active' : ''}`}
      onDragEnter={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current++; setOver(true) }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault() }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const file = e.dataTransfer.files[0]
        if (file) void upload(file)
      }}
    >
      {value.map((a) => (
        <span key={a.id} className="chip h-6 pl-1.5 pr-1 max-w-[150px] group/att">
          <a href={href(a)} target="_blank" rel="noreferrer" className="truncate hover:underline" title={`${a.name} · ${humanSize(a.size)}`}>
            {a.name}
          </a>
          <button
            onClick={() => onChange(value.filter((x) => x.id !== a.id))}
            className="text-faint hover:text-bad transition-colors"
            aria-label={`Remove ${a.name}`}
          >
            <Icon.Close size={11} />
          </button>
        </span>
      ))}

      <button
        onClick={() => input.current?.click()}
        disabled={busy}
        className={`rounded text-faint hover:text-accent hover:bg-accent-soft transition-colors flex items-center gap-1.5
                    ${size === 'lg' ? 'h-9 px-2.5 text-[13px] border border-line' : 'h-6 px-1.5 text-[11.5px]'}`}
        aria-label="Attach a file"
        title="Pick a file, or drop one on this cell"
      >
        {busy ? <Icon.Spinner size={12} /> : <Icon.Plus size={13} />}
        {value.length === 0 && <span>Attach</span>}
      </button>

      <input
        ref={input}
        type="file"
        className="hidden"
        accept="image/*,.pdf,.csv,.tsv,.txt,.json,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.rtf,.zip"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void upload(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
