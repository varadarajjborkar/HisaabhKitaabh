'use client'

import { useState } from 'react'
import type { SheetDoc } from '@/lib/model/types'
import type { SheetApi } from '@/lib/client/useSheet'
import { Icon } from '../ui/Icons'
import { copyToClipboard, downloadCsv, downloadPdf, openMailDraft } from '@/lib/client/exports'

/**
 * File actions.
 *
 * Save is explicit even though saving is automatic — people want a button that
 * means "commit it now, I'm about to close this", and pressing it should do
 * something real rather than reassure. It flushes the queue and reports.
 *
 * On phones the row scrolls horizontally rather than collapsing into a menu:
 * one tap to reach any action beats two.
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
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 no-print
                    [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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

      <button onClick={() => openMailDraft(doc)} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable">
        <Icon.Mail size={15} /> Mail
      </button>

      <span className="w-px h-5 bg-line shrink-0 mx-0.5" />

      {/* Desktop-only: phones have a calculator already. */}
      <button onClick={onCalculator} className="btn-ghost h-8 text-[12.5px] shrink-0 pressable hidden sm:inline-flex">
        <Icon.Calculator size={15} /> Calculator
      </button>

      <button onClick={onDiscard} className="btn-ghost h-8 text-[12.5px] shrink-0 text-bad pressable ml-auto">
        <Icon.Trash size={15} /> Discard
      </button>
    </div>
  )
}
