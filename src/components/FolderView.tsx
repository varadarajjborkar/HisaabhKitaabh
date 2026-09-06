'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { FileMeta, FolderMeta } from '@/lib/model/types'
import { Icon } from './ui/Icons'
import { AccountMenu, TopBar, useShell } from './AppShell'
import { del, get, post } from '@/lib/client/api'
import { formatMoney, relativeTime } from '@/lib/util/format'
import { Modal, ConfirmModal } from './ui/Modal'
import { toast } from './ui/Toast'
import { ChatDock } from './chat/ChatDock'
import { ulid } from '@/lib/util/ids'
import { useFileDrop } from '@/lib/client/useFileDrop'
import { useDismiss } from '@/lib/client/useDismiss'
import { SearchBar } from './SearchBar'

type Sort = 'recent' | 'name' | 'total' | 'rows' | 'created'

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'recent', label: 'Recently updated' },
  { value: 'created', label: 'Recently created' },
  { value: 'name', label: 'Name' },
  { value: 'total', label: 'Total' },
  { value: 'rows', label: 'Rows' },
]

/**
 * The file list, modelled on a mail inbox.
 *
 * That shape is chosen on purpose: everyone already knows how to select rows,
 * sort a column, and act on a selection there. Checkboxes appear only once
 * something is selected on touch, so the default view stays clean on a phone.
 */
