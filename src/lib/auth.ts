import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { env, isProd } from './env'
import { K, kv } from './redis'
import type { Session, User } from './model/types'
import { hashPassword, verifyPassword } from './util/hash'
import { ulid } from './util/ids'

const COOKIE = 'hisaabkitaab_session'
const MAX_AGE = 60 * 60 * 24 * 30

function secret(): Uint8Array {
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
      picture: payload.picture ? String(payload.picture) : undefined,
      role: (payload.role === 'admin' ? 'admin' : 'user') as Session['role'],
      backend: (payload.backend === 'drive' ? 'drive' : 'kv') as Session['backend'],
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
  const existing = await getUserByEmail(email)
  if (existing) throw new Error('An account with this email already exists')

  const user = baseUser({
    id: ulid(),
    email,
    name: input.name?.trim() || email.split('@')[0],
    provider: 'password',
    backend: 'kv',
    passwordHash: hashPassword(input.password),
  })
  await saveUser(user)
  return user
}

export async function loginWithPassword(email: string, password: string): Promise<User> {
  const user = await getUserByEmail(email.trim().toLowerCase())
  if (!user?.passwordHash || !verifyPassword(password, user.passwordHash)) {
    throw new Error('Email or password is incorrect')
  }
  return user
}

/**
 * The developer login.
 *
 * A fixed username/password that boots straight into a normal-looking account
 * with the admin role, so behaviour can be exercised without OAuth round-trips.
 * It is gated on DEV_LOGIN_ENABLED and the credentials come from env, so a
 * production deploy can turn it off or change it without a code change — leave
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
    email: `${env.dev.username}@hisaabkitaab.local`,
    name: env.dev.username,
    provider: 'dev',
    backend: 'kv',
    role: 'admin',
  })
  await saveUser(user)
  return user
}

export async function upsertGoogleUser(profile: { sub: string; email: string; name: string; picture?: string }): Promise<User> {
  const email = profile.email.toLowerCase()
  const existing = await getUserByEmail(email)
  if (existing) {
    const updated: User = { ...existing, name: profile.name || existing.name, picture: profile.picture, provider: 'google', backend: 'drive' }
    await saveUser(updated)
    return updated
  }
  const user = baseUser({
    id: 'g_' + profile.sub,
    email,
    name: profile.name || email.split('@')[0],
    picture: profile.picture,
    provider: 'google',
    backend: 'drive',
  })
  await saveUser(user)
  return user
}

export function toSession(user: User): Session {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
    backend: user.backend,
    provider: user.provider,
  }
}

export async function updateSettings(userId: string, patch: Partial<User['settings']>): Promise<User> {
  const user = await getUser(userId)
  if (!user) throw new UnauthorizedError()
  const next: User = { ...user, settings: { ...user.settings, ...patch } }
  await saveUser(next)
  return next
}
