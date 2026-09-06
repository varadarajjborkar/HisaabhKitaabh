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
import { useDismiss } from '@/lib/client/useDismiss'
import { numeric } from '@/lib/crdt/doc'
import { del } from '@/lib/client/api'

const ASSISTANT_KEY = 'hisaabhkitaabh-assistant-open'

/**
 * The file editor.
 *
 * Three regions on a wide screen - the sheet, a summary rail, and the assistant
 * - collapsing to one column with the assistant behind a button on a phone.
 * The assistant is *in here*, not only on the home screen, because the moment
 * you want to say "fix all the Ubers" is the moment you are looking at them.
 *
 * The assistant column folds away, and the sheet takes the width back. Being
 * able to say "not now" to a panel is the difference between a tool that is
 * available and one that is simply there.
 */
const BY_ROW = '__row__'
const GROUP_KEY = (fileId: string) => `hisaabhkitaabh-gauge-group:${fileId}`

/**
 * Which column the composition is broken down by.
 *
 * Sits under the chart rather than behind a settings menu: it is the label for
 * what is on screen as much as it is a control, and a breakdown whose basis is
 * not stated is a breakdown that can be misread.
 */
function GroupPicker({
  columns,
  value,
  activeName,
  onChange,
}: {
  columns: Array<{ id: string; name: string }>
  value: string
  activeName: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))

  return (
    <div className="relative mt-2.5" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Break the total down by"
        // Taller on a phone: a 28px control is under the size a thumb can
        // reliably hit, and this one sits directly under the chart it labels.
        className="w-full h-9 sm:h-7 px-2 rounded-md text-[11.5px] text-faint hover:text-ink hover:bg-raised
                   transition-colors inline-flex items-center justify-center gap-1"
      >
        by {activeName}
        <Icon.Down size={10} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-30 card shadow-pop py-1 max-h-[240px] overflow-y-auto overscroll-contain animate-scale-in origin-top">
          {[{ id: BY_ROW, name: 'Each row' }, ...columns].map((c) => {
            // The tick follows what is drawn, so an auto-picked column that
            // gave way to the row breakdown ticks "Each row", not itself.
            const on = c.id === BY_ROW ? activeName === 'each row' : activeName === c.name
            return (
              <button
                key={c.id}
                onClick={() => { onChange(c.id); setOpen(false) }}
                className={`w-full text-left px-2.5 py-1.5 text-[12.5px] hover:bg-raised transition-colors flex items-center gap-2 ${on ? 'text-accent' : ''}`}
              >
                <span className="w-3.5 shrink-0">{on && <Icon.Check size={12} />}</span>
                <span className="truncate">{c.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

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
  // Remembered per file: which column the composition is broken down by. The
  // empty string means "whichever one looks useful", the state it shipped in.
  const [groupBy, setGroupBy] = useState('')
  useEffect(() => {
    try { setGroupBy(localStorage.getItem(GROUP_KEY(fileId)) ?? '') } catch { /* a default is fine */ }
  }, [fileId])
  const chooseGroup = (id: string) => {
    setGroupBy(id)
    try { localStorage.setItem(GROUP_KEY(fileId), id) } catch { /* preference only */ }
  }
  const router = useRouter()

  const [chatOpen, setChatOpen] = useState(false)
  /*
   * Whether the permanent assistant column is showing.
   *
   * On a wide screen the panel was welded to the side of the page, taking 380
   * pixels whether or not anyone wanted it there. It collapses now, and the
   * sheet re-centres into the space rather than staying pinned left. The choice
   * is remembered, because "I do not want this here" is a preference and not a
   * per-visit decision.
   */
  const [assistantOpen, setAssistantOpen] = useState(true)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ASSISTANT_KEY)
      if (saved !== null) setAssistantOpen(saved === 'true')
    } catch { /* showing it is the right default */ }
  }, [])

  const toggleAssistant = () => {
    setAssistantOpen((v) => {
      const next = !v
      try { localStorage.setItem(ASSISTANT_KEY, String(next)) } catch { /* preference only */ }
      return next
    })
  }
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

  /*
   * What the gauge breaks the total down by.
   *
   * It used to pick a column and never say so, which is fine right up until it
   * picks the wrong one: a file with a payment method and a category has two
   * honest answers and the useful one is whichever the user is thinking about
   * at the time. So the choice is theirs, remembered per file, and the picker
   * names the column it is currently using.
   */
  const amountCol = doc.columns.find((c) => c.kind === 'amount')
  const groupable = doc.columns.filter((c) => c.kind === 'select' || c.kind === 'text')
  const autoCol = doc.columns.find((c) => c.kind === 'select') ?? doc.columns.find((c) => !c.system && c.kind === 'text')

  /*
   * The grouping is decided once, and both the chart and its label read that
   * one answer.
   *
   * They used to be worked out separately, which left room for the label to
   * name a column while the arc showed something else: an auto-picked column
   * that turns out to be empty falls back to a breakdown by row, and the label
   * would have gone on claiming the column. A caption that disagrees with the
   * picture is worse than no caption.
   */
  const grouping = (() => {
    if (!amountCol) return null
    if (groupBy === BY_ROW) return null
    const chosen = groupable.find((c) => c.id === groupBy)
    const col = chosen ?? autoCol
    if (!col) return null

    let categorised = 0
    const distinct = new Set<string>()
    for (const r of sheet.rows) {
      const raw = r.cells[col.id]
      if (raw != null && raw !== '' && !Array.isArray(raw)) { categorised++; distinct.add(String(raw)) }
    }
    // One slice fills the whole arc, which reads as a progress bar at 100% and
    // tells the user nothing. A column that is not earning its place yet gives
    // way to the row breakdown - unless the user named it, in which case they
    // are entitled to see what it actually contains, empty or not.
    if (!chosen && (categorised === 0 || distinct.size < 2)) return null
    return col
  })()

  const slices = (() => {
    if (!amountCol) return []
    if (!grouping) {
      const titleCol = doc.columns.find((c) => c.kind === 'text' && c.system)
      return sheet.rows.map((r) => ({
        key: String(r.cells[titleCol?.id ?? ''] ?? 'Untitled').slice(0, 30) || 'Untitled',
        total: numeric(r.cells[amountCol.id]),
      }))
    }
    const map = new Map<string, number>()
    for (const r of sheet.rows) {
      const raw = r.cells[grouping.id]
      const filled = raw != null && raw !== '' && !Array.isArray(raw)
      map.set(filled ? String(raw).slice(0, 30) : 'Not set', (map.get(filled ? String(raw).slice(0, 30) : 'Not set') ?? 0) + numeric(r.cells[amountCol.id]))
    }
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
              <>
                {/* Two buttons rather than one that has to work out how wide
                    the window is: below xl the assistant is a sheet, at xl it
                    is the column beside the sheet, and they are not the same
                    thing to open. */}
                <button
                  onClick={() => setChatOpen((v) => !v)}
                  className={`btn-ghost h-9 w-9 px-0 pressable xl:hidden ${chatOpen ? 'text-accent bg-accent-soft' : ''}`}
                  aria-label="Assistant"
                >
                  <Icon.Sparkle size={17} />
                </button>
                <button
                  onClick={toggleAssistant}
                  className={`btn-ghost h-9 w-9 px-0 pressable hidden xl:inline-flex ${assistantOpen ? 'text-accent bg-accent-soft' : ''}`}
                  aria-label={assistantOpen ? 'Hide the assistant' : 'Show the assistant'}
                  title={assistantOpen ? 'Hide the assistant' : 'Show the assistant'}
                  aria-pressed={assistantOpen}
                >
                  <Icon.Sparkle size={17} />
                </button>
              </>
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
                  {groupable.length > 0 && (
                    <GroupPicker
                      columns={groupable.map((c) => ({ id: c.id, name: c.name }))}
                      value={groupBy}
                      activeName={grouping ? grouping.name : 'each row'}
                      onChange={chooseGroup}
                    />
                  )}
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
            {assistantOpen && (
              <aside className="hidden xl:flex w-[380px] 2xl:w-[420px] shrink-0 border-l border-line bg-surface flex-col overflow-hidden no-print animate-slide-l">
                <ChatPanel
                  scope={{ fileId, folderId }}
                  onApplied={onAssistantWrite}
                  onClose={toggleAssistant}
                  compact
                  suggestions={[
                    'Add 450 for a cab, paid by UPI',
                    'What did I spend the most on here?',
                    'Find anything entered twice',
                  ]}
                />
              </aside>
            )}

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
