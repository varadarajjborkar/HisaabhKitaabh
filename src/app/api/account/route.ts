import { z } from 'zod'
import { clearSessionCookie, deleteAccount, getUser, setSessionCookie, toSession, updateProfile } from '@/lib/auth'
import { ok, parse, withAuth } from '@/lib/http/route'

export const dynamic = 'force-dynamic'

const Patch = z.object({
  name: z.string().min(1).max(80).optional(),
  username: z.string().max(24).nullable().optional(),
  phone: z.string().max(34).nullable().optional(),
  picture: z.string().max(30_000).nullable().optional(),
})

/** What the profile screen shows. The password hash is not part of it. */
export const GET = withAuth(async ({ session }) => {
  const user = await getUser(session.userId)
  if (!user) return ok({ profile: null })
  return ok({
    profile: {
      id: user.id,
      email: user.email,
      name: user.name,
      username: user.username ?? '',
      phone: user.phone ?? '',
      picture: user.picture ?? '',
      provider: user.provider,
      createdAt: user.createdAt,
    },
  })
})

/*
 * Saving the profile re-issues the session.
 *
 * The name in the cookie is the name the whole shell renders, so without this
 * a rename showed the old one until the next sign-in. The cookie stays small
 * because the avatar is no longer in it - it is served by
 * /api/account/avatar, after a version that carried it produced a cookie over
 * the browser's 4KB limit, which was silently dropped and looked exactly like
 * being signed out.
 */
export const PATCH = withAuth(async ({ session }, req: Request) => {
  const user = await updateProfile(session.userId, await parse(req, Patch))
  await setSessionCookie(toSession(user))
  return ok({ profile: { name: user.name, username: user.username ?? '', phone: user.phone ?? '', picture: user.picture ?? '' } })
})

/**
 * Leaving.
 *
 * The session cookie is cleared in the same request that removes the account,
 * so the browser is not left holding a token for a user that no longer exists -
 * which would look like a broken app rather than a completed decision.
 */
export const DELETE = withAuth(async ({ session }) => {
  const user = await getUser(session.userId)
  if (user) await deleteAccount(user)
  await clearSessionCookie()
  return ok({ deleted: true })
})
