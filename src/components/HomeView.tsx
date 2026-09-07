'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { FolderMeta } from '@/lib/model/types'
import { Icon } from './ui/Icons'
import { Logo } from './ui/Logo'
import { Modal, ConfirmModal } from './ui/Modal'
import { useDismiss } from '@/lib/client/useDismiss'
import { AccountMenu, TopBar, useShell } from './AppShell'
import { del, get, patch, post } from '@/lib/client/api'
import { toast } from './ui/Toast'
import { relativeTime } from '@/lib/util/format'
import { AnalyticsPanel } from './AnalyticsPanel'
import { SearchBar } from './SearchBar'
import { ViewBar, useViewPrefs, windowOf, type Layout } from './ViewBar'
import { ChatDock } from './chat/ChatDock'
import { ulid } from '@/lib/util/ids'

const ICONS = ['📁', '🧭', '🏠', '🍚', '🚗', '💊', '🎒', '🎁', '🔧', '📚', '✈️', '🧾']
const COLORS = ['#2260c4', '#c2410c', '#0f766e', '#7c3aed', '#b91c1c', '#0369a1', '#4d7c0f', '#a16207']

export function HomeView({ initialFolders, analyticsEnabled }: { initialFolders: FolderMeta[]; analyticsEnabled: boolean }) {
  const { session, aiEnabled } = useShell()
  const [folders, setFolders] = useState(initialFolders)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<FolderMeta | null>(null)
  const [view, setView] = useViewPrefs('folders', { layout: 'grid' as Layout, pageSize: 12 })
  const [page, setPage] = useState(0)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmBulk, setConfirmBulk] = useState(false)
  const [analytics, setAnalytics] = useState(analyticsEnabled)
  const [refreshing, setRefreshing] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await get<{ folders: FolderMeta[] }>('/api/folders')
      setFolders(res.folders)
    } finally {
      setRefreshing(false)
    }
  }, [])

  // The sample folder is seeded lazily on first read; if the server render beat
  // it, pick it up once on mount rather than showing an empty state that lies.
  useEffect(() => {
    if (initialFolders.length === 0) void refresh()
  }, [initialFolders.length, refresh])

  const toggleAnalytics = async () => {
    const next = !analytics
    setAnalytics(next)
    await patch('/api/settings', { analyticsEnabled: next })
  }

  const total = folders.reduce((s, f) => s + f.fileCount, 0)
  const win = windowOf(folders, page, view.pageSize)
  const pageAllPicked = win.slice.length > 0 && win.slice.every((f) => picked.has(f.id))

  const togglePick = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Select-all covers what is on screen, not the whole account. Selecting three
  // hundred folders from a button that says "all" while twelve are visible is
  // how people delete things they never saw.
  const toggleAllOnPage = () => {
    setPicked((prev) => {
      const next = new Set(prev)
      for (const f of win.slice) pageAllPicked ? next.delete(f.id) : next.add(f.id)
      return next
    })
  }

  const stopSelecting = () => { setSelecting(false); setPicked(new Set()) }

  const deletePicked = async () => {
    const ids = [...picked]
    const backup = folders
    setFolders((prev) => prev.filter((f) => !picked.has(f.id)))
    setPicked(new Set())
    setSelecting(false)
    try {
      // No bulk endpoint: a handful of folders is a handful of requests, and a
      // partial failure leaves the ones that did go rather than pretending.
      await Promise.all(ids.map((id) => del(`/api/folders/${id}`)))
      toast.success(`Deleted ${ids.length} folder${ids.length === 1 ? '' : 's'}`)
    } catch {
      setFolders(backup)
      toast.error('Could not delete them all', 'The list has been put back.')
    }
  }

  return (
    <>
      <TopBar
        title={
          // The mark belongs next to the name it is the mark for. It used to
          // sit beside the account row in the menu, where it identified the
          // app to someone already inside it and said nothing about them.
          <span className="inline-flex items-center gap-2">
            <Logo size={20} />
            HisaabhKitaabh
          </span>
        }
        subtitle={`${folders.length} folder${folders.length === 1 ? '' : 's'} · ${total} file${total === 1 ? '' : 's'}`}
        actions={
          <>
            <button onClick={refresh} className="btn-ghost h-9 w-9 px-0 pressable hidden sm:inline-flex" aria-label="Refresh" title="Refresh">
              <Icon.Refresh size={17} className={refreshing ? 'animate-spin' : ''} />
            </button>
            {aiEnabled && (
              <button
                onClick={() => setChatOpen(true)}
                className="btn-ghost h-9 w-9 px-0 pressable"
                aria-label="Assistant"
                title="Assistant"
              >
                <Icon.Sparkle size={17} />
              </button>
            )}
            <AccountMenu session={session} />
          </>
        }
      >
        {/* Centred, not merely capped. `max-w-xl` alone left the box pinned to
            the left edge under a title bar whose own weight sits at both ends,
            so the search read as another left-hand control rather than as the
            thing the whole screen is for. */}
        <div className="px-3 sm:px-5 pb-2.5">
          <SearchBar className="max-w-xl mx-auto" placeholder="Search folders, files and rows" />
        </div>
      </TopBar>

      <main className="flex-1 scroller px-3 sm:px-5 py-5 pb-24">
        <div className="max-w-5xl w-full mx-auto">
        <section className="flex items-center justify-between gap-2 mb-4 flex-wrap">
          {/*
            * Picking does not get a bar of its own. It used to: a strip that
            * appeared under this row, pushed the folders down, and put Delete
            * on a line by itself where nothing else was - which is the one
            * place a destructive button should not be, big and alone and the
            * only thing to press. Now the count and its two actions land in
            * this row beside the heading, the list stays where it was, and
            * Delete sits at the far end from New folder rather than next to it.
            */}
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            <h2 className="text-[13px] font-medium text-muted">Folders</h2>
            {selecting && (
              <>
                <span className="text-[12.5px] font-medium text-accent whitespace-nowrap">
                  · {picked.size} selected
                </span>
                <button onClick={toggleAllOnPage} className="btn-ghost h-7 text-[12px] whitespace-nowrap">
                  {pageAllPicked ? 'Clear page' : <><span className="sm:hidden">All</span><span className="hidden sm:inline">Select all on this page</span></>}
                </button>
                <button
                  onClick={() => setConfirmBulk(true)}
                  disabled={picked.size === 0}
                  className="btn-ghost h-7 text-[12px] text-bad pressable disabled:opacity-40 whitespace-nowrap"
                >
                  <Icon.Trash size={14} /> Delete
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <ViewBar
              onRefresh={refresh}
              refreshing={refreshing}
              layout={view.layout}
              onLayout={(layout) => setView({ layout })}
              selecting={selecting}
              onSelecting={(v) => (v ? setSelecting(true) : stopSelecting())}
              pageSize={view.pageSize}
              onPageSize={(pageSize) => setView({ pageSize })}
              page={win.page}
              pages={win.pages}
              onPage={setPage}
              total={folders.length}
              noun="folders"
            />
            <button onClick={() => setCreating(true)} className="btn-outline h-8 text-[12.5px] pressable">
              <Icon.Plus size={15} />
              <span className="hidden sm:inline">New folder</span>
            </button>
          </div>
        </section>

        {folders.length === 0 ? (
          <EmptyFolders onCreate={() => setCreating(true)} />
        ) : view.layout === 'grid' ? (
          <ul className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3 stagger">
            {win.slice.map((folder) => (
              <li key={folder.id}>
                <FolderCard
                  folder={folder}
                  layout="grid"
                  selecting={selecting}
                  selected={picked.has(folder.id)}
                  onToggle={() => togglePick(folder.id)}
                  onChanged={refresh}
                  onEdit={setEditing}
                />
              </li>
            ))}
          </ul>
        ) : (
          <ul className="card overflow-hidden stagger">
            {win.slice.map((folder) => (
              <li key={folder.id} className="border-b border-line last:border-0">
                <FolderCard
                  folder={folder}
                  layout="list"
                  selecting={selecting}
                  selected={picked.has(folder.id)}
                  onToggle={() => togglePick(folder.id)}
                  onChanged={refresh}
                  onEdit={setEditing}
                />
              </li>
            ))}
          </ul>
        )}

        <section className="mt-10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-[13px] font-medium text-muted flex items-center gap-1.5">
                <Icon.Chart size={14} /> Analytics
              </h2>
              {!analytics && (
                <p className="text-[12px] text-faint mt-1">
                  Off by default. Turn it on to pick folders and files to chart.
                </p>
              )}
            </div>
            <Toggle checked={analytics} onChange={toggleAnalytics} label="Analytics" />
          </div>

          {analytics && <AnalyticsPanel folders={folders} />}
        </section>
        </div>
      </main>

      <ConfirmModal
        open={confirmBulk}
        onClose={() => setConfirmBulk(false)}
        onConfirm={deletePicked}
        title={`Delete ${picked.size} folder${picked.size === 1 ? '' : 's'}?`}
        body="Every file inside them goes too. This cannot be undone."
      />

      <FolderModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(folder) => {
          setFolders((prev) => [folder, ...prev])
          setCreating(false)
        }}
      />

      <FolderModal
        open={editing !== null}
        folder={editing}
        onClose={() => setEditing(null)}
        onSaved={(folder) => {
          setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, ...folder } : f)))
          setEditing(null)
        }}
      />

      {aiEnabled && <ChatDock open={chatOpen} onClose={() => setChatOpen(false)} scope={{ fileId: null, folderId: null }} onApplied={refresh} />}
    </>
  )
}

