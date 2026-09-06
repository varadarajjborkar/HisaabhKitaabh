'use client'

import { useEffect, useState } from 'react'
import { patch } from './api'
import { DEFAULT_DATE_FORMAT, isDateFormat, type DateFormat } from '@/lib/util/dateFormat'

const KEY = 'hisaabhkitaabh-date-format'
const EVENT = 'dateFormatChanged'

/**
 * How this account writes dates.
 *
 * Kept in two places on purpose. The copy in localStorage is what renders, so
 * a date is never written in the wrong format for a moment and then corrected;
 * the copy on the account is what makes the choice follow the user to another
 * browser. The server is the authority when they disagree, which only happens
 * on the first load in a new place.
 */
export function useDateFormat(): DateFormat {
  const [format, setFormat] = useState<DateFormat>(DEFAULT_DATE_FORMAT)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY)
      if (isDateFormat(stored)) setFormat(stored)
    } catch { /* the default is a fine starting point */ }

    const onChange = (e: Event) => {
      const next = (e as CustomEvent<string>).detail
      if (isDateFormat(next)) setFormat(next)
    }
    window.addEventListener(EVENT, onChange)
    return () => window.removeEventListener(EVENT, onChange)
  }, [])

  return format
}

/** Adopt a format everywhere on the page, and remember it for next time. */
export function setDateFormat(next: DateFormat): void {
  try { localStorage.setItem(KEY, next) } catch { /* preference only */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }))
  void patch('/api/settings', { dateFormat: next }).catch(() => { /* the local copy still holds */ })
}

/** Take the account's stored choice, for a browser that has not seen it. */
export function adoptStoredFormat(stored: unknown): void {
  if (!isDateFormat(stored)) return
  let current: string | null = null
  try { current = localStorage.getItem(KEY) } catch { /* nothing stored here yet */ }
  if (current === stored) return
  try { localStorage.setItem(KEY, stored) } catch { /* preference only */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: stored }))
}
