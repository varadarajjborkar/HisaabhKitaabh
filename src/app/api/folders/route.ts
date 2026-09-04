import { z } from 'zod'
import { ok, parse, withAuth } from '@/lib/http/route'

const Create = z.object({
  name: z.string().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(4).optional(),
  /** Client-minted id makes create idempotent across retries. */
  id: z.string().max(40).optional(),
})

export const GET = withAuth(async ({ repo }) => {
  const folders = await repo.listFolders()
  return ok({ folders })
})

export const POST = withAuth(async ({ repo }, req: Request) => {
  const body = await parse(req, Create)
  const folder = await repo.createFolder(body)
  return ok({ folder }, { status: 201 })
})
