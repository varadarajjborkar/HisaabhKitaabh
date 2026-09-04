'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useSheet } from '@/lib/client/useSheet'
import type { SheetDoc } from '@/lib/model/types'
import { Grid } from './Grid'
import { DurationBar } from './DurationBar'
import { Toolbar } from './Toolbar'
import { Gauge } from '../charts/Gauge'
import { AccountMenu, TopBar, useShell } from '../AppShell'
import { Icon } from '../ui/Icons'
import { ChatPanel } from '../chat/ChatPanel'
import { AnimatedNumber } from '../ui/AnimatedNumber'
import { formatINR } from '@/lib/util/format'
import { ConfirmModal } from '../ui/Modal'
import { Calculator } from '../ui/Calculator'
import { numeric } from '@/lib/crdt/doc'
import { del } from '@/lib/client/api'

/**
 * The file editor.
 *
 * Three regions on a wide screen — the sheet, a summary rail, and the assistant
 * — collapsing to one column with the assistant behind a button on a phone.
 * The assistant is *in here*, not only on the home screen, because the moment
 * you want to say "fix all the Ubers" is the moment you are looking at them.
 */
export function SheetView({
  fileId,
  folderId,
  folderName,
  initialDoc,
}: {
  fileId: string
  folderId: string
  folderName: string
  initialDoc?: SheetDoc | null
}) {
  const sheet = useSheet(fileId, initialDoc)
  const { session, aiEnabled } = useShell()
  const router = useRouter()

  const [chatOpen, setChatOpen] = useState(false)
  const [calcOpen, setCalcOpen] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  const { doc, totals, actions, state, error } = sheet

  // Undo/redo and save are muscle memory; they must work from anywhere in the
  // page, but never while the user is typing into a cell.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const el = document.activeElement
      const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement

      if (e.key.toLowerCase() === 's') { e.preventDefault(); void actions.saveNow() }
      else if (e.key.toLowerCase() === 'z' && !e.shiftKey && !typing) { e.preventDefault(); actions.undo() }
      else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        if (typing) return
        e.preventDefault()
        actions.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  const onAssistantWrite = useCallback(() => {
    void actions.adoptRemote()
  }, [actions])

  const discard = async () => {
    await del(`/api/files/${fileId}`)
    router.push(`/folder/${folderId}`)
  }

  if (sheet.loading && !doc) return <SheetSkeleton />

  if (!doc) {
    return (
      <div className="flex-1 grid place-items-center p-6">
        <div className="card p-8 text-center max-w-sm">
          <Icon.Warning size={22} className="mx-auto text-warn" />
          <p className="text-[14px] font-medium mt-3">This file could not be loaded</p>
          <p className="text-[13px] text-muted mt-1.5">{error ?? 'It may have been deleted.'}</p>
          <button onClick={() => router.push(`/folder/${folderId}`)} className="btn-outline mt-5">Back to the folder</button>
        </div>
      </div>
    )
  }

  // Composition for the gauge: group by the first choice-like column, else by row.
  const groupCol = doc.columns.find((c) => c.kind === 'select') ?? doc.columns.find((c) => !c.system && c.kind === 'text')
  const amountCol = doc.columns.find((c) => c.kind === 'amount')
  const slices = (() => {
    if (!amountCol) return []
    if (groupCol) {
      const map = new Map<string, number>()
      for (const r of sheet.rows) {
        const raw = r.cells[groupCol.id]
        const key = raw == null || raw === '' ? 'Not set' : Array.isArray(raw) ? 'Files' : String(raw).slice(0, 30)
        map.set(key, (map.get(key) ?? 0) + numeric(r.cells[amountCol.id]))
      }
      return [...map.entries()].map(([key, total]) => ({ key, total }))
    }
    const titleCol = doc.columns.find((c) => c.kind === 'text' && c.system)
    return sheet.rows.map((r) => ({
      key: String(r.cells[titleCol?.id ?? ''] ?? 'Untitled').slice(0, 30),
      total: numeric(r.cells[amountCol.id]),
    }))
  })()

  return (
    <>
      <TopBar
        back={`/folder/${folderId}`}
        title={
          renaming ? (
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => { if (nameDraft.trim() && nameDraft !== doc.name) actions.renameDoc(nameDraft.trim()); setRenaming(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') { setRenaming(false) }
              }}
              autoFocus
              maxLength={120}
              className="bg-surface border border-accent rounded px-2 py-0.5 text-[14.5px] font-semibold outline-none w-full max-w-xs"
              aria-label="File name"
            />
          ) : (
            <button
              onClick={() => { setNameDraft(doc.name); setRenaming(true) }}
              className="text-left hover:text-accent transition-colors truncate max-w-full"
              title="Rename"
            >
              {doc.name}
            </button>
          )
        }
        subtitle={
          <span className="flex items-center gap-1.5">
            <span className="truncate">{folderName}</span>
            <span className="text-faint">·</span>
            <SaveIndicator state={state} />
          </span>
        }
        actions={
          <>
            <button
              onClick={actions.undo}
              disabled={!sheet.canUndo}
              className="btn-ghost h-9 w-9 px-0 pressable"
              aria-label="Undo"
              title="Undo (⌘Z)"
            >
              <Icon.Undo size={17} />
            </button>
            <button
              onClick={actions.redo}
              disabled={!sheet.canRedo}
              className="btn-ghost h-9 w-9 px-0 pressable"
              aria-label="Redo"
              title="Redo (⇧⌘Z)"
            >
              <Icon.Redo size={17} />
            </button>
            {aiEnabled && (
              <button
                onClick={() => setChatOpen((v) => !v)}
                className={`btn-ghost h-9 w-9 px-0 pressable xl:hidden ${chatOpen ? 'text-accent bg-accent-soft' : ''}`}
                aria-label="Assistant"
              >
                <Icon.Sparkle size={17} />
              </button>
            )}
            <AccountMenu session={session} />
          </>
        }
      />

      {state === 'conflict' && <ConflictBanner onResolve={actions.resolveConflict} />}

      <div className="flex-1 flex min-h-0">
        <main className="flex-1 min-w-0 px-3 sm:px-5 py-4 pb-28 overflow-y-auto">
          <div className="max-w-5xl mx-auto">
            <Toolbar
              doc={doc}
              sheet={sheet}
              onDiscard={() => setDiscarding(true)}
              onCalculator={() => setCalcOpen(true)}
            />

            <div className="grid lg:grid-cols-[1fr_248px] gap-4 mt-4">
              <div className="min-w-0 order-2 lg:order-1">
                <Grid sheet={sheet} />
              </div>

              <aside className="order-1 lg:order-2 space-y-3">
                <div className="card p-4">
                  <Gauge
                    total={totals.total}
                    slices={slices}
                    rowCount={totals.count}
                    label="This file"
                    compact
                  />
                </div>

                <div className="card divide-y divide-line">
                  <Stat label="Total" value={<AnimatedNumber value={totals.total} format={(n) => formatINR(n)} className="font-semibold" />} />
                  <Stat label="Rows" value={<AnimatedNumber value={totals.count} format={(n) => String(Math.round(n))} />} />
                  <Stat label="Average" value={formatINR(totals.mean, { decimals: false })} />
                  <Stat label="Largest" value={formatINR(totals.max, { decimals: false })} />
                </div>

                <DurationBar duration={doc.duration} onChange={actions.setDuration} />
              </aside>
            </div>
          </div>
        </main>

        {/* The assistant is a permanent column on wide screens, a sheet elsewhere. */}
        {aiEnabled && (
          <>
            <aside className="hidden xl:flex w-[368px] shrink-0 border-l border-line bg-surface flex-col no-print">
              <ChatPanel
                scope={{ fileId, folderId }}
                onApplied={onAssistantWrite}
                compact
                suggestions={[
                  'Add 450 for a cab, paid by UPI',
                  'What did I spend the most on here?',
                  'Find anything entered twice',
                ]}
              />
            </aside>

            {chatOpen && (
              <>
                <button
                  className="xl:hidden fixed inset-0 z-40 bg-black/25 animate-fade cursor-default no-print"
                  onClick={() => setChatOpen(false)}
                  aria-label="Close assistant"
                  tabIndex={-1}
                />
                <aside className="xl:hidden fixed z-50 bg-surface border-line shadow-pop no-print
                                  inset-x-0 bottom-0 h-[84dvh] rounded-t-xl2 border-t animate-rise
                                  sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[390px] sm:h-auto sm:rounded-none sm:border-l sm:border-t-0 sm:animate-slide-l">
                  <button
                    onClick={() => setChatOpen(false)}
                    className="absolute top-2.5 right-2.5 z-10 h-7 w-7 grid place-items-center rounded-md text-faint hover:text-ink hover:bg-raised transition-colors"
                    aria-label="Close"
                  >
                    <Icon.Close size={15} />
                  </button>
                  <ChatPanel scope={{ fileId, folderId }} onApplied={onAssistantWrite} compact />
                </aside>
              </>
            )}
          </>
        )}
      </div>

      <Calculator open={calcOpen} onClose={() => setCalcOpen(false)} />

      <ConfirmModal
        open={discarding}
        onClose={() => setDiscarding(false)}
        onConfirm={discard}
        title={`Discard "${doc.name}"?`}
        body="The file and all its rows are deleted. This cannot be undone."
        confirmLabel="Discard file"
      />
    </>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-3.5 py-2.5">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-[13.5px] tnum">{value}</span>
    </div>
  )
}

