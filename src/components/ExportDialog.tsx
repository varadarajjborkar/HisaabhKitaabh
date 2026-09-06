'use client'

import { useState } from 'react'
import { Modal } from './ui/Modal'
import { Icon } from './ui/Icons'
import { toast } from './ui/Toast'
import { exportEverything, saveBlob, type ExportFormat } from '@/lib/client/exportAll'

/**
 * Taking everything with you.
 *
 * An app that holds a year of somebody's spending owes them a way out of it
 * that does not involve this app. So the archive is shaped like what they have
 * been looking at - a directory per folder, a spreadsheet per file, named as
 * they named them - and nothing in it needs the app to be readable.
 *
 * The two formats are an honest choice rather than a preference. CSV opens
 * anywhere and will still open in twenty years. XLSX keeps amounts as numbers
 * with a currency format, so a column sums the moment it opens, where a CSV of
 * "₹1,20,450" arrives as text and sums to zero.
 */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('xlsx')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; label: string } | null>(null)

  const run = async () => {
    setBusy(true)
    setProgress(null)
    try {
      const { blob, filename, folders, files } = await exportEverything(format, setProgress)
      saveBlob(blob, filename)
      toast.success(
        'Export ready',
        `${folders} folder${folders === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}, ${size(blob.size)}.`,
      )
      onClose()
    } catch {
      toast.error('Could not build the export', 'Nothing was changed. Try again in a moment.')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Export your data"
      description="A zip file, shaped the way your folders are."
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary pressable" onClick={() => void run()} disabled={busy}>
            {busy ? <Icon.Spinner /> : <Icon.Download size={15} />}
            {busy ? 'Building' : 'Download'}
          </button>
        </>
      }
    >
      <p className="label">Format for each file</p>
      <div className="grid sm:grid-cols-2 gap-2">
        <FormatCard
          on={format === 'xlsx'}
          onClick={() => setFormat('xlsx')}
          title="Spreadsheet"
          ext=".xlsx"
          lines={['Amounts stay numbers, so columns add up', 'Opens in Excel, Numbers, Sheets']}
        />
        <FormatCard
          on={format === 'csv'}
          onClick={() => setFormat('csv')}
          title="Plain CSV"
          ext=".csv"
          lines={['Opens in anything, forever', 'Amounts arrive as text']}
        />
      </div>

      <div className="mt-4 rounded-lg border border-line bg-raised/50 px-3 py-2.5">
        <p className="text-[11.5px] text-muted leading-relaxed font-mono whitespace-pre">
{`Goa trip/
  Flights${format === 'xlsx' ? '.xlsx' : '.csv'}
  Hotels${format === 'xlsx' ? '.xlsx' : '.csv'}
Groceries/
  October${format === 'xlsx' ? '.xlsx' : '.csv'}
index.csv`}
        </p>
      </div>

      {busy && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-[11.5px] mb-1.5">
            <span className="text-muted truncate min-w-0">{progress?.label ?? 'Reading your files'}</span>
            <span className="text-faint tnum shrink-0 ml-2">{progress ? `${progress.done}/${progress.total}` : ''}</span>
          </div>
          <div className="h-1.5 rounded-full bg-raised overflow-hidden">
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(pct, 4)}%` }} />
          </div>
        </div>
      )}

      <p className="text-[11.5px] text-faint mt-4 leading-relaxed">
        Built in your browser from files you already have open access to. Nothing
        is uploaded anywhere to make it, and the archive never leaves your
        machine unless you send it somewhere.
      </p>
    </Modal>
  )
}

function FormatCard({
  on, onClick, title, ext, lines,
}: { on: boolean; onClick: () => void; title: string; ext: string; lines: string[] }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`text-left rounded-lg border px-3 py-2.5 transition-colors pressable ${
        on ? 'border-accent/50 bg-accent-soft' : 'border-line bg-surface hover:bg-raised'
      }`}
    >
      <span className="flex items-center gap-1.5">
        <span className={`w-3.5 shrink-0 ${on ? 'text-accent' : 'text-transparent'}`}><Icon.Check size={13} /></span>
        <span className={`text-[13px] font-medium ${on ? 'text-accent' : ''}`}>{title}</span>
        <span className="text-[11px] text-faint font-mono">{ext}</span>
      </span>
      <span className="block mt-1 pl-5 space-y-0.5">
        {lines.map((l) => <span key={l} className="block text-[11.5px] text-muted leading-snug">{l}</span>)}
      </span>
    </button>
  )
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
