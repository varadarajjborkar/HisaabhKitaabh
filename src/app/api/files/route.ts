import { z } from 'zod'
import { ok, parse, withAuth } from '@/lib/http/route'
import { computeTotals } from '@/lib/crdt/doc'

const Create = z.object({
  folderId: z.string().min(1),
  name: z.string().min(1).max(120),
  id: z.string().max(40).optional(),
})

const Bulk = z.object({ action: z.literal('delete'), ids: z.array(z.string()).min(1).max(200) })

export const GET = withAuth(async ({ repo }, req: Request) => {
  const folderId = new URL(req.url).searchParams.get('folderId')
  const files = folderId ? await repo.listFiles(folderId) : await repo.listAllFiles()
  return ok({ files })
})

export const POST = withAuth(async ({ repo }, req: Request) => {
  const body = await parse(req, Create)
  const doc = await repo.createFile(body)
  return ok({ doc, totals: computeTotals(doc) }, { status: 201 })
})

/** Bulk delete from the Gmail-style file list. */
export const DELETE = withAuth(async ({ repo }, req: Request) => {
  const { ids } = await parse(req, Bulk)
  const results = await Promise.allSettled(ids.map((id) => repo.deleteFile(id)))
  const failed = results.filter((r) => r.status === 'rejected').length
  return ok({ deleted: ids.length - failed, failed })
})