const SAVE_COPY: Record<string, { text: string; className: string }> = {
  idle: { text: 'Saved', className: 'text-faint' },
  dirty: { text: 'Unsaved changes', className: 'text-warn' },
  saving: { text: 'Saving…', className: 'text-muted animate-pulse-soft' },
  saved: { text: 'Saved', className: 'text-good' },
  offline: { text: 'Offline — will retry', className: 'text-warn' },
  conflict: { text: 'Conflict', className: 'text-bad' },
  error: { text: 'Save failed', className: 'text-bad' },
}

function SaveIndicator({ state }: { state: string }) {
  const copy = SAVE_COPY[state] ?? SAVE_COPY.idle
  return <span className={`shrink-0 ${copy.className}`}>{copy.text}</span>
}

/**
 * Shown when the server refused a batch because someone else touched the same
 * cells. The user's edits are still queued — this asks which version wins
 * rather than picking one and hoping.
 */
function ConflictBanner({ onResolve }: { onResolve: (choice: 'theirs' | 'retry') => void }) {
  return (
    <div className="bg-warn/12 border-b border-warn/35 px-4 py-3 animate-rise no-print">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-3">
        <Icon.Warning size={16} className="text-warn shrink-0" />
        <p className="text-[13px] flex-1 min-w-0">
          <span className="font-medium">This file changed somewhere else</span>
          <span className="text-muted"> — your edits are still here, unsaved.</span>
        </p>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => onResolve('retry')} className="btn-primary h-8 text-[12.5px] pressable">Keep mine and retry</button>
          <button onClick={() => onResolve('theirs')} className="btn-outline h-8 text-[12.5px] pressable">Take theirs</button>
        </div>
      </div>
    </div>
  )
}

function SheetSkeleton() {
  return (
    <div className="flex-1 px-3 sm:px-5 py-4">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="skeleton h-10 w-full" />
        <div className="grid lg:grid-cols-[1fr_248px] gap-4">
          <div className="space-y-2">
            {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-11" />)}
          </div>
          <div className="space-y-3">
            <div className="skeleton h-[190px]" />
            <div className="skeleton h-[130px]" />
          </div>
        </div>
      </div>
    </div>
  )
}
