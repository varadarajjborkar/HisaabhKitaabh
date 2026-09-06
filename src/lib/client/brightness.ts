'use client'

/**
 * Dimming the light theme.
 *
 * A white page at full brightness is tiring to read a ledger on, and the
 * system-wide brightness key is a blunt instrument if the rest of the screen
 * is fine. This dims the page's own surfaces instead.
 *
 * It works by rewriting the palette rather than by putting a filter over
 * everything, which was the obvious approach and the wrong one. A CSS filter
 * on the root element makes that element the containing block for every fixed
 * descendant, which breaks the toolbar, the toaster and the calculator; and a
 * dark overlay cannot dim a modal dialog at all, because a dialog opened with
 * showModal() is promoted to the browser's top layer, above any overlay. Both
 * failures disappear if what changes is the colours themselves - a dialog
 * reads the same variables as everything else.
 *
 * Only the surfaces move. Ink, and the accent that has to stay legible on it,
 * are left alone, so dimming the page never costs contrast the way turning
 * down a backlight does.
 */

const SURFACES = ['bg', 'surface', 'raised', 'line', 'accent-soft'] as const

/** The light palette from globals.css, as the numbers to scale from. */
const BASE: Record<(typeof SURFACES)[number], [number, number, number]> = {
  bg: [249, 248, 246],
  surface: [255, 255, 255],
  raised: [244, 243, 240],
  line: [226, 224, 219],
  'accent-soft': [232, 240, 252],
}

export const KEY = 'hisaabhkitaabh-brightness'
/** Below this the page stops being a page. The slider cannot go there. */
export const MIN = 0.62
export const MAX = 1

export function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return MAX
  return Math.min(MAX, Math.max(MIN, value))
}

export function readLevel(): number {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? clampLevel(Number(raw)) : MAX
  } catch {
    return MAX
  }
}

export function storeLevel(level: number): void {
  try { localStorage.setItem(KEY, String(clampLevel(level))) } catch { /* preference only */ }
}

/** Whether the page is rendering light right now, stamp or system. */
export function isLightNow(): boolean {
  const stamped = document.documentElement.getAttribute('data-theme')
  if (stamped === 'light') return true
  if (stamped === 'dark') return false
  return !window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * Paint the level, or take it off.
 *
 * Removing the properties rather than writing the base values back matters:
 * an inline override on the root would otherwise beat the dark theme's own
 * variables and leave a white page behind when the user switches to dark.
 */
export function applyBrightness(level: number, light = isLightNow()): void {
  const root = document.documentElement
  const clamped = clampLevel(level)

  if (!light || clamped >= MAX) {
    for (const token of SURFACES) root.style.removeProperty(`--${token}`)
    return
  }

  for (const token of SURFACES) {
    const [r, g, b] = BASE[token]
    root.style.setProperty(`--${token}`, `${scale(r, clamped)} ${scale(g, clamped)} ${scale(b, clamped)}`)
  }
}

/**
 * A channel at the given level.
 *
 * Straight multiplication would send the near-white surfaces and the light
 * grey lines down together and flatten the difference between them, so the
 * lines that separate cards would vanish first. Scaling toward a warm grey
 * floor instead keeps the steps between surfaces proportionally intact.
 */
function scale(channel: number, level: number): number {
  const floor = 26
  return Math.round(floor + (channel - floor) * level)
}
