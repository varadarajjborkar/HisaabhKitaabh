import { ok, withAuth } from '@/lib/http/route'

type Params = { params: Promise<{ fileId: string }> }

export const GET = withAuth(async ({ repo }, _req: Request, { params }: Params) => {
  const { fileId } = await params
  return ok({ activity: await repo.recentActivity(fileId) })
})
