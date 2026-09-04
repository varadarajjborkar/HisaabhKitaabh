import { z } from 'zod'
import { ok, parse, withAuth } from '@/lib/http/route'
import { computeTotals } from '@/lib/crdt/doc'
import { once, rateLimit } from '@/lib/store/locks'

type Params = { params: Promise<{ fileId: string }> }

const CellValue = z.union([z.string(), z.number(), z.null(), z.array(z.any())])

const OpSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string(), type: z.literal('row.insert'), rowId: z.string(), order: z.string(), cells: z.record(CellValue).optional() }),
  z.object({ id: z.string(), type: z.literal('cell.set'), rowId: z.string(), columnId: z.string(), value: CellValue }),
  z.object({ id: z.string(), type: z.literal('row.move'), rowId: z.string(), order: z.string() }),
  z.object({ id: z.string(), type: z.literal('row.delete'), rowId: z.string() }),
  z.object({ id: z.string(), type: z.literal('row.restore'), rowId: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal('column.insert'),
    column: z.object({
      id: z.string(),
      name: z.string().min(1).max(60),
      kind: z.enum(['amount', 'text', 'number', 'date', 'attachment', 'select']),
      options: z.array(z.string()).optional(),
      order: z.string(),
    }),
  }),
  z.object({ id: z.string(), type: z.literal('column.rename'), columnId: z.string(), name: z.string().min(1).max(60) }),
  z.object({ id: z.string(), type: z.literal('column.retype'), columnId: z.string(), kind: z.enum(['amount', 'text', 'number', 'date', 'attachment', 'select']), options: z.array(z.string()).optional() }),
  z.object({ id: z.string(), type: z.literal('column.delete'), columnId: z.string() }),
  z.object({ id: z.string(), type: z.literal('doc.rename'), name: z.string().min(1).max(120) }),
  z.object({
    id: z.string(),
    type: z.literal('doc.duration'),
    duration: z.object({ enabled: z.boolean(), mode: z.enum(['date', 'month']), from: z.string().optional(), to: z.string().optional() }),
  }),
])

const Body = z.object({
  baseRev: z.number().int().nonnegative(),
  ops: z.array(OpSchema).min(1).max(500),
  label: z.string().max(80).optional(),
  /** Set by the client so a retried save can't double-apply. */
  requestId: z.string().min(8).max(64).optional(),
})

export const POST = withAuth(async ({ repo, session }, req: Request, { params }: Params) => {
  const { fileId } = await params
  const body = await parse(req, Body)

  const gate = await rateLimit(session.userId, 'mutate', 300, 60)
  if (!gate.ok) return ok({ throttled: true }, { status: 429 })

  const run = () =>
    repo.mutate(fileId, {
      baseRev: body.baseRev,
      actor: session.userId,
      ops: body.ops as never,
      label: body.label,
    })

  const { result, replayed } = body.requestId
    ? await once(session.userId, `mutate:${fileId}:${body.requestId}`, run, 600)
    : { result: await run(), replayed: false }

  return ok({
    doc: result.doc,
    etag: result.etag,
    totals: computeTotals(result.doc),
    applied: result.applied.length,
    duplicates: result.duplicates,
    superseded: result.superseded,
    rejected: result.rejected,
    replayed,
  })
})
