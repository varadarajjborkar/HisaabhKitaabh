import { z } from 'zod'
import { fail, parse, withAuth } from '@/lib/http/route'
import { sseStream } from '@/lib/http/sse'
import { loadRun, resumeRun } from '@/lib/ai/loop'

export const runtime = 'nodejs'
export const maxDuration = 300

const Body = z.object({
  runId: z.string().min(6),
  actionId: z.string().min(6),
  decision: z.enum(['allow', 'allow_always', 'deny', 'guide']),
  guidance: z.string().max(2000).optional(),
})

/**
 * The user's answer to an approval card. Resumes the paused run.
 *
 * The actionId must match the pending action, so a stale card left open in
 * another tab cannot approve a change the user never saw.
 */
export const POST = withAuth(async ({ session, repo }, req: Request) => {
  const body = await parse(req, Body)

  const state = await loadRun(session.userId, body.runId)
  if (!state) return fail('run_expired', 'That request timed out. Ask again and the assistant will re-plan it.', 410)
  if (!state.pending) return fail('already_answered', 'That has already been answered.', 409)
  if (state.pending.actionId !== body.actionId) {
    return fail('stale_action', 'This approval is out of date. The assistant has moved on.', 409)
  }
  if (body.decision === 'guide' && !body.guidance?.trim()) {
    return fail('invalid', 'Tell the assistant what to do instead.', 400)
  }

  const events = await resumeRun({
    session,
    repo,
    state,
    decision: body.decision,
    guidance: body.guidance,
  })
  return sseStream(events)
})
