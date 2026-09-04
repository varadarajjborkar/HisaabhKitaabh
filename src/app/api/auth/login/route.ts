import { z } from 'zod'
import { env } from '@/lib/env'
import { loginAsDev, loginWithPassword, setSessionCookie, toSession } from '@/lib/auth'
import { handle, ok, parse } from '@/lib/http/route'
import { rateLimit } from '@/lib/store/locks'

const Body = z.object({ identifier: z.string().min(1), password: z.string().min(1) })

export async function POST(req: Request) {
  try {
    const { identifier, password } = await parse(req, Body)

    // Throttle by identifier, not by IP: shared-NAT users shouldn't lock each other out.
    const gate = await rateLimit(`login:${identifier.toLowerCase()}`, 'auth', 10, 300)
    if (!gate.ok) return handle(new Error('Too many attempts. Wait five minutes and try again.'))

    const user = identifier.includes('@')
      ? await loginWithPassword(identifier, password)
      : await loginAsDev(identifier, password)

    const session = toSession(user)
    await setSessionCookie(session)
    return ok({ user: session, devLogin: user.provider === 'dev' })
  } catch (err) {
    return handle(err)
  }
}

export async function GET() {
  return ok({ google: env.google.enabled, devLogin: env.dev.enabled })
}
