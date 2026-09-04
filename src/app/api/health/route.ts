import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { kv } from '@/lib/redis'

export const dynamic = 'force-dynamic'

/** Cheap liveness probe: use it as the Vercel health check and the uptime ping. */
export async function GET() {
  const started = Date.now()
  let redis: 'ok' | 'memory' | 'error' = kv().durable ? 'ok' : 'memory'
  try {
    await kv().set('health:ping', Date.now(), { ex: 30 })
    await kv().get('health:ping')
  } catch {
    redis = 'error'
  }
  return NextResponse.json({
    ok: redis !== 'error',
    redis,
    ai: env.ollama.enabled ? 'configured' : 'off',
    google: env.google.enabled ? 'configured' : 'off',
    latencyMs: Date.now() - started,
    at: new Date().toISOString(),
  })
}
