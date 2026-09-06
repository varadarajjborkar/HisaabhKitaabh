import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { env, isProd } from './env'
import { K, kv } from './store/kv'
import { withLock } from './store/locks'
import type { Session, StorageBackend, User } from './model/types'
import { hashPassword, verifyPassword } from './util/hash'
import { ulid } from './util/ids'
import { purgeAccount, sqlEnabled } from './db/sql'

const COOKIE = 'hisaabhkitaabh_session'
const MAX_AGE = 60 * 60 * 24 * 30

function secret(): Uint8Array {
  // Refusing to run beats running insecurely. With the published default in
  // place anyone can mint a session cookie for any account, so a production
  // deployment that reaches this has to fail loudly rather than serve traffic.
  if (isProd && env.sessionSecretIsDefault) {
    throw new Error('SESSION_SECRET is not set. Generate one with: openssl rand -base64 32')
  }
  return new TextEncoder().encode(env.sessionSecret.padEnd(32, '.'))
}

export async function issueSession(session: Session): Promise<string> {
  return new SignJWT(session as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .setSubject(session.userId)
    .sign(secret())
}

export async function setSessionCookie(session: Session): Promise<void> {
  const token = await issueSession(session)
  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies()
  jar.delete(COOKIE)
}

export async function readSession(): Promise<Session | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null
  return verifySessionToken(token)
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret())
    return {
      userId: String(payload.userId),
      email: String(payload.email),
      name: String(payload.name),
      role: (payload.role === 'admin' ? 'admin' : 'user') as Session['role'],
      // 'kv' is the old name for app storage; sessions issued before the
      // rename are still valid and mean the same thing.
      backend: (payload.backend === 'drive' ? 'drive' : 'app') as Session['backend'],
      provider: payload.provider as Session['provider'],
    }
  } catch {
    return null
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Not signed in')
    this.name = 'UnauthorizedError'
  }
}

export async function requireSession(): Promise<Session> {
  const session = await readSession()
  if (!session) throw new UnauthorizedError()
  return session
}

// -------------------------------------------------------------------- users

export async function getUser(userId: string): Promise<User | null> {
  return kv().get<User>(K.user(userId))
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const id = await kv().get<string>(K.userByEmail(email))
  return id ? getUser(id) : null
}

export async function getUserByUsername(username: string): Promise<User | null> {
  const id = await kv().get<string>(K.userByUsername(username))
  return id ? getUser(id) : null
}

/** What a handle is allowed to be. Short, unambiguous, and typeable on a phone. */
export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,22}[a-z0-9])$/i

export async function saveUser(user: User): Promise<void> {
  await kv().set(K.user(user.id), user)
  await kv().set(K.userByEmail(user.email), user.id)
  await kv().sadd(K.userIndex, user.id)
}

function baseUser(input: Pick<User, 'id' | 'email' | 'name' | 'provider' | 'backend'> & Partial<User>): User {
  return {
    picture: undefined,
    role: 'user',
    createdAt: Date.now(),
    settings: {
      analyticsEnabled: false,
      analyticsSelection: { folderId: null, fileIds: [] },
      theme: 'system',
    },
    ...input,
  }
}

export async function registerWithPassword(input: { email: string; password: string; name?: string }): Promise<User> {
  const email = input.email.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) throw new Error('That email address does not look right')
  if (input.password.length < 8) throw new Error('Use at least 8 characters for your password')

  // Under the lock, because "check then write" is not a uniqueness constraint:
  // two sign-ups submitted together would both find nothing and both create an
  // account, leaving one email pointing at whichever won the second write.
  return withLock(`signup:${email}`, async () => {
    const existing = await getUserByEmail(email)
    if (existing) throw new Error('An account with this email already exists')

    const user = baseUser({
      id: ulid(),
      email,
      name: input.name?.trim() || email.split('@')[0],
      provider: 'password',
      backend: 'app',
      passwordHash: hashPassword(input.password),
    })
    await saveUser(user)
    return user
  }, { ttlMs: 10_000, waitMs: 8_000 })
}

/**
 * Sign in with either identifier.
 *
 * The form has said "Email or username" since the beginning and only the
 * developer account could actually use the second half of it. An identifier
 * with an @ in it is an email; anything else is looked up as a handle.
 *
 * Both failures give the same message on purpose. "No such username" tells an
 * attacker which half of the guess was right.
 */
export async function loginWithPassword(identifier: string, password: string): Promise<User> {
  const id = identifier.trim().toLowerCase()
  const user = id.includes('@') ? await getUserByEmail(id) : await getUserByUsername(id)
  if (!user) throw new Error('Email or password is incorrect')

  // The developer account holds no hash - it is checked against the
  // environment - so reaching it by a handle it has set for itself has to be
  // checked the same way, or setting one would quietly lock it out.
  const good =
    user.provider === 'dev'
      ? env.dev.enabled && password === env.dev.password
      : Boolean(user.passwordHash) && verifyPassword(password, user.passwordHash!)

  if (!good) throw new Error('Email or password is incorrect')
  return user
}

/**
 * The developer login.
 *
 * A fixed username/password that boots straight into a normal-looking account
 * with the admin role, so behaviour can be exercised without OAuth round-trips.
 * It is gated on DEV_LOGIN_ENABLED and the credentials come from env, so a
 * production deploy can turn it off or change it without a code change - leave
 * the defaults in place only on deployments you don't mind anyone reaching.
 */
