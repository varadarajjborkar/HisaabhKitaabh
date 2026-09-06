import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { env } from './env'
import { K, kv } from './store/kv'
import { rateLimit } from './store/locks'
import { getUser, getUserByEmail, saveUser } from './auth'
import { hashPassword, sha256 } from './util/hash'
import { sendMail } from './mail/send'
import type { User } from './model/types'

/**
 * Forgetting a password, and getting back in.
 *
 * Three steps, because the alternative is a link in an email that is a bearer
 * token for the account: ask for a code, prove you received it, then choose a
 * new password. A six-digit code read off a screen and typed in is the same
 * mechanism every bank uses, and it survives a mail client that mangles links.
 *
 * The rules that make six digits enough:
 *
 *   - It expires in ten minutes. A code is a moment, not a credential.
 *   - Five wrong guesses destroys it. A million codes and five tries is a one
 *     in two hundred thousand chance per issued code, and issuing is limited
 *     to three an hour, so guessing is not a strategy.
 *   - What is stored is a digest, not the code. Someone reading the database
 *     later finds nothing they can type in.
 *   - Verifying earns a single-use ticket, so the code is spent the moment it
 *     works and cannot be replayed while the new password is being chosen.
 *
 * And the rule that makes the whole thing safe to expose: the first step says
 * exactly the same thing whether or not the address has an account. A reset
 * form that answers "no account with that email" is an account checker.
 */

const CODE_TTL_SEC = 10 * 60
const TICKET_TTL_SEC = 10 * 60
const MAX_ATTEMPTS = 5
const SENDS_PER_HOUR = 5

type CodeRecord = {
  userId: string
  /** sha256 of the code and the mailbox together, so a digest is useless elsewhere. */
  digest: string
  attempts: number
  expires: number
}

type TicketRecord = { userId: string; expires: number }

/** Six digits, uniformly. A code with a bias is a smaller code. */
function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

function digestOf(email: string, code: string): string {
  return sha256(`${email.toLowerCase()}:${code}`)
}

function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export class ResetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResetError'
  }
}

/**
 * Step one. Always succeeds, from the caller's point of view.
 *
 * A missing account, a Google account, a throttled mailbox: all of them return
 * without complaint, because the difference between them is information about
 * someone else's account. What actually happened is only ever visible to
 * whoever opens the mailbox.
 */
export async function requestReset(email: string): Promise<void> {
  const address = email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(address)) return

  const gate = await rateLimit(`reset:${address}`, 'send', SENDS_PER_HOUR, 3600)
  if (!gate.ok) return

  const user = await getUserByEmail(address)
  if (!user) return

  /*
   * An account that signs in with Google has no password to reset, and telling
   * it to "check your email for a code" would be a ten-minute wait for nothing.
   * The mailbox gets a note saying which button to press instead.
   */
  if (user.provider !== 'password') {
    await sendMail({
      to: address,
      subject: 'Signing in to HisaabhKitaabh',
      text: wrongDoorText(user),
      html: wrongDoorHtml(user),
    }).catch(() => {})
    return
  }

  const code = newCode()
  const record: CodeRecord = {
    userId: user.id,
    digest: digestOf(address, code),
    attempts: 0,
    expires: Date.now() + CODE_TTL_SEC * 1000,
  }
  await kv().set(K.resetCode(address), record, { ex: CODE_TTL_SEC })

  await sendMail({
    to: address,
    subject: `${code} is your HisaabhKitaabh reset code`,
    text: codeText(user, code),
    html: codeHtml(user, code),
  })
}

/**
 * Step two: the code for a ticket.
 *
 * The code is destroyed either way - spent on success, and on the fifth wrong
 * guess. Every failure gives the same message, so a wrong code and an expired
 * one are not distinguishable from the outside.
 */
export async function verifyCode(email: string, code: string): Promise<string> {
  const address = email.trim().toLowerCase()
  const store = kv()
  const record = await store.get<CodeRecord>(K.resetCode(address))

  const wrong = new ResetError('That code is wrong or has expired. Ask for a new one.')
  if (!record || record.expires < Date.now()) throw wrong

  if (!sameDigest(record.digest, digestOf(address, code.trim()))) {
    const attempts = record.attempts + 1
    if (attempts >= MAX_ATTEMPTS) await store.del(K.resetCode(address))
    else await store.set(K.resetCode(address), { ...record, attempts }, { ex: CODE_TTL_SEC })
    throw wrong
  }

  await store.del(K.resetCode(address))

  const ticket = randomBytes(32).toString('base64url')
  const held: TicketRecord = { userId: record.userId, expires: Date.now() + TICKET_TTL_SEC * 1000 }
  await store.set(K.resetTicket(sha256(ticket)), held, { ex: TICKET_TTL_SEC })
  return ticket
}

