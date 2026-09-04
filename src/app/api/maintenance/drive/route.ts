import { ok, fail, withAuth } from '@/lib/http/route'
import { auditDrive } from '@/lib/drive/store'
import { hasDrive } from '@/lib/drive/client'

export const maxDuration = 120

/**
 * Drive consistency sweep — surfaced in the UI as "Check my Drive".
 * Finds objects sharing an identity key and keeps the highest-revision copy,
 * trashing (never hard-deleting) the rest.
 */
export const POST = withAuth(async ({ session, repo }) => {
  if (session.backend !== 'drive' || !(await hasDrive(session.userId))) {
    return fail('no_drive', 'This account does not store data in Google Drive.', 400)
  }
  const report = await auditDrive(session.userId)
  await repo.invalidate()
  return ok({ report })
})
