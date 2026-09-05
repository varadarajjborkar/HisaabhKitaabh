'use client'

import { useEffect, useRef, useState } from 'react'
import type { AttachmentRef, CellValue, Column } from '@/lib/model/types'
import { parseAmount } from '@/lib/crdt/doc'
import { formatINR } from '@/lib/util/format'
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
export function Cell({
  column,
  value,
  rowId,
  fileId,
  onChange,
  onNavigate,
  autoFocus,
}: {
  column: Column
  value: CellValue
  rowId: string
  fileId: string
  onChange: (value: CellValue) => void
  onNavigate?: (dir: 'up' | 'down' | 'next' | 'prev') => void
  autoFocus?: boolean
}) {
  if (column.kind === 'attachment') {
    return <AttachmentCell value={Array.isArray(value) ? value : []} fileId={fileId} onChange={onChange} />
  }
  if (column.kind === 'select') {
    return <SelectCell column={column} value={typeof value === 'string' ? value : ''} onChange={onChange} />
  }
  return (
    <TextCell
      column={column}
      value={value}
      onChange={onChange}
      onNavigate={onNavigate}
      autoFocus={autoFocus}
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
}: {
  column: Column
  value: CellValue
  onChange: (value: CellValue) => void
  onNavigate?: (dir: 'up' | 'down' | 'next' | 'prev') => void
  autoFocus?: boolean
}) {
  const isNumeric = column.kind === 'amount' || column.kind === 'number'
  const display = (v: CellValue) => {
    if (v == null || v === '') return ''
    if (Array.isArray(v)) return ''
    if (column.kind === 'amount') return formatINR(Number(v) || 0, { symbol: false })
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
        else if (e.key === 'Tab') { commit(); onNavigate?.(e.shiftKey ? 'prev' : 'next') }
        else if (e.key === 'ArrowUp' && !isNumeric) onNavigate?.('up')
        else if (e.key === 'ArrowDown' && !isNumeric) onNavigate?.('down')
      }}
      inputMode={isNumeric ? 'decimal' : column.kind === 'date' ? 'numeric' : 'text'}
      type={column.kind === 'date' ? 'date' : 'text'}
      placeholder={column.kind === 'amount' ? '0' : ''}
      aria-label={column.name}
      className={`w-full bg-transparent outline-none text-[13.5px] px-2 py-1.5 rounded
                  focus:bg-accent-soft/60 focus:ring-1 focus:ring-accent/40 transition-colors
                  ${isNumeric ? 'text-right tnum' : ''}
                  ${column.kind === 'amount' ? 'font-medium' : ''}`}
    />
  )
}

function SelectCell({ column, value, onChange }: { column: Column; value: string; onChange: (v: CellValue) => void }) {
  const options = column.options ?? []
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={column.name}
      className="w-full bg-transparent outline-none text-[13.5px] px-1.5 py-1.5 rounded
                 focus:bg-accent-soft/60 focus:ring-1 focus:ring-accent/40 transition-colors
                 text-ink appearance-none cursor-pointer"
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
}: {
  value: AttachmentRef[]
  fileId: string
  onChange: (v: CellValue) => void
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
      className={`flex flex-wrap items-center gap-1 px-1.5 py-1 rounded transition-colors ${over ? 'drop-active' : ''}`}
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
        className="h-6 px-1.5 rounded text-faint hover:text-accent hover:bg-accent-soft transition-colors flex items-center gap-1 text-[11.5px]"
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
