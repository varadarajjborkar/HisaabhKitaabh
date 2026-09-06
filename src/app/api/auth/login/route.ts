import { z } from 'zod'
import { env, isProd } from '@/lib/env'
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
      /*
       * Anything that is not an email used to be assumed to be the developer
       * account, which was true right up until ordinary accounts could have a
       * username. The developer login is one fixed credential, so it answers
       * only to its own name and everything else goes to the real lookup.
       */
      const isDev = env.dev.enabled && identifier.trim().toLowerCase() === env.dev.username.toLowerCase()
      user = isDev ? await loginAsDev(identifier, password) : await loginWithPassword(identifier, password)
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
  // Password reset needs somewhere to send the code. Locally it goes to the
  // server log, which is a real answer, so the option is offered there too.
  return ok({ google: env.google.enabled, devLogin: env.dev.enabled, passwordReset: env.mail.enabled || !isProd })
}