/**
 * One folder, as a card or as a row.
 *
 * Two shapes rather than two components, because everything about a folder that
 * matters - the icon, the name, the count, the menu, whether it is picked - is
 * the same in both and only the arrangement differs. Splitting them is how one
 * of the two ends up without the edit option.
 *
 * While selecting, the whole thing is a checkbox: the link is suppressed, so a
 * tap picks rather than navigates. A row that both selects and opens depending
 * on where exactly you hit it is a row nobody can use confidently.
 */
function FolderCard({
  folder,
  layout,
  selecting = false,
  selected = false,
  onToggle,
  onChanged,
  onEdit,
}: {
  folder: FolderMeta
  layout: Layout
  selecting?: boolean
  selected?: boolean
  onToggle?: () => void
  onChanged: () => void
  onEdit: (f: FolderMeta) => void
}) {
  const [menu, setMenu] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const menuRef = useDismiss<HTMLDivElement>(menu, () => setMenu(false))

  const remove = async () => {
    await del(`/api/folders/${folder.id}`)
    toast.success(`Deleted "${folder.name}"`)
    onChanged()
  }

  const badge = folder.sample && <span className="chip h-5 px-2 text-[10px] shrink-0">sample</span>

  const menuNode = (
    <>
      <button
        onClick={(e) => { e.preventDefault(); setMenu((v) => !v) }}
        /* Bigger where it is tapped rather than pointed at. Seven-by-seven is
           a comfortable mouse target and a poor thumb one, and this one sits a
           few pixels from the edge of a card that navigates when touched. */
        className={`h-9 w-9 sm:h-7 sm:w-7 rounded-md grid place-items-center text-faint transition-all
                    hover:bg-raised hover:text-ink focus:opacity-100 [@media(hover:none)]:opacity-100
                    ${layout === 'grid' ? 'absolute top-1.5 right-1.5 sm:top-2.5 sm:right-2.5 opacity-0 group-hover:opacity-100' : 'shrink-0'}`}
        aria-label={`Options for ${folder.name}`}
        aria-expanded={menu}
      >
        <Icon.More size={15} />
      </button>

      {menu && (
        <div ref={menuRef} className="absolute right-2 top-9 z-50 w-44 card shadow-pop py-1 animate-scale-in origin-top-right">
          <button
            onClick={() => { setMenu(false); onEdit(folder) }}
            className="w-full text-left px-3 py-2 text-[12.5px] hover:bg-raised flex items-center gap-2 transition-colors"
          >
            <Icon.Pencil size={14} /> Edit folder
          </button>
          <button
            onClick={() => { setMenu(false); setConfirming(true) }}
            className="w-full text-left px-3 py-2 text-[12.5px] text-bad hover:bg-raised flex items-center gap-2 transition-colors"
          >
            <Icon.Trash size={14} /> Delete folder
          </button>
        </div>
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={remove}
        title={`Delete "${folder.name}"?`}
        body="Every file in this folder goes with it. This cannot be undone."
      />
    </>
  )

  const tick = selecting && (
    <span
      className={`w-[18px] h-[18px] rounded-[5px] border grid place-items-center shrink-0 transition-colors ${
        selected ? 'bg-accent border-accent text-white' : 'border-faint bg-surface'
      }`}
      aria-hidden
    >
      {selected && <Icon.Check size={12} />}
    </span>
  )

  if (layout === 'list') {
    const body = (
      <>
        {tick}
        <span className="w-8 h-8 rounded-lg grid place-items-center text-[15px] shrink-0" style={{ background: `${folder.color}1a` }}>
          {folder.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium truncate">{folder.name}</span>
          <span className="block text-[11.5px] text-muted">
            {folder.fileCount} file{folder.fileCount === 1 ? '' : 's'}
            <span className="text-faint"> · {relativeTime(folder.updatedAt)}</span>
          </span>
        </span>
        {badge}
      </>
    )

    return (
      <div className={`relative flex items-center gap-3 px-3.5 py-2.5 transition-colors ${selected ? 'bg-accent-soft/50' : 'hover:bg-raised/60'}`}>
        {selecting ? (
          <button onClick={onToggle} className="flex items-center gap-3 flex-1 min-w-0 text-left" aria-pressed={selected}>
            {body}
          </button>
        ) : (
          <Link href={`/folder/${folder.id}`} className="flex items-center gap-3 flex-1 min-w-0">
            {body}
          </Link>
        )}
        {menuNode}
      </div>
    )
  }

  const cardBody = (
    <>
      {/*
       * The right padding is the options button's seat. It sits outside this
       * link, floated over the card's corner, so nothing in here knows to get
       * out of its way - which put it straight on top of the sample chip.
       * Reserving the space unconditionally keeps the chip still: paying for
       * it only on hover would slide the chip sideways under the cursor.
       */}
      <div className="flex items-start justify-between gap-2 pr-8">
        <span className="flex items-center gap-2 min-w-0">
          {tick}
          <span
            className="w-9 h-9 rounded-lg grid place-items-center text-[17px] shrink-0"
            style={{ background: `${folder.color}1a` }}
          >
            {folder.icon}
          </span>
        </span>
        {badge}
      </div>

      <p className="text-[13.5px] font-medium mt-3 leading-snug line-clamp-2">{folder.name}</p>
      <p className="text-[11.5px] text-muted mt-1">
        {folder.fileCount} file{folder.fileCount === 1 ? '' : 's'}
        <span className="text-faint"> · {relativeTime(folder.updatedAt)}</span>
      </p>
    </>
  )

  const cardClass = `card lift block p-3.5 sm:p-4 h-full w-full text-left transition-colors ${
    selected ? 'border-accent/50 bg-accent-soft/40' : 'hover:border-faint'
  }`

  return (
    <div className="relative group h-full">
      {selecting ? (
        <button onClick={onToggle} className={cardClass} aria-pressed={selected}>{cardBody}</button>
      ) : (
        <Link href={`/folder/${folder.id}`} className={cardClass}>{cardBody}</Link>
      )}
      {menuNode}
    </div>
  )
}

function EmptyFolders({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="card p-10 text-center animate-rise">
      <Icon.Folder size={26} className="mx-auto text-faint" />
      <p className="text-[14px] font-medium mt-3">No folders yet</p>
      <p className="text-[13px] text-muted mt-1.5 max-w-xs mx-auto leading-relaxed">
        A folder holds files; a file holds rows. Start with one for whatever
        you're tracking this month.
      </p>
      <button onClick={onCreate} className="btn-primary mt-5 pressable">
        <Icon.Plus size={15} /> Create a folder
      </button>
    </div>
  )
}

/**
 * One form for making a folder and for changing one.
 *
 * The two differ by a verb and an endpoint; everything a person actually
 * interacts with - the name, the icon, the colour - is identical, and keeping
 * two copies of it in sync is how one of them ends up missing a colour.
 */
function FolderModal({
  open,
  folder,
  onClose,
  onSaved,
}: {
  open: boolean
  /** Present when editing, absent when creating. */
  folder?: FolderMeta | null
  onClose: () => void
  onSaved: (f: FolderMeta) => void
}) {
  const editing = Boolean(folder)
  const [name, setName] = useState('')
  const [icon, setIcon] = useState(ICONS[0])
  const [color, setColor] = useState(COLORS[0])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(folder?.name ?? '')
    setIcon(folder?.icon ?? ICONS[0])
    setColor(folder?.color ?? COLORS[0])
  }, [open, folder])

  const save = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      if (folder) {
        const res = await patch<{ folder: FolderMeta }>(`/api/folders/${folder.id}`, { name: name.trim(), icon, color })
        toast.success(`Saved "${res.folder.name}"`)
        onSaved(res.folder)
      } else {
        // Client-minted id: a double-tap or a retry can't create two folders.
        const res = await post<{ folder: FolderMeta }>('/api/folders', { name: name.trim(), icon, color, id: ulid() })
        toast.success(`Created "${res.folder.name}"`)
        onSaved(res.folder)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit folder' : 'New folder'}
      description={editing ? 'Rename it, or give it a different icon and colour.' : 'Group related files together: a trip, a month, a project.'}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary pressable" onClick={save} disabled={!name.trim() || busy}>
            {busy ? <Icon.Spinner /> : editing ? 'Save changes' : 'Create folder'}
          </button>
        </>
      }
    >
      <label className="label" htmlFor="folder-name">Name</label>
      <input
        id="folder-name"
        className="input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void save() }}
        placeholder="October trip"
        autoFocus
        maxLength={80}
      />

      <p className="label mt-4">Icon</p>
      <div className="flex flex-wrap gap-1.5">
        {ICONS.map((i) => (
          <button
            key={i}
            onClick={() => setIcon(i)}
            className={`w-9 h-9 rounded-lg text-[16px] grid place-items-center border transition-all pressable ${
              icon === i ? 'border-accent bg-accent-soft scale-105' : 'border-line hover:bg-raised'
            }`}
            aria-label={`Icon ${i}`}
            aria-pressed={icon === i}
          >
            {i}
          </button>
        ))}
      </div>

      <p className="label mt-4">Colour</p>
      <div className="flex flex-wrap gap-1.5">
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`w-9 h-9 rounded-lg border-2 transition-all pressable ${color === c ? 'scale-110' : 'border-transparent'}`}
            style={{ background: `${c}26`, borderColor: color === c ? c : 'transparent' }}
            aria-label={`Colour ${c}`}
            aria-pressed={color === c}
          >
            <span className="block w-3 h-3 rounded-full mx-auto" style={{ background: c }} />
          </button>
        ))}
      </div>
    </Modal>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    /*
     * The switch is 42x24 to look at and 42x40 to press on a phone.
     *
     * A 24px control is well under every platform's minimum target, and this
     * one sits beside a heading people are trying to read rather than hit. The
     * button owns the taller box and the track is drawn inside it, so the touch
     * area is real - a pseudo-element would have been invisible to anything
     * measuring the control, including an accessibility audit.
     *
     * The knob is a child of the track rather than an absolutely positioned
     * sibling. Absolute with no `left` falls back to the static position, which
     * sits inside the button's UA padding, and the knob used to hang past the
     * end of its own track because of it.
     */
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="grid place-items-center w-[42px] h-10 sm:h-6 p-0 border-0 bg-transparent shrink-0"
    >
      <span className={`block w-[42px] h-6 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-line'}`}>
        <span
          className={`block w-[18px] h-[18px] mt-[3px] rounded-full bg-white
                      shadow-[0_1px_2px_rgb(0_0_0/.28)] ring-1 ring-black/5 transition-transform duration-200 ${
            checked ? 'translate-x-[21px]' : 'translate-x-[3px]'
          }`}
          style={{ transitionTimingFunction: 'cubic-bezier(.2,.7,.3,1)' }}
        />
      </span>
    </button>
  )
}
