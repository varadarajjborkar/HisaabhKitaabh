import { z } from 'zod'
import { env, isProd } from '@/lib/env'
import { fail, handle, ok, parse, withAuth } from '@/lib/http/route'
import { MailNotConfiguredError, sendMail } from '@/lib/mail/send'
import { rateCheck } from '@/lib/store/locks'

export const dynamic = 'force-dynamic'

const Body = z.object({
  message: z.string().trim().min(4, 'Say a little more than that').max(4000),
  /** Set when the form was opened from the storage notice, so the mail says so. */
  topic: z.enum(['storage', 'general']).default('general'),
})

/*
 * Five an hour. Enough that someone can send a second message because they
 * forgot something, and few enough that a signed-in account cannot be used as
 * a way to mail the owner a thousand times.
 */
const PER_HOUR = 5

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * A message from a user to whoever runs this deployment.
 *
 * It carries the account's own email, which is the entire point: a note saying
 * "I have run out of space" is unactionable without knowing whose space, and
 * asking the sender to type an address they have already given the app is
 * asking them to get it wrong. The address is also set as the reply-to, so
 * answering is a keypress rather than a copy and paste out of the body.
 *
 * Where the message goes is configuration, never a literal in this file. An
 * address compiled into the source is one that cannot be changed without a
 * deploy, and one that is published to everyone who reads the repository.
 */
export const POST = withAuth(async ({ session, repo }, req: Request) => {
  try {
    if (!env.feedback.to) {
      return fail('feedback_not_configured', 'This deployment has nowhere to send feedback. Set FEEDBACK_TO.', 503)
    }
    if (isProd && !env.mail.enabled) {
      return fail('mail_not_configured', 'This deployment cannot send email yet, so the message would go nowhere.', 503)
    }

    const { message, topic } = await parse(req, Body)

    const gate = await rateCheck(session.userId, 'feedback', PER_HOUR, 3600)
    if (!gate.ok) {
      return fail('rate_limited', 'That is a few messages in a short time. Try again in an hour.', 429)
    }

    // Attached rather than asked for: someone writing about a full account
    // should not have to go and read the number off another screen first.
    const info = await repo.storageInfo().catch(() => null)
    const usage =
      info && info.used !== undefined && info.limit
        ? `${mb(info.used)} of ${mb(info.limit)} (${Math.round((info.used / info.limit) * 100)}%)`
        : 'not applicable'

    const facts = [
      `From:    ${session.name || '(no name)'} <${session.email}>`,
      `Account: ${session.userId}`,
      `Storage: ${usage}`,
      `Backend: ${info?.backend ?? 'unknown'}`,
      `App:     ${env.appUrl}`,
    ].join('\n')

    const { via } = await sendMail({
      to: env.feedback.to,
      replyTo: session.email,
      subject: topic === 'storage' ? `Storage request from ${session.email}` : `Feedback from ${session.email}`,
      text: `${message}\n\n---\n${facts}\n`,
      html:
        `<div style="font:14px/1.6 system-ui,sans-serif">` +
        `<p style="white-space:pre-wrap;margin:0 0 18px">${escape(message)}</p>` +
        `<pre style="font:12px/1.6 ui-monospace,monospace;color:#555;border-top:1px solid #ddd;padding-top:12px;margin:0">${escape(facts)}</pre>` +
        `</div>`,
    })
    return ok({ sent: true, via })
  } catch (err) {
    if (err instanceof MailNotConfiguredError) {
      return fail('mail_not_configured', err.message, 503)
    }
    if (err instanceof Error && !(err instanceof z.ZodError)) {
      console.error('[feedback] send failed:', err.message)
      return fail('mail_failed', 'The message could not be sent just now. Try again in a minute.', 502)
    }
    return handle(err)
  }
})
