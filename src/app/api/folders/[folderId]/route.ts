import { z } from 'zod'
import { ok, parse, withAuth } from '@/lib/http/route'

type Params = { params: Promise<{ folderId: string }> }

const Patch = z.object({
  name: z.string().min(1).max(80).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  icon: z.string().max(4).optional(),
})

export const GET = withAuth(async ({ repo }, _req: Request, { params }: Params) => {
  const { folderId } = await params
  const [folder, files] = await Promise.all([repo.getFolder(folderId), repo.listFiles(folderId)])
  return ok({ folder, files })
})

export const PATCH = withAuth(async ({ repo }, req: Request, { params }: Params) => {
  const { folderId } = await params
  const folder = await repo.updateFolder(folderId, await parse(req, Patch))
  return ok({ folder })
})

export const DELETE = withAuth(async ({ repo }, _req: Request, { params }: Params) => {
  const { folderId } = await params
  await repo.deleteFolder(folderId)
  return ok({})
})
