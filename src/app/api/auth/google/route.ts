import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { DRIVE_SCOPES, SIGNIN_SCOPES } from '@/lib/drive/client'
import { K, kv } from '@/lib/store/kv'
import { shortId } from '@/lib/util/ids'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!env.google.enabled) {
    return NextResponse.redirect(new URL('/login?error=google_not_configured', env.appUrl))
  }
  const url = new URL(req.url)
  const next = url.searchParams.get('next') ?? '/home'

  /*
   * Two different journeys through the same endpoint.
   *
   * Signing in asks for identity and nothing else. Asking for someone's Drive
   * on the sign-in screen means asking before they have any reason to say yes,
   * and most people will never move their files there. The Drive scope is
   * requested separately, from settings, at the moment it is actually wanted.
   */
  const connectDrive = url.searchParams.get('connect') === 'drive'

  // CSRF: the state value is minted here, stored server-side, and must come back.
  const state = shortId(24)
  await kv().set(K.oauth(state), { next, connectDrive, createdAt: Date.now() }, { ex: 600 })

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', env.google.clientId!)
  authUrl.searchParams.set('redirect_uri', `${env.appUrl}/api/auth/callback`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', connectDrive ? DRIVE_SCOPES : SIGNIN_SCOPES)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('include_granted_scopes', 'true')
  // A refresh token only comes back on an explicit consent, and only the Drive
  // half needs one. Making every sign-in re-consent is a worse door to walk
  // through for no gain.
  authUrl.searchParams.set('prompt', connectDrive ? 'consent' : 'select_account')
  authUrl.searchParams.set('state', state)

  return NextResponse.redirect(authUrl)
}
