import { getUser } from '@/lib/auth'
import { withAuth } from '@/lib/http/route'

export const dynamic = 'force-dynamic'

/**
 * The signed-in user's avatar, as an image.
 *
 * It is served rather than carried. An uploaded avatar is a data URL of up to
 * 24KB, and it used to travel in the session cookie - where it made a cookie
 * the browser silently refused to store, which is indistinguishable from never
 * having signed in. Setting a picture logged you out; removing it let you back
 * in. Identity belongs in the cookie; bytes belong behind a URL.
 *
 * The ETag is the picture itself, so a browser that already has the current
 * one gets a 304 and the extra request costs nothing. No max-age: the whole
 * point is that changing the avatar shows up immediately, everywhere.
 */
export const GET = withAuth(async ({ session }) => {
  const user = await getUser(session.userId)
  const picture = user?.picture

  if (!picture) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })

  // A provider avatar is already a URL; hand the browser the address rather
  // than proxying the bytes through here.
  if (picture.startsWith('https://')) {
    return Response.redirect(picture, 307)
  }

  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(picture)
  if (!match) return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })

  const [, mime, b64] = match
  const bytes = Buffer.from(b64, 'base64')
  const etag = `"${hash(picture)}"`

  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': mime,
      'content-length': String(bytes.length),
      etag,
      'cache-control': 'private, no-cache, must-revalidate',
    },
  })
})

/** FNV-1a over the data URL. Only needs to change when the picture does. */
function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}
