import { z } from 'zod'
import { registerWithPassword, setSessionCookie, toSession } from '@/lib/auth'
import { handle, ok, parse } from '@/lib/http/route'
import { rateLimit } from '@/lib/store/locks'

const Body = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Use at least 8 characters'),
  name: z.string().max(80).optional(),
})

export async function POST(req: Request) {
  try {
    const body = await parse(req, Body)
    const gate = await rateLimit(`signup:${body.email.toLowerCase()}`, 'auth', 5, 3600)
    if (!gate.ok) return handle(new Error('Too many sign-up attempts for this address.'))

    const user = await registerWithPassword(body)
    const session = toSession(user)
    await setSessionCookie(session)
    return ok({ user: session })
  } catch (err) {
    return handle(err)
  }
}
