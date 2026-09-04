import { readSession } from '@/lib/auth'
import { ok } from '@/lib/http/route'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await readSession()
  return ok({
    user: session,
    providers: { google: env.google.enabled, dev: env.dev.enabled },
    ai: env.ollama.enabled,
  })
}
