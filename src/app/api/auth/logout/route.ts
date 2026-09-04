import { clearSessionCookie } from '@/lib/auth'
import { ok } from '@/lib/http/route'

export async function POST() {
  await clearSessionCookie()
  return ok({})
}
