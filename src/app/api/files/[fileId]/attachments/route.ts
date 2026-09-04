import { ok, fail, withAuth } from '@/lib/http/route'
import { checkAttachment, safeFilename, safeServeType } from '@/lib/util/mime'
import { env } from '@/lib/env'

type Params = { params: Promise<{ fileId: string }> }

export const runtime = 'nodejs'
export const maxDuration = 60

/** Upload one attachment and return a ref. Attaching it to a cell is a separate op. */
export const POST = withAuth(async ({ repo }, req: Request, { params }: Params) => {
  const { fileId } = await params
  const doc = await repo.getDoc(fileId)

  const form = await req.formData()
  const file = form.get('file')
  if (!(file instanceof File)) return fail('invalid', 'No file was uploaded.', 400)
  if (file.size > env.limits.maxAttachmentBytes) {
    return fail('too_large', `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is ${Math.round(env.limits.maxAttachmentBytes / 1024 / 1024)} MB.`, 413)
  }

  const gate = checkAttachment(file.name, file.type)
  if (!gate.ok) return fail('unsupported_type', gate.reason, 415)

  const ref = await repo.putAttachment(doc.folderId, {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    bytes: Buffer.from(await file.arrayBuffer()),
  })
  return ok({ attachment: ref }, { status: 201 })
})

/** Stream an attachment back. `?ref=` carries the encoded AttachmentRef. */
export const GET = withAuth(async ({ repo }, req: Request) => {
  const raw = new URL(req.url).searchParams.get('ref')
  if (!raw) return fail('invalid', 'Missing attachment reference.', 400)
  const ref = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  const { bytes, mime, name } = await repo.getAttachment(ref)
  const served = safeServeType(mime)
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': served.type,
      'content-disposition': `${served.disposition}; filename="${safeFilename(name)}"`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      // Belt and braces: even if something renders, it can do nothing.
      'content-security-policy': "default-src 'none'; sandbox",
    },
  })
})
