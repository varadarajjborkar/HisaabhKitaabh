'use client'

import { createContext, useContext, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { Session } from '@/lib/model/types'
import { Icon } from './ui/Icons'
import { Calculator, CalculatorButton } from './ui/Calculator'
import { post } from '@/lib/client/api'

type ShellCtx = { session: Session; aiEnabled: boolean; openCalculator: () => void }
const Ctx = createContext<ShellCtx | null>(null)

export function useShell(): ShellCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useShell must be used inside AppShell')
  return ctx
}

export function AppShell({ session, aiEnabled, children }: { session: Session; aiEnabled: boolean; children: React.ReactNode }) {
  const [calcOpen, setCalcOpen] = useState(false)
  const pathname = usePathname()

  // The calculator is a desktop convenience; the file editor hides its launcher
  // because the editor has its own, wired to the focused cell.
  const hideLauncher = pathname.startsWith('/file/')

  return (
    <Ctx.Provider value={{ session, aiEnabled, openCalculator: () => setCalcOpen(true) }}>
      <div className="min-h-dvh flex flex-col">{children}</div>
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
 * hierarchy here (home → folder → file) is shallow enough that one button
 * always has an obvious destination.
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
    <header className="sticky top-0 z-30 bg-bg/85 backdrop-blur-md border-b border-line no-print">
      <div className="flex items-center gap-2.5 px-3 sm:px-5 h-14">
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

        <div className="flex items-center gap-1.5 shrink-0">{actions}</div>
      </div>
      {children}
    </header>
  )
}

export function AccountMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const router = useRouter()

  const initial = (session.name || session.email).trim().charAt(0).toUpperCase()

  const signOut = async () => {
    await post('/api/auth/logout')
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="h-8 w-8 rounded-full bg-accent-soft text-accent grid place-items-center text-[12.5px]
                   font-semibold border border-line pressable overflow-hidden"
        aria-label="Account"
        aria-expanded={open}
      >
        {session.picture
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={session.picture} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          : initial}
      </button>

      {open && (
        <>
          <button className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} aria-hidden tabIndex={-1} />
          <div className="absolute right-0 top-10 z-50 w-60 card shadow-pop py-1.5 animate-scale-in origin-top-right">
            <div className="px-3.5 py-2.5 border-b border-line">
              <p className="text-[13px] font-medium truncate">{session.name}</p>
              <p className="text-[11.5px] text-muted truncate">{session.email}</p>
              <p className="text-[11px] text-faint mt-1.5 flex items-center gap-1.5">
                {session.backend === 'drive' ? <><Icon.Drive size={12} /> Stored in your Google Drive</> : 'Stored on the server'}
                {session.role === 'admin' && <span className="chip h-5 px-1.5 text-[10px]">admin</span>}
              </p>
            </div>
            <button onClick={signOut} className="w-full text-left px-3.5 py-2.5 text-[13px] hover:bg-raised flex items-center gap-2.5 text-muted hover:text-ink transition-colors">
              <Icon.Logout size={15} />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}
