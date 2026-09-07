import { ok, withAuth } from '@/lib/http/route'
import { markSeen, noticesFor, seenLevel, unseenAmong } from '@/lib/notices'

export const dynamic = 'force-dynamic'

/**
 * What the bell knows.
 *
 * Both the list and the dot come from one call, because they are one fact and
 * fetching them separately is how a panel ends up open and empty with a dot
 * still lit beside it.
 */
export const GET = withAuth(async ({ session, repo }) => {
  const notices = await noticesFor(repo)
  const seen = await seenLevel(session.userId)
  return ok({ notices, unseen: unseenAmong(notices, seen) })
})

/** Opening the panel is reading it. Nothing is dismissed, only acknowledged. */
export const POST = withAuth(async ({ session, repo }) => {
  const notices = await noticesFor(repo)
  await markSeen(session.userId, notices)
  return ok({ notices, unseen: false })
})
