import { z } from 'zod'
import { env } from '@/lib/env'
import { loginAsDev, loginWithPassword, setSessionCookie, toSession } from '@/lib/auth'
import { fail, handle, ok, parse } from '@/lib/http/route'
import { rateCheck, rateNote } from '@/lib/store/locks'

const Body = z.object({ identifier: z.string().min(1), password: z.string().min(1) })

export async function POST(req: Request) {
  try {
    const { identifier, password } = await parse(req, Body)

    // Throttled by identifier, not by IP - users behind one NAT shouldn't be
    // able to lock each other out. Only failures count, so signing in
    // repeatedly from several devices is never itself a reason to be blocked.
    const key = `login:${identifier.toLowerCase()}`
    const gate = await rateCheck(key, 'auth', 10, 300)
    if (!gate.ok) return fail('throttled', 'Too many failed attempts. Wait five minutes and try again.', 429)

    let user
    try {
      user = identifier.includes('@')
        ? await loginWithPassword(identifier, password)
        : await loginAsDev(identifier, password)
    } catch (err) {
      await rateNote(key, 'auth', 300)
      throw err
    }

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
