import { NextResponse } from 'next/server'
import { ZodError, type ZodSchema } from 'zod'
import { requireSession, UnauthorizedError } from '../auth'
import { ConflictError, NotFoundError, repoFor, type Repo } from '../store/repo'
import { LockTimeoutError } from '../store/locks'
import type { Session } from '../model/types'
import { DriveAuthError } from '../drive/client'

export type Ctx = { session: Session; repo: Repo }

/** Uniform JSON error shape so the client can branch on `code` instead of strings. */
export function fail(code: string, message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, code, message, ...extra }, { status })
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...(data as object) }, init)
}

export function handle(err: unknown) {
  if (err instanceof UnauthorizedError) return fail('unauthorized', 'Please sign in again.', 401)
  if (err instanceof NotFoundError) return fail('not_found', err.message, 404)
  if (err instanceof ConflictError) {
    return fail('conflict', err.message, 409, { conflicts: err.conflicts, current: err.current })
  }
  if (err instanceof LockTimeoutError) return fail('busy', 'That file is busy right now. Try again in a moment.', 423)
  if (err instanceof DriveAuthError) return fail('drive_auth', err.message, 403)
  if (err instanceof ZodError) {
    return fail('invalid', err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 400)
  }
  const message = err instanceof Error ? err.message : 'Something went wrong'
  console.error('[hisaabkitaab]', err)
  return fail('error', message, 500)
}

/** Wrap a route handler with session resolution, a repo, and error mapping. */
export function withAuth<A extends unknown[]>(fn: (ctx: Ctx, ...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      const session = await requireSession()
      const repo = repoFor({ id: session.userId, backend: session.backend })
      return await fn({ session, repo }, ...args)
    } catch (err) {
      return handle(err)
    }
  }
}

export async function parse<T>(req: Request, schema: ZodSchema<T>): Promise<T> {
  const body = await req.json().catch(() => ({}))
  return schema.parse(body)
}
