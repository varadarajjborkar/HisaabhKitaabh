import { redirect } from 'next/navigation'
import { readSession } from '@/lib/auth'
import { env } from '@/lib/env'
import { Logo } from '@/components/ui/Logo'
import { ThemeCycleButton } from '@/components/ui/ThemeSwitch'
import { LoginForm } from './LoginForm'

export const dynamic = 'force-dynamic'

const POINTS = [
  ['Your data, your Drive', 'Everything lives in a folder you own.'],
  ['The assistant asks first', 'Nothing is written without your approval.'],
  ['Built for one thumb', 'The phone layout is the real one.'],
]

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const session = await readSession()
  const params = await searchParams
  if (session) redirect(params.next || '/home')

  return (
    <main className="min-h-dvh grid lg:grid-cols-[1fr_min(460px,42vw)]">
      {/*
       * The pitch panel is desktop-only; on a phone the form is the whole job.
       * Its ground is painted rather than left transparent so the two halves
       * read as two surfaces instead of one page with a line down it.
       */}
      <section className="hidden lg:flex flex-col justify-between p-12 xl:p-14 auth-bg border-r border-line relative overflow-hidden">
        <div className="flex items-center gap-3 relative">
          <Logo size={34} />
          <span className="text-[16px] font-semibold tracking-tight">HisaabKitaab</span>
        </div>

        <div className="max-w-[420px] relative">
          <h1 className="text-[34px] xl:text-[38px] font-semibold leading-[1.1] tracking-tight animate-rise">
            Folders, files, rows.
          </h1>
          <p className="text-[15.5px] text-muted mt-4 leading-relaxed animate-rise" style={{ animationDelay: '60ms' }}>
            An expense ledger that stays out of your way.
          </p>

          <ul className="mt-9 space-y-4">
            {POINTS.map(([title, body], i) => (
              <li key={title} className="flex gap-3 animate-rise" style={{ animationDelay: `${120 + i * 70}ms` }}>
                <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                <p className="text-[13.5px] leading-relaxed">
                  <span className="font-medium">{title}.</span>{' '}
                  <span className="text-muted">{body}</span>
                </p>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[12px] text-faint relative">Amounts in rupees, grouped the Indian way.</p>
      </section>

      <section className="relative flex items-center justify-center p-6 sm:p-10 bg-bg">
        <ThemeCycleButton className="absolute top-5 right-5 z-10" />
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <Logo size={34} />
            <span className="text-[16px] font-semibold tracking-tight">HisaabKitaab</span>
          </div>
          <LoginForm google={env.google.enabled} devLogin={env.dev.enabled} next={params.next} oauthError={params.error} />
        </div>
      </section>
    </main>
  )
}
