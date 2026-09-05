import { z } from 'zod'
import { getUser, setSessionCookie, setStorageBackend, toSession } from '@/lib/auth'
import { env } from '@/lib/env'
import { forgetDrive, hasDrive } from '@/lib/drive/client'
import { ok, fail, parse, withAuth } from '@/lib/http/route'
import { moveAccount } from '@/lib/store/migrate'
import { rateLimit } from '@/lib/store/locks'

export const runtime = 'nodejs'
// Copying a year of files and their receipts between two backends is not a
// request that finishes in a second, and half a migration is worse than none.
export const maxDuration = 300

/**
 * Where this account's files live.
 *
 * Storage is a choice, not a consequence of which button someone signed in
 * with. The default is the app's own database, which is what makes the app
 * usable by someone who has no interest in connecting a Google account at all.
 * Drive is available to anyone who would rather own the files outright.
 */

const Body = z.object({ backend: z.enum(['app', 'drive']) })

export const GET = withAuth(async ({ session, repo }) => {
  return ok({
    backend: session.backend,
    driveConnected: await hasDrive(session.userId),
    driveAvailable: env.google.enabled,
    storage: await repo.storageInfo(),
  })
})

export const POST = withAuth(async ({ session }, req: Request) => {
  const { backend } = await parse(req, Body)
  const user = await getUser(session.userId)
  if (!user) return fail('unauthorized', 'Please sign in again.', 401)
  if (user.backend === backend) return ok({ backend, moved: null })

  if (backend === 'drive') {
    if (!env.google.enabled) {
      return fail('drive_unavailable', 'Google Drive is not configured on this deployment.', 400)
    }
    // Sign-in never asked for Drive, so the first switch has to go and get it.
    // Not an error: the client sends the user through consent and comes back.
    if (!(await hasDrive(session.userId))) {
      return ok({ backend: user.backend, needsAuth: true, authUrl: '/api/auth/google?connect=drive&next=/home%3Fstorage%3Ddrive' })
    }
  }

  // Migrations read and rewrite every file in the account. Once in a while is
  // a legitimate thing to want; a loop of them is not.
  const gate = await rateLimit(session.userId, 'storage-switch', 5, 3600)
  if (!gate.ok) return fail('throttled', 'Give the last move a few minutes to settle before switching again.', 429)

  const moved = await moveAccount(session.userId, user.backend, backend)
  const updated = await setStorageBackend(session.userId, backend)

  // The session carries the backend, so it has to be re-issued or the next
  // request keeps reading from where the files no longer are.
  await setSessionCookie(toSession(updated))

  // Leaving Drive means we stop holding a token for it. The files stay in the
  // user's Drive - they own those - we just no longer have any reason to read.
  if (backend === 'app') await forgetDrive(session.userId)

  return ok({ backend, moved })
})