export async function loginAsDev(username: string, password: string): Promise<User> {
  if (!env.dev.enabled) throw new Error('Developer login is disabled on this deployment')
  if (username !== env.dev.username || password !== env.dev.password) throw new Error('Email or password is incorrect')

  const id = 'dev_' + env.dev.username
  const existing = await getUser(id)
  if (existing) return existing

  const user = baseUser({
    id,
    email: `${env.dev.username}@hisaabhkitaabh.local`,
    name: env.dev.username,
    provider: 'dev',
    backend: 'app',
    role: 'admin',
  })
  await saveUser(user)
  return user
}

/**
 * Signing in with Google no longer decides where your files live.
 *
 * It used to: a Google account meant a Drive account, which made Drive
 * mandatory for anyone who preferred that sign-in button and left password
 * users on a different code path. New accounts start in app storage like
 * everyone else, and Drive is a switch in settings. Accounts that already keep
 * their files in Drive keep them there.
 */
export async function upsertGoogleUser(profile: { sub: string; email: string; name: string; picture?: string }): Promise<User> {
  const email = profile.email.toLowerCase()
  const existing = await getUserByEmail(email)
  if (existing) {
    const updated: User = { ...existing, name: profile.name || existing.name, picture: profile.picture, provider: 'google' }
    await saveUser(updated)
    return updated
  }
  const user = baseUser({
    id: 'g_' + profile.sub,
    email,
    name: profile.name || email.split('@')[0],
    picture: profile.picture,
    provider: 'google',
    backend: 'app',
  })
  await saveUser(user)
  return user
}

/** Record where an account's files should live from now on. */
export async function setStorageBackend(userId: string, backend: StorageBackend): Promise<User> {
  const user = await getUser(userId)
  if (!user) throw new UnauthorizedError()
  const next: User = { ...user, backend }
  await saveUser(next)
  return next
}

export function toSession(user: User): Session {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    backend: user.backend,
    provider: user.provider,
  }
}

export type ProfilePatch = {
  name?: string
  username?: string | null
  phone?: string | null
  picture?: string | null
}

/** A data URL small enough to live in the user record without being a file store. */
const MAX_PICTURE = 24_000

/**
 * Change the parts of an account a person owns.
 *
 * The handle is the only field with a constraint worth defending, and it is
 * defended by claiming the index row rather than by looking first: two people
 * choosing the same handle at the same moment would both find it free. The
 * claim is atomic, so the second one loses and is told so.
 *
 * The avatar is a data URL, capped, because the alternative is an upload
 * pipeline and a second place for an account's storage to grow. The client
 * scales the image down before it ever gets here; the cap is what stops
 * somebody skipping that step.
 */
export async function updateProfile(userId: string, patch: ProfilePatch): Promise<User> {
  const user = await getUser(userId)
  if (!user) throw new UnauthorizedError()

  const next: User = { ...user }

  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (!name) throw new Error('A name cannot be empty')
    next.name = name.slice(0, 80)
  }

  if (patch.phone !== undefined) {
    const phone = (patch.phone ?? '').trim()
    if (phone && !/^[+\d][\d\s().-]{5,24}$/.test(phone)) throw new Error('That phone number does not look right')
    next.phone = phone || undefined
  }

  if (patch.picture !== undefined) {
    const picture = (patch.picture ?? '').trim()
    if (picture && !/^(https:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(picture)) {
      throw new Error('That is not an image')
    }
    if (picture.length > MAX_PICTURE) throw new Error('That image is too large. Choose a smaller one.')
    next.picture = picture || undefined
  }

  if (patch.username !== undefined) {
    const wanted = (patch.username ?? '').trim().toLowerCase()
    if (wanted && !USERNAME_RE.test(wanted)) {
      throw new Error('Usernames are 3 to 24 characters: letters, numbers, dots, dashes and underscores')
    }
    // The developer account answers to its name before anything else does, so a
    // handle that collides with it would be a handle that cannot sign in.
    if (wanted && env.dev.enabled && wanted === env.dev.username.toLowerCase()) {
      throw new Error('That username is taken')
    }
    if (wanted !== (user.username ?? '')) {
      if (wanted) {
        const claimed = await kv().set(K.userByUsername(wanted), user.id, { nx: true })
        if (!claimed) {
          const holder = await kv().get<string>(K.userByUsername(wanted))
          if (holder !== user.id) throw new Error('That username is taken')
        }
      }
      if (user.username) await kv().del(K.userByUsername(user.username))
      next.username = wanted || undefined
    }
  }

  await saveUser(next)
  return next
}

/**
 * Everything the account holds, gone; the account itself still standing.
 *
 * Separate from deleting the account because they are different intentions:
 * starting over is not leaving. The seeded marker is deliberately left set, so
 * the sample folder does not reappear five seconds after being cleared out and
 * make the whole thing look like it failed.
 */
export async function emptyAccountData(userId: string, repo: { listFolders(): Promise<Array<{ id: string }>>; deleteFolder(id: string): Promise<void> }): Promise<number> {
  const folders = await repo.listFolders()
  for (const f of folders) await repo.deleteFolder(f.id)
  await kv().set(K.seeded(userId), true)
  return folders.length
}

/** Remove the account and everything filed under it, including the indexes. */
export async function deleteAccount(user: User): Promise<void> {
  await kv().srem(K.userIndex, user.id)
  await kv().del(K.userByEmail(user.email))
  if (user.username) await kv().del(K.userByUsername(user.username))
  await kv().del(K.user(user.id))
  await kv().del(K.folders(user.id), K.seeded(user.id), K.docIndex(user.id), K.memory(user.id), K.chatIndex(user.id))
  if (sqlEnabled) await purgeAccount(user.id)
}

export async function updateSettings(userId: string, patch: Partial<User['settings']>): Promise<User> {
  const user = await getUser(userId)
  if (!user) throw new UnauthorizedError()
  const next: User = { ...user, settings: { ...user.settings, ...patch } }
  await saveUser(next)
  return next
}
