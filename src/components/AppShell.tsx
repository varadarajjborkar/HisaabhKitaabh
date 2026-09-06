'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { Session } from '@/lib/model/types'
import { Icon } from './ui/Icons'
import { Calculator, CalculatorButton } from './ui/Calculator'
import { ThemeSwitch, BrightnessSlider } from './ui/ThemeSwitch'
import { StorageDialog } from './StorageDialog'
import { ProfileDialog } from './ProfileDialog'
import { useDismiss } from '@/lib/client/useDismiss'
import { post } from '@/lib/client/api'

type ShellCtx = { session: Session; aiEnabled: boolean; openCalculator: () => void }
const Ctx = createContext<ShellCtx | null>(null)

export function useShell(): ShellCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useShell must be used inside AppShell')
  return ctx
}

/**
 * The frame every signed-in screen sits in.
 *
 * It owns the viewport height rather than letting the document grow: the file
 * editor puts a scrolling sheet next to a scrolling assistant, and if the page
 * itself could also scroll, a flick inside either column would drag the whole
 * layout up and take the header with it. Fixing the frame at `h-dvh` and giving
 * each region its own scroller keeps the toolbar, the totals rail and the
 * assistant composer exactly where the user left them.
 */
export function AppShell({ session, aiEnabled, children }: { session: Session; aiEnabled: boolean; children: React.ReactNode }) {
  const [calcOpen, setCalcOpen] = useState(false)
  const pathname = usePathname()

  // The calculator is a desktop convenience; the file editor hides its launcher
  // because the editor has its own, wired to the focused cell.
  const hideLauncher = pathname.startsWith('/file/')

  return (
    <Ctx.Provider value={{ session, aiEnabled, openCalculator: () => setCalcOpen(true) }}>
      <div className="h-dvh flex flex-col overflow-hidden">{children}</div>
      <Calculator open={calcOpen} onClose={() => setCalcOpen(false)} />
      {!calcOpen && !hideLauncher && <CalculatorButton onClick={() => setCalcOpen(true)} />}
    </Ctx.Provider>
  )
}

/**
 * The top bar.
 *
 * Back is an explicit control rather than a reliance on browser chrome: this is
 * installable to a home screen, where there is no browser back button, and the
 * hierarchy here (home, folder, file) is shallow enough that one button always
 * has an obvious destination.
 */
export function TopBar({
  title,
  subtitle,
  back,
  actions,
  children,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  back?: string | (() => void)
  actions?: React.ReactNode
  children?: React.ReactNode
}) {
  const router = useRouter()

  return (
    <header className="shrink-0 z-30 bg-bg/90 backdrop-blur-md border-b border-line no-print">
      <div className="flex items-center gap-2 sm:gap-2.5 px-3 sm:px-5 h-14">
        {back !== undefined && (
          <button
            onClick={() => (typeof back === 'function' ? back() : router.push(back))}
            className="btn-ghost h-9 w-9 px-0 shrink-0 pressable"
            aria-label="Back"
          >
            <Icon.Back size={18} />
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="text-[14.5px] font-semibold leading-tight truncate">{title}</div>
          {subtitle && <div className="text-[11.5px] text-muted leading-tight truncate mt-0.5">{subtitle}</div>}
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">{actions}</div>
      </div>
      {children}
    </header>
  )
}

/**
 * The signed-in user's picture, or their initial.
 *
 * Fetched from /api/account/avatar rather than read out of the session,
 * because an uploaded avatar is a data URL far too large to travel in a
 * cookie - putting it there produced a cookie the browser silently dropped,
 * which logged the user out. Serving it also means a change appears
 * everywhere at once instead of waiting for the next sign-in.
 *
 * `avatarChanged` is dispatched when the profile screen saves, so every
 * instance on the page re-fetches immediately rather than showing the old
 * face until a reload.
 */
function Avatar({ initial, size }: { initial: string; size: number }) {
  const [version, setVersion] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const onChange = () => { setFailed(false); setVersion((v) => v + 1) }
    window.addEventListener('avatarChanged', onChange)
    return () => window.removeEventListener('avatarChanged', onChange)
  }, [])

  // A 404 means no picture is set, which is the common case and not an error.
  if (failed) return <>{initial}</>

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/api/account/avatar?v=${version}`}
      alt=""
      width={size}
      height={size}
      className="w-full h-full object-cover"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  )
}

export function AccountMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const [storage, setStorage] = useState(false)
  const [profile, setProfile] = useState(false)
  const router = useRouter()
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))

  const initial = (session.name || session.email).trim().charAt(0).toUpperCase()

  const signOut = async () => {
    await post('/api/auth/logout')
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-8 rounded-full bg-accent-soft text-accent grid place-items-center text-[12.5px]
                   font-semibold border border-line pressable overflow-hidden"
        aria-label="Account and settings"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Avatar initial={initial} size={32} />
      </button>

      {open && (
        <div
          className="absolute right-0 top-10 z-50 w-[264px] card shadow-pop py-1.5 animate-scale-in origin-top-right"
          role="menu"
        >
          <button
            onClick={() => { setOpen(false); setProfile(true) }}
            role="menuitem"
            className="w-full flex items-start gap-2.5 px-3.5 py-2.5 border-b border-line text-left
                       hover:bg-raised transition-colors group"
          >
            {/* The account's own face, not the app's. This row is about who is
                signed in, and the app logo told the user nothing they did not
                already know from looking at the tab. */}
            <span className="h-[30px] w-[30px] rounded-full bg-accent-soft text-accent grid place-items-center
                             text-[12px] font-semibold border border-line overflow-hidden shrink-0">
              <Avatar initial={initial} size={30} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium truncate">{session.name}</p>
              <p className="text-[11.5px] text-muted truncate">{session.email}</p>
            </div>
            <Icon.Chevron size={13} className="text-faint group-hover:text-muted transition-colors mt-1 shrink-0" />
          </button>

          <button
            onClick={() => { setOpen(false); setStorage(true) }}
            role="menuitem"
            className="w-full text-left px-3.5 py-2.5 border-b border-line hover:bg-raised transition-colors group"
          >
            <span className="text-[11px] uppercase tracking-wide text-faint flex items-center gap-1.5">
              Storage
              {session.role === 'admin' && <span className="chip h-5 px-1.5 text-[10px] normal-case tracking-normal">admin</span>}
              <Icon.Chevron size={12} className="ml-auto text-faint group-hover:text-muted transition-colors" />
            </span>
            <span className="text-[12.5px] flex items-center gap-1.5 mt-1">
              {session.backend === 'drive'
                ? <><Icon.Drive size={13} className="text-muted" /> Your Google Drive</>
                : <><Icon.Folder size={13} className="text-muted" /> In this app</>}
            </span>
          </button>

          <div className="px-3.5 py-3 border-b border-line">
            <p className="text-[11px] uppercase tracking-wide text-faint mb-2">Appearance</p>
            <ThemeSwitch />
            <BrightnessSlider />
          </div>

          <button
            onClick={signOut}
            role="menuitem"
            className="w-full text-left px-3.5 py-2.5 text-[13px] hover:bg-raised flex items-center gap-2.5 text-muted hover:text-ink transition-colors"
          >
            <Icon.Logout size={15} />
            Sign out
          </button>
        </div>
      )}

      {/* Outside the menu, so choosing a backend does not unmount the dialog
          the moment the menu closes behind it. */}
      <StorageDialog open={storage} onClose={() => setStorage(false)} />
      <ProfileDialog open={profile} onClose={() => setProfile(false)} />
    </div>
  )
}
