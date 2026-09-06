import { z } from 'zod'
import { fail, handle, ok, parse } from '@/lib/http/route'
import { rateCheck, rateNote } from '@/lib/store/locks'
import { ResetError, verifyCode } from '@/lib/reset'

const Body = z.object({ email: z.string().min(3).max(200), code: z.string().min(4).max(10) })

/** Step two: the code for a single-use ticket. */
export async function POST(req: Request) {
  try {
    const { email, code } = await parse(req, Body)

    /*
     * A second limit outside the code's own five attempts, because the code
     * record is per mailbox and is destroyed on the fifth guess: without this,
     * asking for a new code every five guesses would be an unbounded search.
     */
    const key = `reset:${email.trim().toLowerCase()}`
    const gate = await rateCheck(key, 'verify', 12, 3600)
    if (!gate.ok) return fail('throttled', 'Too many attempts. Wait an hour and start again.', 429)

    try {
      const ticket = await verifyCode(email, code)
      return ok({ ticket })
    } catch (err) {
      await rateNote(key, 'verify', 3600)
      throw err
    }
  } catch (err) {
    if (err instanceof ResetError) return fail('bad_code', err.message, 400)
    return handle(err)
  }
}
