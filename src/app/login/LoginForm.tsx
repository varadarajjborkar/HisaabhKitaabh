'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/ui/Icons'
import { post } from '@/lib/client/api'
import { toast } from '@/components/ui/Toast'

const OAUTH_ERRORS: Record<string, string> = {
  google_not_configured: 'Google sign-in is not set up on this deployment.',
  access_denied: 'You cancelled the Google sign-in.',
  expired_state: 'That sign-in link expired. Try again.',
  oauth_failed: 'Google sign-in did not complete. Try again.',
  missing_code: 'Google sign-in did not complete. Try again.',
}

export function LoginForm({
  google,
  devLogin,
  next,
  oauthError,
}: {
  google: boolean
  devLogin: boolean
  next?: string
  oauthError?: string
}) {
  const router = useRouter()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  useEffect(() => {
    if (oauthError) setError(OAUTH_ERRORS[oauthError] ?? 'Sign-in did not complete.')
  }, [oauthError])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signup') {
        await post('/api/auth/signup', { email: identifier, password, name: name || undefined }, { quiet: true })
        toast.success('Account created')
      } else {
        const res = await post<{ devLogin: boolean }>('/api/auth/login', { identifier, password }, { quiet: true })
        if (res.devLogin) toast.info('Signed in as the developer account')
      }
      router.push(next || '/home')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <div className="animate-rise">
      <h2 className="text-[22px] font-semibold tracking-tight">
        {mode === 'signin' ? 'Sign in' : 'Create an account'}
      </h2>
      <p className="text-[13.5px] text-muted mt-1.5">
        {mode === 'signin' ? 'Pick up where you left off.' : 'Takes about ten seconds.'}
      </p>

      {google && (
        <>
          <a
            href={`/api/auth/google${next ? `?next=${encodeURIComponent(next)}` : ''}`}
            className="btn-outline w-full h-11 mt-6 pressable"
          >
            <Icon.Google size={17} />
            Continue with Google
          </a>
          <p className="text-[11.5px] text-faint mt-2 leading-snug">
            Used for signing in only. Your files stay in HisaabKitaab unless you
            choose to keep them in your own Drive later.
          </p>

          <div className="flex items-center gap-3 my-6">
            <span className="h-px flex-1 bg-line" />
            <span className="text-[11.5px] text-faint">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <form onSubmit={submit} className={google ? '' : 'mt-6'}>
        {mode === 'signup' && (
          <div className="mb-3.5 animate-rise">
            <label className="label" htmlFor="name">Name</label>
            <input id="name" className="input" value={name} onChange={(e) => setName(e.target.value)}
                   autoComplete="name" placeholder="Optional" />
          </div>
        )}

        <div className="mb-3.5">
          <label className="label" htmlFor="identifier">
            {mode === 'signin' ? 'Email or username' : 'Email'}
          </label>
          <input
            id="identifier"
            className="input"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            type={mode === 'signup' ? 'email' : 'text'}
            autoComplete={mode === 'signup' ? 'email' : 'username'}
            required
            autoFocus
            placeholder="you@example.com"
          />
        </div>

        <div className="mb-2">
          <label className="label" htmlFor="password">Password</label>
          {/*
           * Reveal is a button inside the field rather than a checkbox beside
           * it: the eye stays put when the label changes between the sign-in
           * and sign-up copy, and it is one tap away from the thumb that is
           * already on the keyboard. Right padding is reserved so a long
           * password scrolls under the button instead of behind it.
           */}
          <div className="relative">
            <input
              id="password"
              className="input pr-11"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPassword ? 'text' : 'password'}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
              minLength={mode === 'signup' ? 8 : 1}
              placeholder={mode === 'signup' ? 'At least 8 characters' : 'Your password'}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 grid place-items-center rounded-md
                         text-faint hover:text-ink hover:bg-raised transition-colors"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              title={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPassword ? <Icon.EyeOff size={16} /> : <Icon.Eye size={16} />}
            </button>
          </div>
        </div>

        {error && (
          <p className="text-[12.5px] text-bad mt-3 flex items-start gap-1.5 animate-rise" role="alert">
            <Icon.Warning size={14} className="mt-px shrink-0" />
            <span>{error}</span>
          </p>
        )}

        <button type="submit" className="btn-primary w-full h-11 mt-5 pressable" disabled={busy}>
          {busy ? <Icon.Spinner /> : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="text-[13px] text-muted mt-5 text-center">
        {mode === 'signin' ? "Don't have an account?" : 'Already have one?'}{' '}
        <button
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setShowPassword(false) }}
          className="text-accent font-medium hover:underline"
        >
          {mode === 'signin' ? 'Sign up' : 'Sign in'}
        </button>
      </p>

      {devLogin && mode === 'signin' && (
        <div className="mt-8 pt-5 border-t border-line">
          <p className="text-[11.5px] text-faint leading-relaxed">
            Developer account is enabled on this deployment. Sign in with the
            username and password from your environment file to get an admin
            session without OAuth.
          </p>
        </div>
      )}
    </div>
  )
}
