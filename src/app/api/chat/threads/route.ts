import { z } from 'zod'
import { ok, parse, withAuth } from '@/lib/http/route'
import { deleteThread, listThreads, recentMessages, renameThread, allFacts, forgetFact, revokeGrants } from '@/lib/ai/memory'

export const dynamic = 'force-dynamic'

export const GET = withAuth(async ({ session }, req: Request) => {
  const threadId = new URL(req.url).searchParams.get('threadId')
  if (threadId) {
    return ok({ messages: await recentMessages(session.userId, threadId, 60) })
  }
  return ok({ threads: await listThreads(session.userId), facts: await allFacts(session.userId) })
})

const Del = z.object({ threadId: z.string().optional(), factId: z.string().optional() })

export const DELETE = withAuth(async ({ session }, req: Request) => {
  const { threadId, factId } = await parse(req, Del)
  if (threadId) {
    await deleteThread(session.userId, threadId)
    await revokeGrants(session.userId, threadId)
  }
  if (factId) await forgetFact(session.userId, factId)
  return ok({})
})

const Rename = z.object({ threadId: z.string().min(1), title: z.string().max(120) })

/** Rename one conversation. An empty title restores the derived one. */
export const PATCH = withAuth(async ({ session }, req: Request) => {
  const { threadId, title } = await parse(req, Rename)
  const applied = await renameThread(session.userId, threadId, title)
  return ok({ threadId, title: applied })
})