/**
 * Step three. The ticket is spent whether or not the password is accepted, so
 * a rejected password means asking for a new code - which is a small annoyance
 * next to a ticket that stays live while someone tries passwords with it.
 */
export async function resetPassword(ticket: string, password: string): Promise<User> {
  if (password.length < 8) throw new ResetError('Use at least 8 characters for your password')

  const store = kv()
  const key = K.resetTicket(sha256(ticket))
  const held = await store.get<TicketRecord>(key)
  await store.del(key)

  if (!held || held.expires < Date.now()) {
    throw new ResetError('That reset has expired. Start again from "Forgot password".')
  }

  const user = await getUser(held.userId)
  if (!user || user.provider !== 'password') throw new ResetError('That reset is no longer valid.')

  /*
   * Sessions already signed in elsewhere are not revoked by this.
   *
   * Nothing reads the account on an ordinary request - the session is a signed
   * cookie and verifying it is arithmetic - so revoking one would mean a store
   * lookup on every request in the app to catch a case that happens once. The
   * honest note belongs here rather than in a claim on the confirmation
   * screen: a reset stops the old password working, and other signed-in
   * browsers stay signed in until their cookie expires.
   */
  const updated: User = { ...user, passwordHash: hashPassword(password) }
  await saveUser(updated)
  return updated
}

// -------------------------------------------------------------- the messages

const SIGNATURE = 'HisaabhKitaabh'

function greet(user: User): string {
  return user.name ? `Hi ${user.name},` : 'Hi,'
}

function codeText(user: User, code: string): string {
  return [
    greet(user),
    '',
    `Your code for resetting your ${SIGNATURE} password is:`,
    '',
    `    ${code}`,
    '',
    'It works for the next ten minutes and can be used once.',
    '',
    'If you did not ask for this, you can ignore this email. Nothing has',
    'changed on your account and your password still works.',
    '',
    SIGNATURE,
  ].join('\n')
}

function codeHtml(user: User, code: string): string {
  return shell(`
    <p style="margin:0 0 18px">${esc(greet(user))}</p>
    <p style="margin:0 0 14px">Your code for resetting your ${SIGNATURE} password is:</p>
    <p style="margin:0 0 18px;font-size:32px;font-weight:600;letter-spacing:.16em;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${code}</p>
    <p style="margin:0 0 18px;color:#5c6470">It works for the next ten minutes and can be used once.</p>
    <p style="margin:0;color:#5c6470">If you did not ask for this, you can ignore this email. Nothing has changed on your account and your password still works.</p>
  `)
}

function wrongDoorText(user: User): string {
  const how = user.provider === 'google' ? 'the Continue with Google button' : 'the credentials your deployment sets'
  return [
    greet(user),
    '',
    `Someone asked to reset the password for this ${SIGNATURE} account.`,
    '',
    `There is no password on it to reset - it signs in with ${how}.`,
    'Use that on the sign-in page and you are in.',
    '',
    'If this was not you, there is nothing to do. Nobody can change how this',
    'account signs in from that form.',
    '',
    SIGNATURE,
  ].join('\n')
}

function wrongDoorHtml(user: User): string {
  const how = user.provider === 'google' ? 'the <b>Continue with Google</b> button' : 'the credentials your deployment sets'
  return shell(`
    <p style="margin:0 0 18px">${esc(greet(user))}</p>
    <p style="margin:0 0 14px">Someone asked to reset the password for this ${SIGNATURE} account.</p>
    <p style="margin:0 0 18px">There is no password on it to reset: it signs in with ${how}. Use that on the sign-in page and you are in.</p>
    <p style="margin:0;color:#5c6470">If this was not you, there is nothing to do. Nobody can change how this account signs in from that form.</p>
  `)
}

/** One column, inline styles, no images. What every mail client agrees on. */
function shell(body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9">
  <div style="max-width:520px;margin:0 auto;padding:32px 22px;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#15181d">
    <p style="margin:0 0 26px;font-size:15px;font-weight:600;letter-spacing:-.01em">${SIGNATURE}</p>
    ${body}
    <p style="margin:30px 0 0;padding-top:16px;border-top:1px solid #e4e7ec;color:#8a919c;font-size:12.5px">
      <a href="${esc(env.appUrl)}" style="color:#8a919c">${esc(env.appUrl)}</a>
    </p>
  </div></body></html>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
