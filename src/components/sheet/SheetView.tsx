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
import { formatMoney } from '@/lib/util/format'
import { ConfirmModal } from '../ui/Modal'
import { Calculator } from '../ui/Calculator'
import { numeric } from '@/lib/crdt/doc'
import { del } from '@/lib/client/api'

/**
 * The file editor.
 *
 * Three regions on a wide screen - the sheet, a summary rail, and the assistant
 * - collapsing to one column with the assistant behind a button on a phone.
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
    const titleCol = doc.columns.find((c) => c.kind === 'text' && c.system)
    const byRow = () =>
      sheet.rows.map((r) => ({
        key: String(r.cells[titleCol?.id ?? ''] ?? 'Untitled').slice(0, 30) || 'Untitled',
        total: numeric(r.cells[amountCol.id]),
      }))

    if (!groupCol) return byRow()

    const map = new Map<string, number>()
    let categorised = 0
    for (const r of sheet.rows) {
      const raw = r.cells[groupCol.id]
      const filled = raw != null && raw !== '' && !Array.isArray(raw)
      if (filled) categorised++
      const key = filled ? String(raw).slice(0, 30) : 'Not set'
      map.set(key, (map.get(key) ?? 0) + numeric(r.cells[amountCol.id]))
    }

    // One slice fills the whole arc, which reads as a progress bar at 100% and
    // tells the user nothing. If the grouping column isn't earning its place
    // yet, show the composition by row instead.
    const distinctFilled = [...map.keys()].filter((k) => k !== 'Not set').length
    if (categorised === 0 || distinctFilled < 2) return byRow()

    return [...map.entries()].map(([key, total]) => ({ key, total }))
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
              className="text-left hover:text-accent transition-colors truncate max-w-full
                         inline-flex items-center min-h-[34px] sm:min-h-0"
              title="Rename"
            >
              {doc.name}
            </button>
          )
        }
        subtitle={
          /*
           * The phone gets the total instead of the folder name.
           *
           * On one column the running total lives at the bottom of the card
           * list, which is a long scroll away in any file worth keeping. The
           * folder is the screen you just came from and the back arrow leads
           * to it, so it is the line worth giving up here.
           */
          <span className="flex items-center gap-1.5">
            <span className="hidden sm:inline truncate">{folderName}</span>
            <span className="hidden sm:inline text-faint">·</span>
            <span className="sm:hidden font-semibold text-ink tnum">{formatMoney(totals.total, doc.currency, { decimals: false })}</span>
            <span className="sm:hidden text-faint">·</span>
            <span className="sm:hidden">{totals.count} row{totals.count === 1 ? '' : 's'}</span>
            {/*
              * "Saved" is a steady state, and on a 360px header it was the word
              * that got cut in half. Below `sm` the indicator appears only when
              * there is something to say: unsaved, saving, offline, in
              * conflict. Silence means saved, which is what silence should mean.
              */}
            <span className={`items-center gap-1.5 ${QUIET_STATES.has(state) ? 'hidden sm:flex' : 'flex'}`}>
              <span className="text-faint">·</span>
              <SaveIndicator state={state} />
            </span>
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

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <main className="flex-1 min-w-0 scroller px-3 sm:px-5 py-4 pb-10">
          <div className="max-w-5xl mx-auto">
            <Toolbar
              doc={doc}
              sheet={sheet}
              onDiscard={() => setDiscarding(true)}
              onCalculator={() => setCalcOpen(true)}
            />

            {/*
              * The rows come first in the source, so on one column the ledger
              * is what you land on. The rail used to be ordered above it,
              * which pushed the table a full screen down on a phone: opening
              * a file showed a gauge, four statistics and a date picker before
              * a single row. The running total is not lost by moving it below,
              * because the phone card list carries its own total footer.
              */}
            <div className="grid lg:grid-cols-[minmax(0,1fr)_252px] gap-4 mt-4 items-start">
              <div className="min-w-0">
                <Grid sheet={sheet} />
              </div>

              <aside className="space-y-3 lg:sticky lg:top-0">
                <div className="card p-4">
                  <Gauge
                    total={totals.total}
                    slices={slices}
                    rowCount={totals.count}
                    label="This file"
                    currency={doc.currency}
                    compact
                  />
                </div>

                <div className="card divide-y divide-line">
                  <Stat label="Total" value={<AnimatedNumber value={totals.total} format={(n) => formatMoney(n, doc.currency)} className="font-semibold" />} />
                  <Stat label="Rows" value={<AnimatedNumber value={totals.count} format={(n) => String(Math.round(n))} />} />
                  <Stat label="Average" value={formatMoney(totals.mean, doc.currency, { decimals: false })} />
                  <Stat label="Largest" value={formatMoney(totals.max, doc.currency, { decimals: false })} />
                </div>

                <DurationBar duration={doc.duration} onChange={actions.setDuration} />
              </aside>
            </div>
          </div>
        </main>

        {/* The assistant is a permanent column on wide screens, a sheet elsewhere. */}
        {aiEnabled && (
          <>
            <aside className="hidden xl:flex w-[380px] 2xl:w-[420px] shrink-0 border-l border-line bg-surface flex-col overflow-hidden no-print">
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
                  className="hidden sm:block xl:hidden fixed inset-0 z-40 bg-black/25 backdrop-blur-[1px] animate-fade cursor-default no-print"
                  onClick={() => setChatOpen(false)}
                  aria-label="Close assistant"
                  tabIndex={-1}
                />
                {/* Full screen on a phone; a drawer once there is room beside
                    the sheet. Same reasoning as the dock: a part-height sheet
                    plus a keyboard leaves nothing to read. */}
                <aside
                  role="dialog"
                  aria-label="Assistant"
                  className="xl:hidden fixed z-50 bg-surface border-line shadow-pop no-print overflow-hidden flex flex-col
                             inset-0 h-dvh animate-rise
                             sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[min(400px,100vw)] sm:h-auto sm:border-l sm:animate-slide-l"
                >
                  <ChatPanel
                    scope={{ fileId, folderId }}
                    onApplied={onAssistantWrite}
                    onClose={() => setChatOpen(false)}
                    subtitle={doc.name}
                    compact
                  />
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

/** States a phone header does not need to spend characters announcing. */
const QUIET_STATES = new Set(['idle', 'saved'])

const SAVE_COPY: Record<string, { text: string; className: string }> = {
  idle: { text: 'Saved', className: 'text-faint' },
  dirty: { text: 'Unsaved changes', className: 'text-warn' },
  saving: { text: 'Saving…', className: 'text-muted animate-pulse-soft' },
  saved: { text: 'Saved', className: 'text-good' },
  offline: { text: 'Offline, will retry', className: 'text-warn' },
  conflict: { text: 'Conflict', className: 'text-bad' },
  error: { text: 'Save failed', className: 'text-bad' },
}

function SaveIndicator({ state }: { state: string }) {
  const copy = SAVE_COPY[state] ?? SAVE_COPY.idle
  return <span className={`shrink-0 ${copy.className}`}>{copy.text}</span>
}

/**
 * Shown when the server refused a batch because someone else touched the same
 * cells. The user's edits are still queued - this asks which version wins
 * rather than picking one and hoping.
 */
function ConflictBanner({ onResolve }: { onResolve: (choice: 'theirs' | 'retry') => void }) {
  return (
    <div className="bg-warn/12 border-b border-warn/35 px-4 py-3 animate-rise no-print">
      <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-3">
        <Icon.Warning size={16} className="text-warn shrink-0" />
        <p className="text-[13px] flex-1 min-w-0">
          <span className="font-medium">This file changed somewhere else.</span>
          <span className="text-muted"> Your edits are still here, unsaved.</span>
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
