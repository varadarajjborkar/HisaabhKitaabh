import { redirect } from 'next/navigation'
import { readSession } from '@/lib/auth'
import { env } from '@/lib/env'
import { LoginForm } from './LoginForm'

export const dynamic = 'force-dynamic'

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const session = await readSession()
  const params = await searchParams
  if (session) redirect(params.next || '/home')

  return (
    <main className="min-h-dvh grid lg:grid-cols-[1fr_460px]">
      {/* The pitch panel is desktop-only; on a phone the form is the whole job. */}
      <section className="hidden lg:flex flex-col justify-between p-12 bg-raised border-r border-line">
        <div className="flex items-center gap-2.5">
          <Mark />
          <span className="text-[15px] font-semibold tracking-tight">Khata</span>
        </div>

        <div className="max-w-md animate-rise">
          <h1 className="text-[30px] font-semibold leading-[1.15] tracking-tight">
            Folders, files, rows.
          </h1>
          <p className="text-[15px] text-muted mt-4 leading-relaxed">
            An expense ledger that stays out of your way. Type an amount and a
            title; add your own columns when you need them. Nothing computes
            behind your back.
          </p>
          <ul className="mt-8 space-y-3.5">
            {[
              ['Your data, your Drive', 'Sign in with Google and everything lives in a folder you own. No copy on our side.'],
              ['An assistant that asks first', 'It can add rows and fix mistakes, but every change waits for your approval.'],
              ['Built for one thumb', 'The phone layout is the real one, not a shrunk-down desktop.'],
            ].map(([title, body], i) => (
              <li key={title} className="flex gap-3 animate-rise" style={{ animationDelay: `${80 + i * 60}ms` }}>
                <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                <div>
                  <p className="text-[13.5px] font-medium">{title}</p>
                  <p className="text-[13px] text-muted leading-relaxed mt-0.5">{body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[12px] text-faint">Amounts in ₹. Built for Indian digit grouping.</p>
      </section>

      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-2.5 mb-8">
            <Mark />
            <span className="text-[15px] font-semibold tracking-tight">Khata</span>
          </div>
          <LoginForm google={env.google.enabled} devLogin={env.dev.enabled} next={params.next} oauthError={params.error} />
        </div>
      </section>
    </main>
  )
}

function Mark() {
  return (
    <span className="w-8 h-8 rounded-lg bg-accent text-white grid place-items-center text-[15px] font-semibold shrink-0">
      ₹
    </span>
  )
}
