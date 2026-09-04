'use client'

import { useEffect, useState } from 'react'
import { Icon } from './Icons'

/**
 * Toasts, on a module-level event bus rather than context.
 *
 * The reason is practical: errors surface from fetch helpers and hooks that sit
 * outside the React tree, and threading a provider through all of them buys
 * nothing. `toast.error(...)` works from anywhere.
 */

export type ToastKind = 'info' | 'success' | 'error' | 'warn'
export type ToastItem = { id: number; kind: ToastKind; message: string; detail?: string; action?: { label: string; run: () => void } }

type Listener = (items: ToastItem[]) => void

let items: ToastItem[] = []
const listeners = new Set<Listener>()
let nextId = 1

function emit() {
  for (const l of listeners) l([...items])
}

function push(kind: ToastKind, message: string, detail?: string, action?: ToastItem['action']) {
  const item: ToastItem = { id: nextId++, kind, message, detail, action }
  items = [...items.slice(-3), item]
  emit()
  const ttl = kind === 'error' ? 7000 : 3600
  setTimeout(() => dismiss(item.id), ttl)
  return item.id
}

export function dismiss(id: number) {
  items = items.filter((i) => i.id !== id)
  emit()
}

export const toast = {
  info: (m: string, d?: string) => push('info', m, d),
  success: (m: string, d?: string) => push('success', m, d),
  warn: (m: string, d?: string) => push('warn', m, d),
  error: (m: string, d?: string, action?: ToastItem['action']) => push('error', m, d, action),
}

const TONE: Record<ToastKind, string> = {
  info: 'border-line',
  success: 'border-good/40',
  warn: 'border-warn/45',
  error: 'border-bad/45',
}

const DOT: Record<ToastKind, string> = {
  info: 'bg-faint',
  success: 'bg-good',
  warn: 'bg-warn',
  error: 'bg-bad',
}

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>([])

  useEffect(() => {
    listeners.add(setList)
    return () => { listeners.delete(setList) }
  }, [])

  if (list.length === 0) return null

  return (
    <div
      className="fixed z-[100] bottom-4 left-1/2 -translate-x-1/2 sm:left-auto sm:right-4 sm:translate-x-0
                 flex flex-col gap-2 w-[calc(100vw-2rem)] sm:w-[360px] no-print"
      role="status"
      aria-live="polite"
    >
      {list.map((t) => (
        <div key={t.id} className={`animate-rise card ${TONE[t.kind]} shadow-pop px-3.5 py-3 flex gap-3 items-start`}>
          <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${DOT[t.kind]}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium leading-snug">{t.message}</p>
            {t.detail && <p className="text-[12px] text-muted mt-0.5 leading-snug break-words">{t.detail}</p>}
            {t.action && (
              <button onClick={() => { t.action!.run(); dismiss(t.id) }} className="mt-2 text-[12px] font-medium text-accent hover:underline">
                {t.action.label}
              </button>
            )}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-faint hover:text-ink shrink-0 -mr-1 -mt-0.5 p-1" aria-label="Dismiss">
            <Icon.Close size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
