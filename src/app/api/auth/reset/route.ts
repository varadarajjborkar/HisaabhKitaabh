import { z } from 'zod'
import { setSessionCookie, toSession } from '@/lib/auth'
import { fail, handle, ok, parse } from '@/lib/http/route'
import { ResetError, resetPassword } from '@/lib/reset'

const Body = z.object({ ticket: z.string().min(10).max(200), password: z.string().min(8).max(200) })

/**
 * Step three: the new password, and straight in.
 *
 * Signing them in here rather than returning to the form is the right end to
 * this: they have just proved they can read the mailbox and chosen a password
 * thirty seconds ago, and asking them to type it again immediately is
 * ceremony, not a check.
 */
export async function POST(req: Request) {
  try {
    const { ticket, password } = await parse(req, Body)
    const user = await resetPassword(ticket, password)
    const session = toSession(user)
    await setSessionCookie(session)
    return ok({ user: session })
  } catch (err) {
    if (err instanceof ResetError) return fail('reset_failed', err.message, 400)
    return handle(err)
  }
}
