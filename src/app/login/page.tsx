import { redirect } from 'next/navigation'
import { readSession } from '@/lib/auth'
import { env } from '@/lib/env'
import { Logo } from '@/components/ui/Logo'
import { ThemeCycleButton } from '@/components/ui/ThemeSwitch'
import { LoginForm } from './LoginForm'

export const dynamic = 'force-dynamic'

/**
 * The pitch.
 *
 * The first line used to promise "your data, your Drive", which stopped being
 * true when every account got storage of its own and Drive became something you
 * turn on. Promising a Google account to someone who does not want one was the
 * wrong opening move anyway. The Drive half now appears only where the
 * deployment can actually deliver it.
 */
function points(google: boolean): Array<[string, string]> {
  return [
    [
      'Nothing to set up',
      google
        ? 'An email and a password. Keep your files here, or in your own Google Drive.'
        : 'An email and a password. Your files get a home the moment you sign up.',
    ],
    ['The assistant asks first', 'It proposes the change. Nothing is written until you approve it.'],
    ['Built for one thumb', 'The phone layout is the real one, not a shrunken desktop.'],
  ]
}

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
      <section className="hidden lg:flex flex-col items-start justify-center p-12 xl:p-14 auth-bg border-r border-line relative overflow-hidden">
        {/*
         * The wordmark is lifted out of the flow so the pitch can sit on the
         * panel's vertical centre rather than on whatever is left over below a
         * logo. It stays on the left margin the logo starts from: centred down,
         * not centred across.
         */}
        <div className="absolute top-12 left-12 xl:top-14 xl:left-14 flex items-center gap-3">
          <Logo size={34} />
          <span className="text-[16px] font-semibold tracking-tight">HisaabhKitaabh</span>
        </div>

        <div className="max-w-[420px] relative">
          <h1 className="text-[34px] xl:text-[38px] font-semibold leading-[1.1] tracking-tight animate-rise">
            Folders, files, rows.
          </h1>
          <p className="text-[15.5px] text-muted mt-4 leading-relaxed animate-rise" style={{ animationDelay: '60ms' }}>
            An expense ledger that stays out of your way.
          </p>

          <ul className="mt-9 space-y-4">
            {points(env.google.enabled).map(([title, body], i) => (
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
      </section>

      <section className="relative flex items-center justify-center p-6 sm:p-10 bg-bg">
        <ThemeCycleButton className="absolute top-5 right-5 z-10" />
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <Logo size={34} />
            <span className="text-[16px] font-semibold tracking-tight">HisaabhKitaabh</span>
          </div>
          <LoginForm google={env.google.enabled} devLogin={env.dev.enabled} next={params.next} oauthError={params.error} />
        </div>
      </section>
    </main>
  )
}
