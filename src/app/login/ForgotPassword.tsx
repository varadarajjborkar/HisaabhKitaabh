'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@/components/ui/Icons'
import { post } from '@/lib/client/api'

/**
 * Getting back in without the password.
 *
 * Three screens, one each for the three things that have to happen: prove the
 * mailbox is yours, then choose a password, then be signed in. Keeping them
 * apart matters more than the click it costs - a single form with an email, a
 * code and a new password on it asks for all three before it can tell you the
 * code was wrong.
 *
 * The wording on the second screen is careful. It says "if that address has an
 * account" rather than "we sent you a code", because the server deliberately
 * does not know how to tell the difference and the screen should not imply it
 * does. Same reason there is no error for an unknown address.
 */

type Step = 'email' | 'code' | 'password'

const RESEND_COOLDOWN_SEC = 30

export function ForgotPassword({ next, onBack }: { next?: string; onBack: () => void }) {
  const router = useRouter()
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [ticket, setTicket] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const codeRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  // The field that matters on this screen takes the caret, so a code can be
  // typed the moment the screen changes without reaching for the mouse.
  useEffect(() => {
    if (step === 'code') codeRef.current?.focus()
    if (step === 'password') passwordRef.current?.focus()
  }, [step])

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/auth/forgot', { email }, { quiet: true })
      setStep('code')
      setCooldown(RESEND_COOLDOWN_SEC)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
    setBusy(false)
  }

  const verify = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await post<{ ticket: string }>('/api/auth/verify-code', { email, code }, { quiet: true })
      setTicket(res.ticket)
      setStep('password')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setCode('')
    }
    setBusy(false)
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/auth/reset', { ticket, password }, { quiet: true })
      router.push(next || '/home')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
      setBusy(false)
    }
  }

  return (
    <div className="animate-rise">
      <button onClick={onBack} className="text-[12.5px] text-muted hover:text-ink transition-colors flex items-center gap-1 -ml-1 mb-5">
        <Icon.Back size={14} />
        Back to sign in
      </button>

      <h2 className="text-[22px] font-semibold tracking-tight">
        {step === 'email' ? 'Reset your password' : step === 'code' ? 'Check your email' : 'Choose a new password'}
      </h2>
      <p className="text-[13.5px] text-muted mt-1.5 leading-relaxed">
        {step === 'email' && 'Type the address you signed up with and we will email you a six-digit code.'}
        {step === 'code' && (
          <>
            If <span className="text-ink">{email}</span> has an account, a code is on its way. It expires in ten minutes.
          </>
        )}
        {step === 'password' && 'Eight characters or more. You will be signed in straight after.'}
      </p>

      {step === 'email' && (
        <form onSubmit={send} className="mt-6">
          <label className="label" htmlFor="reset-email">Email</label>
          <input
            id="reset-email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
            placeholder="you@example.com"
          />
          <Problem error={error} />
          <button type="submit" className="btn-primary w-full h-11 mt-5 pressable" disabled={busy}>
            {busy ? <Icon.Spinner /> : 'Send code'}
          </button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={verify} className="mt-6">
          <label className="label" htmlFor="reset-code">Six-digit code</label>
          {/*
           * inputMode numeric brings up the number pad rather than the full
           * keyboard, and one-time-code lets a phone offer the code straight
           * from the notification. Non-digits are dropped on the way in, so a
           * code pasted with a stray space still works.
           */}
          <input
            id="reset-code"
            ref={codeRef}
            className="input text-center text-[20px] tracking-[.4em] font-medium"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            minLength={6}
            placeholder="000000"
          />
          <Problem error={error} />
          <button type="submit" className="btn-primary w-full h-11 mt-5 pressable" disabled={busy || code.length < 6}>
            {busy ? <Icon.Spinner /> : 'Continue'}
          </button>
          <div className="flex items-center justify-between mt-4 text-[12.5px]">
            <button type="button" onClick={() => { setStep('email'); setError(null); setCode('') }} className="text-muted hover:text-ink transition-colors">
              Use a different address
            </button>
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || cooldown > 0}
              className="text-accent font-medium hover:underline disabled:text-faint disabled:no-underline disabled:cursor-default"
            >
              {cooldown > 0 ? `Send again in ${cooldown}s` : 'Send another'}
            </button>
          </div>
        </form>
      )}

      {step === 'password' && (
        <form onSubmit={save} className="mt-6">
          <label className="label" htmlFor="reset-password">New password</label>
          <div className="relative">
            <input
              id="reset-password"
              ref={passwordRef}
              className="input pr-11"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="At least 8 characters"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 grid place-items-center rounded-md
                         text-faint hover:text-ink hover:bg-raised transition-colors"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              tabIndex={-1}
            >
              {showPassword ? <Icon.EyeOff size={16} /> : <Icon.Eye size={16} />}
            </button>
          </div>
          <Problem error={error} />
          <button type="submit" className="btn-primary w-full h-11 mt-5 pressable" disabled={busy}>
            {busy ? <Icon.Spinner /> : 'Save and sign in'}
          </button>
        </form>
      )}
    </div>
  )
}

function Problem({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p className="text-[12.5px] text-bad mt-3 flex items-start gap-1.5 animate-rise" role="alert">
      <Icon.Warning size={14} className="mt-px shrink-0" />
      <span>{error}</span>
    </p>
  )
}
