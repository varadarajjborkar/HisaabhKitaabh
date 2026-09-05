'use client'

import { useState } from 'react'
import type { SheetDoc } from '@/lib/model/types'
import type { SheetApi } from '@/lib/client/useSheet'
import { Icon } from '../ui/Icons'
import { Modal } from '../ui/Modal'
import { MailDialog } from './MailDialog'
import { ColumnsModal } from './ColumnMenu'
import { copyToClipboard, downloadCsv, downloadPdf } from '@/lib/client/exports'

/**
 * File actions.
 *
 * Save is explicit even though saving is automatic: people want a button that
 * means "commit it now, I'm about to close this", and pressing it should do
 * something real rather than reassure. It flushes the queue and reports.
 *
 * Two shapes. On a wide screen every action is its own button, because there is
 * room and one click beats two. On a phone the row used to be the same eight
 * buttons scrolling sideways, which meant Mail and Discard lived off the right
 * edge with nothing to suggest they were there, and a stray horizontal swipe on
 * the sheet moved the toolbar instead. The phone gets the two actions that are
 * pressed constantly, the columns manager that the phone had no other route to,
 * and everything else behind one clearly labelled sheet.
 */
export function Toolbar({
  doc,
  sheet,
  onDiscard,
  onCalculator,
}: {
  doc: SheetDoc
  sheet: SheetApi
  onDiscard: () => void
  onCalculator: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [mailOpen, setMailOpen] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await sheet.actions.saveNow()
    } finally {
      setSaving(false)
    }
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await sheet.actions.refresh()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      {/* Phone: four controls, no sideways scroll. */}
      <div className="sm:hidden grid grid-cols-4 gap-1.5 no-print">
        <button onClick={save} disabled={saving} className="btn-outline h-10 text-[12px] gap-1.5 px-2 pressable">
          {saving ? <Icon.Spinner size={15} /> : <Icon.Save size={16} />}
          Save
        </button>
        <button onClick={refresh} className="btn-outline h-10 text-[12px] gap-1.5 px-2 pressable" aria-label="Refresh">
          <Icon.Refresh size={16} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
        <button onClick={() => setColumnsOpen(true)} className="btn-outline h-10 text-[12px] gap-1.5 px-2 pressable">
          <Icon.Columns size={16} />
          Columns
        </button>
        <button onClick={() => setMoreOpen(true)} className="btn-outline h-10 text-[12px] gap-1.5 px-2 pressable">
          <Icon.More size={16} />
          More
        </button>
      </div>

      {/* Desktop: everything visible at once. */}
      <div className="hidden sm:flex items-center gap-1.5 flex-wrap no-print">
        <button onClick={save} disabled={saving} className="btn-outline h-8 text-[12.5px] shrink-0 pressable">
          {saving ? <Icon.Spinner size={14} /> : <Icon.Save size={15} />}
          Save
        </button>

        <button onClick={refresh} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable" title="Reload from the server">
          <Icon.Refresh size={15} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>

        <span className="w-px h-5 bg-line shrink-0 mx-0.5" />

        <button onClick={() => downloadPdf(doc)} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable">
          <Icon.Download size={15} /> PDF
        </button>

        <button onClick={() => downloadCsv(doc)} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable">
          <Icon.Download size={15} /> CSV
        </button>

        <button onClick={() => void copyToClipboard(doc)} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable">
          <Icon.Copy size={15} /> Copy
        </button>

        <button onClick={() => setMailOpen(true)} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable">
          <Icon.Mail size={15} /> Mail
        </button>

        <span className="w-px h-5 bg-line shrink-0 mx-0.5" />

        <button onClick={onCalculator} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable">
          <Icon.Calculator size={15} /> Calculator
        </button>

        <button onClick={onDiscard} className="btn-ghost h-8 text-[12.5px] shrink-0 text-bad pressable ml-auto">
          <Icon.Trash size={15} /> Discard
        </button>
      </div>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="File actions" size="sm">
        <div className="grid grid-cols-2 gap-2">
          <SheetAction icon={<Icon.Mail size={17} />} label="Mail" hint="Pick columns, then draft"
                       onClick={() => { setMoreOpen(false); setMailOpen(true) }} />
          <SheetAction icon={<Icon.Copy size={17} />} label="Copy" hint="Aligned table"
                       onClick={() => { setMoreOpen(false); void copyToClipboard(doc) }} />
          <SheetAction icon={<Icon.Download size={17} />} label="PDF" hint="Print or save"
                       onClick={() => { setMoreOpen(false); downloadPdf(doc) }} />
          <SheetAction icon={<Icon.Download size={17} />} label="CSV" hint="For a spreadsheet"
                       onClick={() => { setMoreOpen(false); downloadCsv(doc) }} />
        </div>
        <button
          onClick={() => { setMoreOpen(false); onDiscard() }}
          className="btn-ghost w-full h-11 mt-3 text-bad justify-start pressable"
        >
          <Icon.Trash size={16} /> Discard this file
        </button>
      </Modal>

      <MailDialog open={mailOpen} onClose={() => setMailOpen(false)} doc={doc} />
      <ColumnsModal open={columnsOpen} onClose={() => setColumnsOpen(false)} sheet={sheet} />
    </>
  )
}

function SheetAction({ icon, label, hint, onClick }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start gap-1 p-3 rounded-lg border border-line bg-surface
                 hover:bg-raised transition-colors text-left pressable"
    >
      <span className="text-muted">{icon}</span>
      <span className="text-[13px] font-medium">{label}</span>
      <span className="text-[11px] text-faint leading-snug">{hint}</span>
    </button>
  )
}
