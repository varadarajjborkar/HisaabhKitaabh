'use client'

import { useEffect, useState } from 'react'

/**
 * Whether the page is currently rendering dark.
 *
 * Charts pick their palette in JS, so they need the resolved value - not the
 * preference. Both inputs are watched: the OS media query, and the data-theme
 * stamp the toggle writes, which must win in either direction.
 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const resolve = () => {
      const stamped = document.documentElement.getAttribute('data-theme')
      setDark(stamped === 'dark' || (stamped !== 'light' && media.matches))
    }
    resolve()
    media.addEventListener('change', resolve)
    const observer = new MutationObserver(resolve)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      media.removeEventListener('change', resolve)
      observer.disconnect()
    }
  }, [])

  return dark
}