export function FolderView({ folder, initialFiles }: { folder: FolderMeta; initialFiles: FileMeta[] }) {
  const { session, aiEnabled } = useShell()
  const router = useRouter()

  const [files, setFiles] = useState(initialFiles)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('recent')
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [dropped, setDropped] = useState<File[] | null>(null)

  /*
   * Dropping a statement or a receipt on the folder hands it to the assistant.
   *
   * There is no silent-import path on purpose. Turning an arbitrary CSV into
   * rows involves guessing which column is the amount and which is the date,
   * and a guess that writes without asking is exactly the "something appeared
   * that I did not type" failure this app is built to avoid. The assistant
   * already reads attachments and proposes changes behind an approval, so the
   * drop opens that conversation with the file already attached.
   */
  const drop = useFileDrop((files) => {
    setDropped(files)
    setChatOpen(true)
  })

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await get<{ files: FileMeta[] }>(`/api/files?folderId=${folder.id}`)
      setFiles(res.files)
      setSelected(new Set())
    } finally {
      setRefreshing(false)
    }
  }, [folder.id])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files
    const sorted = [...filtered]
    if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'total') sorted.sort((a, b) => b.total - a.total)
    else if (sort === 'rows') sorted.sort((a, b) => b.rowCount - a.rowCount)
    else if (sort === 'created') sorted.sort((a, b) => b.createdAt - a.createdAt)
    else sorted.sort((a, b) => b.updatedAt - a.updatedAt)
    return sorted
  }, [files, query, sort])

  const folderTotal = files.reduce((s, f) => s + f.total, 0)
  /*
   * A folder total only means something when its files agree on a currency.
   * Adding a rupee file to a dollar file produces a number with no unit, so
   * when they disagree the subtitle drops the total rather than printing a
   * figure that is confidently wrong.
   */
  const currencies = new Set(files.map((f) => (f.currency || 'INR').toUpperCase()))
  const folderCurrency = currencies.size === 1 ? [...currencies][0] : null
  const allSelected = visible.length > 0 && visible.every((f) => selected.has(f.id))

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(visible.map((f) => f.id)))
  }

  const deleteSelected = async () => {
    const ids = [...selected]
    // Optimistic: the list updates now, and reverts if the server disagrees.
    const backup = files
    setFiles((f) => f.filter((x) => !selected.has(x.id)))
    setSelected(new Set())
    try {
      await del('/api/files', { action: 'delete', ids })
      toast.success(`Deleted ${ids.length} file${ids.length === 1 ? '' : 's'}`)
    } catch {
      setFiles(backup)
    }
  }

  const createFile = async (name: string) => {
    const res = await post<{ doc: { id: string } }>('/api/files', { folderId: folder.id, name, id: ulid() })
    router.push(`/file/${res.doc.id}`)
  }

  return (
    <>
      <TopBar
        back="/home"
        title={<span className="flex items-center gap-2"><span>{folder.icon}</span>{folder.name}</span>}
        subtitle={
          folderCurrency
            ? `${files.length} file${files.length === 1 ? '' : 's'} · ${formatMoney(folderTotal, folderCurrency, { decimals: false })}`
            : `${files.length} file${files.length === 1 ? '' : 's'} · mixed currencies`
        }
        actions={
          <>
            <button onClick={refresh} className="btn-ghost h-9 w-9 px-0 pressable" aria-label="Refresh">
              <Icon.Refresh size={17} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {aiEnabled && (
              <button onClick={() => setChatOpen(true)} className="btn-ghost h-9 w-9 px-0 pressable" aria-label="Assistant">
                <Icon.Sparkle size={17} />
              </button>
            )}
            <AccountMenu session={session} />
          </>
        }
      >
        <div className="flex items-center gap-2 px-3 sm:px-5 pb-2.5">
          {/*
            * The list keeps filtering by name as you type, and the dropdown
            * offers what the name filter cannot see: a caption, a payment
            * method, a date, an amount inside one of these files.
            */}
          <SearchBar folderId={folder.id} scoped value={query} onValueChange={setQuery} className="flex-1" />
          <SortMenu value={sort} onChange={setSort} />
          <button onClick={() => setCreating(true)} className="btn-primary h-9 shrink-0 pressable">
            <Icon.Plus size={15} />
            <span className="hidden sm:inline">New file</span>
          </button>
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 px-3 sm:px-5 py-2 border-t border-line bg-accent-soft/50 animate-rise">
            <span className="text-[12.5px] font-medium text-accent">{selected.size} selected</span>
            <button onClick={() => setSelected(new Set())} className="btn-ghost h-7 text-[12px]">Clear</button>
            <button onClick={() => setConfirmDelete(true)} className="btn-ghost h-7 text-[12px] text-bad ml-auto pressable">
              <Icon.Trash size={14} /> Delete
            </button>
          </div>
        )}
      </TopBar>

      <main {...drop.handlers} className="flex-1 scroller px-3 sm:px-5 py-4 pb-24 relative">
        <div className="max-w-4xl w-full mx-auto">
        {visible.length === 0 ? (
          <EmptyFiles query={query} onCreate={() => setCreating(true)} />
        ) : (
          <div className="card overflow-hidden">
            <div className="hidden sm:flex items-center gap-3 px-3.5 h-9 border-b border-line text-[11px] uppercase tracking-wide text-faint">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                className="accent-accent w-3.5 h-3.5"
                aria-label="Select all"
              />
              <span className="flex-1">Name</span>
              <span className="w-16 text-right">Rows</span>
              <span className="w-28 text-right">Total</span>
              <span className="w-24 text-right">Created</span>
              <span className="w-24 text-right">Updated</span>
            </div>

            <ul className="stagger">
              {visible.map((file) => {
                const isSelected = selected.has(file.id)
                return (
                  <li
                    key={file.id}
                    className={`group border-b border-line last:border-0 transition-colors ${
                      isSelected ? 'bg-accent-soft/50' : 'hover:bg-raised/60'
                    }`}
                  >
                    <div className="flex items-center gap-3 px-3.5 py-2.5">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(file.id)}
                        className="accent-accent w-3.5 h-3.5 shrink-0"
                        aria-label={`Select ${file.name}`}
                      />
                      <Link href={`/file/${file.id}`} className="flex-1 min-w-0 flex items-center gap-3">
                        <Icon.File size={15} className="text-faint shrink-0 hidden sm:block" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13.5px] font-medium truncate">{file.name}</p>
                          <p className="text-[11.5px] text-muted sm:hidden mt-0.5">
                            {file.rowCount} rows · {formatMoney(file.total, file.currency, { decimals: false })} · {relativeTime(file.updatedAt)}
                          </p>
                        </div>
                        <span className="hidden sm:block w-16 text-right text-[12.5px] text-muted tnum">{file.rowCount}</span>
                        <span className="hidden sm:block w-28 text-right text-[13px] tnum font-medium">{formatMoney(file.total, file.currency, { decimals: false })}</span>
                        <span className="hidden sm:block w-24 text-right text-[11.5px] text-faint" title={new Date(file.createdAt).toLocaleString()}>{relativeTime(file.createdAt)}</span>
                        <span className="hidden sm:block w-24 text-right text-[11.5px] text-faint" title={new Date(file.updatedAt).toLocaleString()}>{relativeTime(file.updatedAt)}</span>
                      </Link>
                    </div>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        </div>

        {drop.over && aiEnabled && (
          <div className="fixed inset-0 z-40 grid place-items-center bg-bg/70 backdrop-blur-sm pointer-events-none animate-fade">
            <div className="card px-6 py-5 text-center border-2 border-dashed border-accent shadow-pop">
              <Icon.Upload size={24} className="mx-auto text-accent" />
              <p className="text-[13.5px] font-medium mt-2.5">Drop to hand it to the assistant</p>
              <p className="text-[12px] text-muted mt-1">It will read the file and propose rows for your approval.</p>
            </div>
          </div>
        )}
      </main>

      <NewFileModal open={creating} onClose={() => setCreating(false)} onCreate={createFile} />

      <ConfirmModal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={deleteSelected}
        title={`Delete ${selected.size} file${selected.size === 1 ? '' : 's'}?`}
        body="Everything in them goes too. This cannot be undone."
      />

      {aiEnabled && (
        <ChatDock
          open={chatOpen}
          onClose={() => setChatOpen(false)}
          scope={{ fileId: null, folderId: folder.id }}
          onApplied={refresh}
          subtitle={folder.name}
          incoming={dropped}
          onIncomingConsumed={() => setDropped(null)}
        />
      )}
    </>
  )
}

/**
 * Sort, as a menu rather than a select.
 *
 * A native select shows the current value, so the control read "Recent" - which
 * is an answer to a question the page never asked. Someone looking for how to
 * sort had nothing to look for. The button says what it does, and the menu says
 * what is currently chosen, which is the way round those two belong.
 */
function SortMenu({ value, onChange }: { value: Sort; onChange: (s: Sort) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-outline h-9 text-[12.5px] pressable"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Sorted by ${SORTS.find((s) => s.value === value)?.label.toLowerCase()}`}
      >
        <Icon.Sort size={15} />
        <span className="hidden sm:inline">Sort</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Sort by"
          className="absolute right-0 top-full mt-1.5 z-50 w-52 card shadow-pop py-1 animate-scale-in origin-top-right"
        >
          {SORTS.map((s) => (
            <button
              key={s.value}
              role="option"
              aria-selected={s.value === value}
              onClick={() => { onChange(s.value); setOpen(false) }}
              className={`w-full text-left px-3 py-2 text-[12.5px] hover:bg-raised flex items-center gap-2 transition-colors ${
                s.value === value ? 'text-accent' : ''
              }`}
            >
              <span className="w-3.5 shrink-0">{s.value === value && <Icon.Check size={14} />}</span>
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyFiles({ query, onCreate }: { query: string; onCreate: () => void }) {
  if (query) {
    return (
      <div className="card p-10 text-center animate-rise">
        <Icon.Search size={22} className="mx-auto text-faint" />
        <p className="text-[13.5px] font-medium mt-3">No file matches “{query}”</p>
      </div>
    )
  }
  return (
    <div className="card p-10 text-center animate-rise">
      <Icon.File size={24} className="mx-auto text-faint" />
      <p className="text-[14px] font-medium mt-3">This folder is empty</p>
      <p className="text-[13px] text-muted mt-1.5 max-w-xs mx-auto leading-relaxed">
        A file is a table of rows: an amount, a title, and whatever columns you add.
      </p>
      <button onClick={onCreate} className="btn-primary mt-5 pressable">
        <Icon.Plus size={15} /> New file
      </button>
    </div>
  )
}

function NewFileModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      await onCreate(name.trim())
    } finally {
      setBusy(false)
      setName('')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New file"
      description="Starts with three columns: INR, Title, and Extra Captions. Add your own from inside."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary pressable" onClick={submit} disabled={!name.trim() || busy}>
            {busy ? <Icon.Spinner /> : 'Create and open'}
          </button>
        </>
      }
    >
      <label className="label" htmlFor="file-name">Name</label>
      <input
        id="file-name"
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
        placeholder="Groceries, October"
        autoFocus
        maxLength={120}
      />
    </Modal>
  )
}
