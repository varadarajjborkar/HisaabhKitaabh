import { emptyAccountData } from '@/lib/auth'
import { ok, withAuth } from '@/lib/http/route'

export const dynamic = 'force-dynamic'

/**
 * Clear the account out without closing it.
 *
 * Deleting folders one at a time rather than dropping every key filed under the
 * account, because a folder knows what else has to go with it - the file list,
 * the documents, the Drive directory if the account keeps its data there. A
 * blunt purge would leave the Drive side untouched and orphan it.
 */
export const POST = withAuth(async ({ session, repo }) => {
  const folders = await emptyAccountData(session.userId, repo)
  return ok({ folders })
})
