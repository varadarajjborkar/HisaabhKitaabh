import { z } from 'zod'
import { getUser, updateSettings } from '@/lib/auth'
import { ok, parse, withAuth } from '@/lib/http/route'

const Patch = z.object({
  analyticsEnabled: z.boolean().optional(),
  analyticsSelection: z.object({ folderId: z.string().nullable(), fileIds: z.array(z.string()).max(50) }).optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  dateFormat: z.string().max(24).optional(),
})

export const GET = withAuth(async ({ session, repo }) => {
  const user = await getUser(session.userId)
  return ok({ settings: user?.settings, storage: await repo.storageInfo() })
})

export const PATCH = withAuth(async ({ session }, req: Request) => {
  const user = await updateSettings(session.userId, await parse(req, Patch))
  return ok({ settings: user.settings })
})
