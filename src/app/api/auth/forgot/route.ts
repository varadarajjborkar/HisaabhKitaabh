import { z } from 'zod'
import { fail, handle, ok, parse } from '@/lib/http/route'
import { MailNotConfiguredError } from '@/lib/mail/send'
import { requestReset } from '@/lib/reset'

const Body = z.object({ email: z.string().min(3).max(200) })

/**
 * Step one of a password reset: send a code, and say nothing about who to.
 *
 * The reply is identical for an address with an account, an address without
 * one, and an address that has asked three times in the last hour. Anything
 * else here turns the form into a way of finding out who has an account.
 *
 * The single exception is a deployment with no email provider at all. That is
 * not a fact about any account, it is a fact about the server, and pretending
 * to have sent something is how a user spends ten minutes refreshing an inbox.
 */
export async function POST(req: Request) {
  try {
    const { email } = await parse(req, Body)
    await requestReset(email)
    return ok({ sent: true })
  } catch (err) {
    if (err instanceof MailNotConfiguredError) {
      return fail('mail_not_configured', err.message, 503)
    }
    // A provider that rejected the message is a server problem, and the user
    // can only be told that it is one. The reason is in the server log.
    if (err instanceof Error && !(err instanceof z.ZodError)) {
      console.error('[reset] send failed:', err.message)
      return fail('mail_failed', 'The code could not be sent just now. Try again in a minute.', 502)
    }
    return handle(err)
  }
}
