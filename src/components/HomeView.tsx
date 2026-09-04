'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import type { FolderMeta } from '@/lib/model/types'
import { Icon } from './ui/Icons'
import { Modal } from './ui/Modal'
import { AccountMenu, TopBar, useShell } from './AppShell'
import { del, get, patch, post } from '@/lib/client/api'
import { toast } from './ui/Toast'
import { relativeTime } from '@/lib/util/format'
import { AnalyticsPanel } from './AnalyticsPanel'
import { ChatDock } from './chat/ChatDock'
import { ulid } from '@/lib/util/ids'

const ICONS = ['📁', '🧭', '🏠', '🍚', '🚗', '💊', '🎒', '🎁', '🔧', '📚', '✈️', '🧾']
const COLORS = ['#2260c4', '#c2410c', '#0f766e', '#7c3aed', '#b91c1c', '#0369a1', '#4d7c0f', '#a16207']

export function HomeView({ initialFolders, analyticsEnabled }: { initialFolders: FolderMeta[]; analyticsEnabled: boolean }) {
  const { session, aiEnabled } = useShell()
  const [folders, setFolders] = useState(initialFolders)
  const [creating, setCreating] = useState(false)
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

  return (
    <>
      <TopBar
        title="Khata"
        subtitle={`${folders.length} folder${folders.length === 1 ? '' : 's'} · ${total} file${total === 1 ? '' : 's'}`}
        actions={
          <>
            <button onClick={refresh} className="btn-ghost h-9 w-9 px-0 pressable" aria-label="Refresh" title="Refresh">
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
      />

      <main className="flex-1 px-3 sm:px-5 py-5 max-w-5xl w-full mx-auto pb-24">
        <section className="flex items-center justify-between mb-4">
          <h2 className="text-[13px] font-medium text-muted">Folders</h2>
          <button onClick={() => setCreating(true)} className="btn-outline h-8 text-[12.5px] pressable">
            <Icon.Plus size={15} />
            New folder
          </button>
        </section>

        {folders.length === 0 ? (
          <EmptyFolders onCreate={() => setCreating(true)} />
        ) : (
          <ul className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 sm:gap-3 stagger">
            {folders.map((folder) => (
              <li key={folder.id}>
                <FolderCard folder={folder} onChanged={refresh} />
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
                  Off by default — turn it on to pick folders and files to chart.
                </p>
              )}
            </div>
            <Toggle checked={analytics} onChange={toggleAnalytics} label="Analytics" />
          </div>

          {analytics && <AnalyticsPanel folders={folders} />}
        </section>
      </main>

      <NewFolderModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(folder) => {
          setFolders((prev) => [folder, ...prev])
          setCreating(false)
        }}
      />

      {aiEnabled && <ChatDock open={chatOpen} onClose={() => setChatOpen(false)} scope={{ fileId: null, folderId: null }} onApplied={refresh} />}
    </>
  )
}

function FolderCard({ folder, onChanged }: { folder: FolderMeta; onChanged: () => void }) {
  const [menu, setMenu] = useState(false)

  const remove = async () => {
    if (!confirm(`Delete "${folder.name}" and everything in it? This cannot be undone.`)) return
    await del(`/api/folders/${folder.id}`)
    toast.success(`Deleted "${folder.name}"`)
    onChanged()
  }

  return (
    <div className="relative group">
      <Link
        href={`/folder/${folder.id}`}
        className="card lift block p-3.5 sm:p-4 h-full hover:border-faint transition-colors"
      >
        <div className="flex items-start justify-between gap-2">
          <span
            className="w-9 h-9 rounded-lg grid place-items-center text-[17px] shrink-0"
            style={{ background: `${folder.color}1a` }}
          >
            {folder.icon}
          </span>
          {folder.sample && <span className="chip h-5 px-2 text-[10px]">sample</span>}
        </div>

        <p className="text-[13.5px] font-medium mt-3 leading-snug line-clamp-2">{folder.name}</p>
        <p className="text-[11.5px] text-muted mt-1">
          {folder.fileCount} file{folder.fileCount === 1 ? '' : 's'}
          <span className="text-faint"> · {relativeTime(folder.updatedAt)}</span>
        </p>
      </Link>

      <button
        onClick={(e) => { e.preventDefault(); setMenu((v) => !v) }}
        className="absolute top-2.5 right-2.5 h-7 w-7 rounded-md grid place-items-center text-faint
                   opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-raised hover:text-ink transition-all"
        aria-label={`Options for ${folder.name}`}
      >
        <Icon.Grip size={15} />
      </button>

      {menu && (
        <>
          <button className="fixed inset-0 z-40 cursor-default" onClick={() => setMenu(false)} aria-hidden tabIndex={-1} />
          <div className="absolute right-2 top-9 z-50 w-40 card shadow-pop py-1 animate-scale-in origin-top-right">
            <button onClick={remove} className="w-full text-left px-3 py-2 text-[12.5px] text-bad hover:bg-raised flex items-center gap-2 transition-colors">
              <Icon.Trash size={14} /> Delete folder
            </button>
          </div>
        </>
      )}
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

function NewFolderModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (f: FolderMeta) => void }) {
  const [name, setName] = useState('')
  const [icon, setIcon] = useState(ICONS[0])
  const [color, setColor] = useState(COLORS[0])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) { setName(''); setIcon(ICONS[0]); setColor(COLORS[0]) }
  }, [open])

  const create = async () => {
    if (!name.trim()) return
    setBusy(true)
    try {
      // Client-minted id: a double-tap or a retry can't create two folders.
      const res = await post<{ folder: FolderMeta }>('/api/folders', { name: name.trim(), icon, color, id: ulid() })
      toast.success(`Created "${res.folder.name}"`)
      onCreated(res.folder)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New folder"
      description="Group related files together — a trip, a month, a project."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary pressable" onClick={create} disabled={!name.trim() || busy}>
            {busy ? <Icon.Spinner /> : 'Create folder'}
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
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void create() }}
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
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative w-[42px] h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-accent' : 'bg-line'}`}
    >
      <span
        className={`absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-[21px]' : 'translate-x-[3px]'
        }`}
        style={{ transitionTimingFunction: 'cubic-bezier(.2,.7,.3,1)' }}
      />
    </button>
  )
}
