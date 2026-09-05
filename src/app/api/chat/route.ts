import { z } from 'zod'
import { fail, parse, withAuth } from '@/lib/http/route'
import { sseStream } from '@/lib/http/sse'
import { startRun } from '@/lib/ai/loop'
import { env } from '@/lib/env'
import type { AttachmentRef } from '@/lib/model/types'

export const runtime = 'nodejs'
export const maxDuration = 300

const Body = z.object({
  threadId: z.string().min(4).max(64),
  message: z.string().min(1).max(8000),
  fileId: z.string().nullable().optional(),
  folderId: z.string().nullable().optional(),
  attachments: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        mime: z.string(),
        size: z.number(),
        backend: z.enum(['drive', 'app', 'kv']),
        ref: z.string(),
        uploadedAt: z.number(),
      }),
    )
    .max(6)
    .optional(),
})

export const POST = withAuth(async ({ session, repo }, req: Request) => {
  if (!env.ollama.enabled) {
    return fail('ai_not_configured', 'The assistant is not switched on for this deployment. Add OLLAMA_API_KEY to your environment.', 503)
  }
  const body = await parse(req, Body)

  const events = await startRun({
    session,
    repo,
    threadId: body.threadId,
    fileId: body.fileId ?? null,
    folderId: body.folderId ?? null,
    message: body.message,
    inbox: (body.attachments ?? []) as AttachmentRef[],
  })

  return sseStream(events)
})
