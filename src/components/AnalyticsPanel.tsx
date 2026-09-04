'use client'

import { useCallback, useEffect, useState } from 'react'
import type { FolderMeta } from '@/lib/model/types'
import { get } from '@/lib/client/api'
import { BarChart, DataTable, LineChart, StatTile } from './charts/Charts'
import { Gauge } from './charts/Gauge'
import { compactINR, formatINR } from '@/lib/util/format'
import { Icon } from './ui/Icons'

type Analytics = {
  summary: { total: number; files: number; rows: number; average: number }
  files: Array<{ id: string; name: string; folderId: string; total: number; rows: number }>
  perFile: Array<{ fileId: string; name: string; total: number; rows: number }>
  categories: Array<{ key: string; total: number; count: number }>
  timeline: Array<{ day: string; total: number }>
  topRows: Array<{ title: string; amount: number; file: string }>
  selection: { folderId: string | null; fileIds: string[] }
}

/**
 * The home dashboard.
 *
 * Off unless the user turns it on, and then scoped to the folder and files they
 * pick — an "all your money, always on screen" panel is not something everyone
 * wants on a shared laptop. Every figure is computed server-side; this component
 * only draws.
 */
export function AnalyticsPanel({ folders }: { folders: FolderMeta[] }) {
  const [data, setData] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [showTable, setShowTable] = useState(false)

  const load = useCallback(async (folder: string | null, files: string[]) => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (folder) params.set('folderId', folder)
      for (const f of files) params.append('fileId', f)
      const res = await get<Analytics>(`/api/analytics?${params}`)
      setData(res)
      if (files.length === 0) setSelected(res.selection.fileIds)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(folderId, selected) }, [folderId]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleFile = (id: string) => {
    const next = selected.includes(id) ? selected.filter((f) => f !== id) : [...selected, id]
    setSelected(next)
    void load(folderId, next)
  }

  if (loading && !data) return <AnalyticsSkeleton />
  if (!data) return null

  const hasData = data.summary.rows > 0

  return (
    <div className="space-y-3 animate-rise">
      {/* Filters in one row above the charts. */}
      <div className="card p-3 flex flex-wrap items-center gap-2">
        <select
          value={folderId ?? ''}
          onChange={(e) => { setFolderId(e.target.value || null); setSelected([]) }}
          className="input h-8 w-auto text-[12.5px] pr-8"
          aria-label="Folder"
        >
          <option value="">All folders</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>{f.icon} {f.name}</option>
          ))}
        </select>

        <div className="flex flex-wrap gap-1.5 min-w-0">
          {data.files.slice(0, 12).map((f) => {
            const on = selected.includes(f.id)
            return (
              <button
                key={f.id}
                onClick={() => toggleFile(f.id)}
                className={`chip pressable transition-colors ${on ? 'bg-accent-soft border-accent/40 text-accent' : ''}`}
                aria-pressed={on}
              >
                {on && <Icon.Check size={12} />}
                <span className="truncate max-w-[130px]">{f.name}</span>
              </button>
            )
          })}
          {data.files.length === 0 && <span className="text-[12px] text-faint px-1">No files in this folder yet.</span>}
        </div>
      </div>

      {!hasData ? (
        <div className="card p-10 text-center">
          <Icon.Chart size={24} className="mx-auto text-faint" />
          <p className="text-[13.5px] font-medium mt-3">Nothing to chart yet</p>
          <p className="text-[12.5px] text-muted mt-1.5">Add some rows and this fills in.</p>
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-[minmax(0,300px)_1fr] gap-3">
            <div className="card p-4 flex items-center justify-center">
              <Gauge
                total={data.summary.total}
                slices={data.categories.map((c) => ({ key: c.key, total: c.total }))}
                rowCount={data.summary.rows}
                label="Selected"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 content-start">
              <StatTile label="Total" value={formatINR(data.summary.total, { decimals: false })} hint={`${data.summary.files} file${data.summary.files === 1 ? '' : 's'}`} />
              <StatTile label="Rows" value={String(data.summary.rows)} hint={`avg ${compactINR(data.summary.average)}`} />
              <StatTile
                label="Largest single row"
                value={data.topRows[0] ? compactINR(data.topRows[0].amount) : '—'}
                hint={data.topRows[0]?.title.slice(0, 28)}
              />
              <StatTile
                label="Busiest file"
                value={data.perFile[0] ? compactINR(data.perFile[0].total) : '—'}
                hint={data.perFile[0]?.name.slice(0, 28)}
              />
            </div>
          </div>

          <LineChart data={data.timeline} title="Spend over time" cumulative />

          <div className="grid lg:grid-cols-2 gap-3">
            <BarChart
              data={data.categories}
              title="By category"
              emptyHint="Add a select or text column to see a breakdown."
            />
            <BarChart
              data={data.perFile.map((f) => ({ key: f.name, total: f.total, count: f.rows }))}
              title="By file"
            />
          </div>

          {/* The table view the light palette owes; also the accessible fallback. */}
          <div>
            <button
              onClick={() => setShowTable((v) => !v)}
              className="btn-ghost h-8 text-[12.5px] pressable"
              aria-expanded={showTable}
            >
              <Icon.Down size={14} className={`transition-transform duration-200 ${showTable ? 'rotate-180' : ''}`} />
              {showTable ? 'Hide' : 'Show'} the numbers as a table
            </button>
            {showTable && (
              <div className="mt-2 animate-rise">
                <DataTable
                  columns={['Item', 'Amount', 'Rows']}
                  rows={data.categories.map((c) => ({ Item: c.key, Amount: c.total, Rows: c.count }))}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="skeleton h-14" />
      <div className="grid sm:grid-cols-[minmax(0,300px)_1fr] gap-3">
        <div className="skeleton h-[210px]" />
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-[86px]" />)}
        </div>
      </div>
      <div className="skeleton h-[230px]" />
    </div>
  )
}
