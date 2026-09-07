import { appendFile } from 'node:fs/promises'
import { env, isProd } from '../env'

/**
 * Sending one email.
 *
 * The app needs this for exactly one thing - proving that whoever is resetting
 * a password can read the mailbox the account was opened with - so this is a
 * single function over two HTTP APIs rather than a mail library. Both
 * providers have a free tier several orders of magnitude beyond what a reset
 * flow uses, and both are plain POSTs, which matters: a serverless function
 * cannot hold an SMTP connection open across invocations and several hosts
 * block the port anyway.
 *
 * When nothing is configured the behaviour depends on where it is running, and
 * the difference is deliberate. In development the message goes to the server
 * log, so the whole flow can be exercised without signing up to anything. In
 * production it fails and says why, because a reset code that silently goes
 * nowhere is worse than one that never claimed to have been sent.
 */

/** Where a message goes when there is nowhere to send it. Ignored by git. */
export const DEV_OUTBOX = '.mail-outbox.log'

export type Mail = {
  to: string
  subject: string
  /** Both parts are required. A code-carrying email that renders blank in a plain-text client has failed. */
  text: string
  html: string
  /**
   * Who a reply should go to, when that is not the sender.
   *
   * Forwarded user feedback is the case. The message leaves from the app's own
   * address because that is the only one either provider will send as, but the
   * useful action on reading it is answering the person who wrote it - and
   * having to copy an address out of the body to do that is how a reply does
   * not get sent.
   */
  replyTo?: string
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super('Email is not set up on this deployment, so a code cannot be sent. Set RESEND_API_KEY or BREVO_API_KEY.')
    this.name = 'MailNotConfiguredError'
  }
}

export async function sendMail(mail: Mail): Promise<{ via: string }> {
  const provider = env.mail.provider

  if (!provider) {
    if (isProd) throw new MailNotConfiguredError()
    console.info(
      `\n--- email (no provider configured, printing instead) ---\n` +
        `to:      ${mail.to}\n` +
        `subject: ${mail.subject}\n\n${mail.text}\n` +
        `--- end ---\n`,
    )
    /*
     * A copy on disk as well as in the log, because a reset code scrolling past
     * in a dev server's output is not somewhere a test can read it from, and
     * "where did my code go" is the first question anyone has. One JSON object
     * per line, appended. Development only - the branch above returns first in
     * production - and failure to write is ignored, since a read-only working
     * directory is not a reason for a sign-in flow to stop working.
     */
    await appendFile(DEV_OUTBOX, JSON.stringify({ at: Date.now(), ...mail }) + '\n').catch(() => {})
    return { via: 'outbox' }
  }

  const res = provider === 'resend' ? await viaResend(mail) : await viaBrevo(mail)
  if (!res.ok) {
    // The provider's own words, trimmed. "Failed to send" with no reason is a
    // support conversation; "domain is not verified" is a fix.
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`${provider} refused the message (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  return { via: provider }
}

function viaResend(mail: Mail): Promise<Response> {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.mail.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.replyTo ? { reply_to: [mail.replyTo] } : {}),
    }),
  })
}

function viaBrevo(mail: Mail): Promise<Response> {
  const { name, address } = splitFrom(env.mail.from)
  return fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.mail.brevoKey ?? '', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name, email: address },
      to: [{ email: mail.to }],
      subject: mail.subject,
      textContent: mail.text,
      htmlContent: mail.html,
      ...(mail.replyTo ? { replyTo: { email: mail.replyTo } } : {}),
    }),
  })
}

/** `Name <a@b.c>` into its two parts; a bare address is its own name. */
function splitFrom(from: string): { name: string; address: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from)
  return m ? { name: m[1] || m[2], address: m[2] } : { name: from.trim(), address: from.trim() }
}
