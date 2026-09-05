'use client'

import { useCallback, useEffect, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_KEY = 'hisaabhkitaabh-theme'

/**
 * The theme preference.
 *
 * Three states, not two: "system" is a real choice and has to survive a reload,
 * so it is stored explicitly rather than inferred from the absence of a value.
 * The stamp on <html> is what CSS reads; "system" removes it so the media query
 * takes over again.
 *
 * The value is read in an effect rather than in the initialiser: localStorage
 * does not exist during the server render, and reading it during the first
 * client render would produce a hydration mismatch. The inline script in the
 * document head has already applied the stamp by then, so nothing flashes.
 */
export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>('system')

  useEffect(() => {
    try {
      const stored = localStorage.getItem(THEME_KEY)
      if (stored === 'light' || stored === 'dark' || stored === 'system') setMode(stored)
    } catch {
      /* private mode, or storage blocked: system is a fine default */
    }
  }, [])

  const apply = useCallback((next: ThemeMode) => {
    setMode(next)
    const root = document.documentElement
    if (next === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', next)

    // Keep the browser chrome in step with the page in standalone mode.
    const dark = next === 'dark' || (next === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      m.setAttribute('content', dark ? '#101114' : '#f9f8f6')
    })

    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* the stamp is already applied; persistence is the only thing lost */
    }
  }, [])

  return [mode, apply]
}
