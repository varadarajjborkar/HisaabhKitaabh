import { fail, ok, withAuth } from '@/lib/http/route'
import { checkAttachment } from '@/lib/util/mime'
import { env } from '@/lib/env'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Upload a file for the chat to read. Stored the same way a row attachment is,
 * so the assistant reads it through the ordinary attachment path rather than
 * having bytes handed to it out of band.
 */
export const POST = withAuth(async ({ repo }, req: Request) => {
  const form = await req.formData()
  const file = form.get('file')
  const folderId = String(form.get('folderId') ?? '')
  if (!(file instanceof File)) return fail('invalid', 'No file was uploaded.', 400)
  if (file.size > env.limits.maxAttachmentBytes) {
    return fail('too_large', `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(env.limits.maxAttachmentBytes / 1024 / 1024)} MB.`, 413)
  }
  const gate = checkAttachment(file.name, file.type)
  if (!gate.ok) return fail('unsupported_type', gate.reason, 415)

  const target = folderId || (await repo.listFolders())[0]?.id
  if (!target) return fail('no_folder', 'Create a folder before attaching files.', 400)

  const ref = await repo.putAttachment(target, {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    bytes: Buffer.from(await file.arrayBuffer()),
  })
  return ok({ attachment: ref }, { status: 201 })
})
