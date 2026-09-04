import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { GOOGLE_SCOPES } from '@/lib/drive/client'
import { K, kv } from '@/lib/redis'
import { shortId } from '@/lib/util/ids'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  if (!env.google.enabled) {
    return NextResponse.redirect(new URL('/login?error=google_not_configured', env.appUrl))
  }
  const url = new URL(req.url)
  const next = url.searchParams.get('next') ?? '/home'

  // CSRF: the state value is minted here, stored server-side, and must come back.
  const state = shortId(24)
  await kv().set(K.oauth(state), { next, createdAt: Date.now() }, { ex: 600 })

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.searchParams.set('client_id', env.google.clientId!)
  authUrl.searchParams.set('redirect_uri', `${env.appUrl}/api/auth/callback`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', GOOGLE_SCOPES)
  authUrl.searchParams.set('access_type', 'offline')
  authUrl.searchParams.set('include_granted_scopes', 'true')
  authUrl.searchParams.set('prompt', 'consent') // guarantees a refresh_token
  authUrl.searchParams.set('state', state)

  return NextResponse.redirect(authUrl)
}
