import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { exchangeCode, saveTokens } from '@/lib/drive/client'
import { setSessionCookie, toSession, upsertGoogleUser } from '@/lib/auth'
import { K, kv } from '@/lib/store/kv'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, env.appUrl))
  if (!code || !state) return NextResponse.redirect(new URL('/login?error=missing_code', env.appUrl))

  const stored = await kv().get<{ next: string }>(K.oauth(state))
  if (!stored) return NextResponse.redirect(new URL('/login?error=expired_state', env.appUrl))
  await kv().del(K.oauth(state))

  try {
    const { tokens, profile } = await exchangeCode(code, `${env.appUrl}/api/auth/callback`)
    const user = await upsertGoogleUser(profile)
    await saveTokens(user.id, tokens)
    await setSessionCookie(toSession(user))
    return NextResponse.redirect(new URL(stored.next || '/home', env.appUrl))
  } catch (err) {
    console.error('[hisaabhkitaabh] google callback', err)
    return NextResponse.redirect(new URL('/login?error=oauth_failed', env.appUrl))
  }
}
