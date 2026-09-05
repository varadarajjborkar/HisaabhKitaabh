import { NextResponse } from 'next/server'
import { deploymentProblems, env } from '@/lib/env'
import { backends, kv } from '@/lib/store/kv'
import { ping, sqlEnabled } from '@/lib/db/sql'
import { readSession } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Liveness, and the first thing to look at when a deployment misbehaves.
 *
 * The detail is deliberately split. Anyone can see whether the app is up, since
 * that is what an uptime check needs. What is *wrong* with the configuration -
 * an unset session secret, a missing database - is only shown to an admin or
 * outside production, because a public endpoint that announces "sessions are
 * signed with a default key" is an invitation rather than a diagnostic.
 */
export async function GET() {
  const started = Date.now()

  let store: 'ok' | 'memory' | 'error' = kv().durable ? 'ok' : 'memory'
  try {
    await kv().set('health:ping', Date.now(), { ex: 30 })
    await kv().get('health:ping')
  } catch {
    store = 'error'
  }

  const database = sqlEnabled ? await ping() : null
  const problems = deploymentProblems()
  const blockers = problems.filter((p) => p.severity === 'blocker')

  const session = await readSession().catch(() => null)
  const privileged = session?.role === 'admin' || process.env.NODE_ENV !== 'production'

  return NextResponse.json({
    ok: store !== 'error' && database?.ok !== false && blockers.length === 0,
    store,
    storage: backends().primaryName,
    database: sqlEnabled ? (database?.ok ? 'ok' : 'error') : 'not configured',
    ai: env.ollama.enabled ? 'configured' : 'off',
    google: env.google.enabled ? 'configured' : 'off',
    healthy: problems.length === 0,
    ...(privileged ? { problems, databaseError: database?.error } : {}),
    latencyMs: Date.now() - started,
    at: new Date().toISOString(),
  })
}
