import { ok, withAuth } from '@/lib/http/route'
import { computeTotals, liveRows, numeric } from '@/lib/crdt/doc'
import { getUser } from '@/lib/auth'
import type { SheetDoc } from '@/lib/model/types'

export const dynamic = 'force-dynamic'

/**
 * Aggregates for the home dashboard.
 *
 * Everything is computed server-side and returned as small arrays: the client
 * ships no aggregation code and no chart library, which keeps the bundle small
 * and the phone cool.
 */
export const GET = withAuth(async ({ session, repo }, req: Request) => {
  const url = new URL(req.url)
  const user = await getUser(session.userId)
  const selection = user?.settings.analyticsSelection ?? { folderId: null, fileIds: [] }

  const folderId = url.searchParams.get('folderId') ?? selection.folderId
  const requested = url.searchParams.getAll('fileId')
  const fileIds = requested.length ? requested : selection.fileIds

  const [folders, allFiles] = await Promise.all([repo.listFolders(), repo.listAllFiles()])
  const scoped = folderId ? allFiles.filter((f) => f.folderId === folderId) : allFiles
  const chosen = fileIds.length ? scoped.filter((f) => fileIds.includes(f.id)) : scoped.slice(0, 8)

  const docs = (await Promise.all(chosen.map((f) => repo.tryGetDoc(f.id)))).filter((d): d is SheetDoc => Boolean(d))

  const perFile = docs.map((doc) => {
    const totals = computeTotals(doc)
    return { fileId: doc.id, name: doc.name, folderId: doc.folderId, total: totals.total, rows: totals.count, average: totals.mean, updatedAt: doc.updatedAt }
  })

  const grand = perFile.reduce((s, f) => s + f.total, 0)

  // Category-style breakdown: the first select column across the chosen files,
  // falling back to any text column that behaves like a category.
  const categories = new Map<string, { total: number; count: number }>()
  for (const doc of docs) {
    const amountCol = doc.columns.find((c) => c.kind === 'amount')
    const catCol =
      doc.columns.find((c) => c.kind === 'select') ??
      doc.columns.find((c) => !c.system && c.kind === 'text')
    if (!amountCol || !catCol) continue
    for (const r of liveRows(doc)) {
      const raw = r.cells[catCol.id]
      const key = raw == null || raw === '' ? 'Uncategorised' : Array.isArray(raw) ? 'Attachment' : String(raw).slice(0, 40)
      const e = categories.get(key) ?? { total: 0, count: 0 }
      e.total += numeric(r.cells[amountCol.id])
      e.count++
      categories.set(key, e)
    }
  }

  // Spend over time, bucketed by the day a row was last touched. Without a
  // per-row date column that is the honest signal we have.
  const timeline = new Map<string, number>()
  for (const doc of docs) {
    const amountCol = doc.columns.find((c) => c.kind === 'amount')
    const dateCol = doc.columns.find((c) => c.kind === 'date')
    if (!amountCol) continue
    for (const r of liveRows(doc)) {
      const explicit = dateCol ? String(r.cells[dateCol.id] ?? '') : ''
      const day = /^\d{4}-\d{2}-\d{2}/.test(explicit) ? explicit.slice(0, 10) : new Date(r.createdAt).toISOString().slice(0, 10)
      timeline.set(day, (timeline.get(day) ?? 0) + numeric(r.cells[amountCol.id]))
    }
  }

  const topRows: Array<{ title: string; amount: number; file: string }> = []
  for (const doc of docs) {
    const amountCol = doc.columns.find((c) => c.kind === 'amount')
    const titleCol = doc.columns.find((c) => c.kind === 'text' && c.system)
    if (!amountCol) continue
    for (const r of liveRows(doc)) {
      topRows.push({
        title: String(r.cells[titleCol?.id ?? ''] ?? '(untitled)'),
        amount: numeric(r.cells[amountCol.id]),
        file: doc.name,
      })
    }
  }
  topRows.sort((a, b) => b.amount - a.amount)

  return ok({
    enabled: user?.settings.analyticsEnabled ?? false,
    selection: { folderId, fileIds: chosen.map((f) => f.id) },
    folders: folders.map((f) => ({ id: f.id, name: f.name, files: f.fileCount })),
    files: scoped.map((f) => ({ id: f.id, name: f.name, folderId: f.folderId, total: f.total, rows: f.rowCount })),
    summary: {
      total: Math.round(grand * 100) / 100,
      files: perFile.length,
      rows: perFile.reduce((s, f) => s + f.rows, 0),
      average: perFile.length ? Math.round((grand / Math.max(1, perFile.reduce((s, f) => s + f.rows, 0))) * 100) / 100 : 0,
    },
    perFile: perFile.sort((a, b) => b.total - a.total),
    categories: [...categories.entries()]
      .map(([key, v]) => ({ key, total: Math.round(v.total * 100) / 100, count: v.count }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 12),
    timeline: [...timeline.entries()]
      .map(([day, total]) => ({ day, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-60),
    topRows: topRows.slice(0, 10),
  })
})
