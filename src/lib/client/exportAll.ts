'use client'

import type { FolderMeta, SheetDoc } from '@/lib/model/types'
import { get } from './api'
import { toCsv } from '@/lib/util/export'
import { toXlsx } from '@/lib/util/xlsx'
import { makeZip, safeSegment, type ZipEntry } from '@/lib/util/zip'
import { formatMoney } from '@/lib/util/format'
import { computeTotals } from '@/lib/crdt/doc'

/**
 * Everything, in a zip, shaped like the app.
 *
 * A folder becomes a directory and a file becomes a spreadsheet inside it, so
 * what comes out looks like what the user has been looking at rather than a
 * flat dump named by id. That matters more than it sounds: an export nobody
 * can navigate is an export nobody uses, and the whole point of one is to be
 * able to leave.
 *
 * CSV or XLSX is the user's choice because the two are honestly different.
 * CSV opens anywhere and survives forever; XLSX keeps amounts as numbers with
 * a currency format, so a column can be summed the moment it opens. A CSV of
 * "₹1,20,450" arrives as text and sums to zero, which is a nasty surprise to
 * find later.
 */

export type ExportFormat = 'csv' | 'xlsx'

export type ExportProgress = { done: number; total: number; label: string }

export async function exportEverything(
  format: ExportFormat,
  onProgress?: (p: ExportProgress) => void,
): Promise<{ blob: Blob; filename: string; folders: number; files: number }> {
  const [{ folders }, { files }] = await Promise.all([
    get<{ folders: FolderMeta[] }>('/api/folders'),
    get<{ files: Array<{ id: string; name: string; folderId: string }> }>('/api/files'),
  ])

  const byId = new Map(folders.map((f) => [f.id, f]))
  const entries: ZipEntry[] = []
  const index: string[] = ['Folder,File,Rows,Total,Currency']
  // Two files can share a name in one folder; the archive cannot.
  const used = new Set<string>()

  let done = 0
  for (const file of files) {
    onProgress?.({ done, total: files.length, label: file.name })

    const doc = await get<{ doc: SheetDoc }>(`/api/files/${file.id}`)
      .then((r) => r.doc)
      .catch(() => null)
    done++
    if (!doc) continue

    const folderName = safeSegment(byId.get(file.folderId)?.name ?? 'Loose files')
    let base = `${folderName}/${safeSegment(doc.name, doc.id)}`
    if (used.has(base.toLowerCase())) {
      let n = 2
      while (used.has(`${base} (${n})`.toLowerCase())) n++
      base = `${base} (${n})`
    }
    used.add(base.toLowerCase())

    entries.push(
      format === 'xlsx'
        ? { path: `${base}.xlsx`, data: await toXlsx(doc) }
        // The BOM is what makes Excel read a UTF-8 CSV as UTF-8 rather than
        // as the local codepage, which is the difference between ₹ and Ã¢â€š¹.
        : { path: `${base}.csv`, data: `﻿${toCsv(doc)}` },
    )

    const totals = computeTotals(doc)
    index.push(
      [folderName, doc.name, String(totals.count), String(totals.total), doc.currency || 'INR']
        .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
        .join(','),
    )
  }

  // Empty folders would otherwise vanish from the archive, and a folder the
  // user made and has not filled yet is still something they made.
  for (const folder of folders) {
    if (files.some((f) => f.folderId === folder.id)) continue
    entries.push({ path: `${safeSegment(folder.name)}/.keep`, data: '' })
  }

  entries.push({ path: 'index.csv', data: `﻿${index.join('\n')}` })
  entries.push({ path: 'README.txt', data: readme(folders.length, entries.length - 1, format) })

  onProgress?.({ done: files.length, total: files.length, label: 'Packing' })
  const blob = await makeZip(entries)
  const stamp = new Date().toISOString().slice(0, 10)

  return { blob, filename: `hisaabhkitaabh-${stamp}.zip`, folders: folders.length, files: files.length }
}

function readme(folders: number, files: number, format: ExportFormat): string {
  return [
    'HisaabhKitaabh export',
    `Taken ${new Date().toLocaleString()}`,
    '',
    `${folders} folder${folders === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'}.`,
    '',
    'One directory per folder, one spreadsheet per file, named as you named them.',
    format === 'xlsx'
      ? 'Amounts are stored as numbers with a currency format, so a column adds up as soon as it opens.'
      : 'CSV, UTF-8 with a byte order mark so Excel reads the currency symbols correctly.',
    '',
    'index.csv lists every file with its row count and total, if you would rather start there.',
    '',
    'This is your data. Nothing here needs this app to be readable.',
  ].join('\n')
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export { formatMoney }
