import { z } from 'zod'
import { clearSessionCookie, deleteAccount, getUser, updateProfile } from '@/lib/auth'
import { ok, parse, withAuth } from '@/lib/http/route'

export const dynamic = 'force-dynamic'

const Patch = z.object({
  name: z.string().min(1).max(80).optional(),
  username: z.string().max(24).nullable().optional(),
  phone: z.string().max(28).nullable().optional(),
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

export const PATCH = withAuth(async ({ session }, req: Request) => {
  const user = await updateProfile(session.userId, await parse(req, Patch))
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
