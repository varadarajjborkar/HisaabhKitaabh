import { ok, withAuth } from '@/lib/http/route'
import { computeTotals, docEtag } from '@/lib/crdt/doc'

type Params = { params: Promise<{ fileId: string }> }

export const GET = withAuth(async ({ repo }, req: Request, { params }: Params) => {
  const { fileId } = await params
  const fresh = new URL(req.url).searchParams.get('fresh') === '1'
  const doc = fresh ? await repo.tryGetDoc(fileId, { fresh: true }) : await repo.getDoc(fileId)
  if (!doc) return ok({ doc: null }, { status: 404 })

  const etag = docEtag(doc)
  // Conditional GET: the poll-for-changes path costs a header round-trip, not a body.
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304 })

  return ok(
    { doc, totals: computeTotals(doc), etag },
    { headers: { etag, 'cache-control': 'private, no-cache' } },
  )
})

export const DELETE = withAuth(async ({ repo }, _req: Request, { params }: Params) => {
  const { fileId } = await params
  await repo.deleteFile(fileId)
  return ok({})
})
