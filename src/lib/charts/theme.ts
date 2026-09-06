import { SERIES_DARK, SERIES_LIGHT } from '@/components/charts/palette'

/**
 * The colours a chart draws with, as literal values.
 *
 * Everything on screen in this app reads its colour from a CSS variable, which
 * is exactly what an exported image cannot do: a PNG is rasterised from an SVG
 * with no stylesheet attached, and `rgb(var(--ink))` there resolves to nothing.
 * So a theme is passed in as hex, and the same object is used for the chart on
 * screen and the file that comes out of it. That is what makes the download
 * match what the user is looking at rather than merely resemble it.
 *
 * The values are the palette from globals.css, converted once.
 */

export type ChartTheme = {
  ink: string
  muted: string
  faint: string
  line: string
  surface: string
  raised: string
  accent: string
  series: readonly string[]
}

export const LIGHT_THEME: ChartTheme = {
  ink: '#1a1c20',
  muted: '#606570',
  faint: '#8f94a0',
  line: '#e2e0db',
  surface: '#ffffff',
  raised: '#f4f3f0',
  accent: '#2260c4',
  series: SERIES_LIGHT,
}

export const DARK_THEME: ChartTheme = {
  ink: '#e8eaee',
  muted: '#9ea4b0',
  faint: '#707682',
  line: '#2f333a',
  surface: '#181a1e',
  raised: '#202328',
  accent: '#6aa2ff',
  series: SERIES_DARK,
}

export function themeFor(dark: boolean): ChartTheme {
  return dark ? DARK_THEME : LIGHT_THEME
}

/*
 * Single quotes around the multi-word family, not double.
 *
 * This string is written into an XML attribute that is itself delimited by
 * double quotes, so a double-quoted "Segoe UI" inside it closes the attribute
 * early and the whole document stops parsing. The browser gives no error for
 * that: an <img> pointed at the result simply never fires load, and the export
 * fails silently. Single quotes are equally valid CSS and cannot collide.
 */
export const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Inter, sans-serif"

/** A colour at reduced alpha, for grid lines and de-emphasised marks. */
export function fade(hex: string, alpha: number): string {
  const n = hex.replace('#', '')
  const v = parseInt(n.length === 3 ? n.split('').map((c) => c + c).join('') : n, 16)
  return `rgba(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255}, ${alpha})`
}

/**
 * Black or white, whichever reads on `hex`.
 *
 * Treemap and heatmap put labels on top of a series colour rather than beside
 * it, so the label's colour depends on the cell's. Relative luminance per
 * WCAG, with the 0.179 threshold that maximises the worse of the two ratios.
 */
export function readableOn(hex: string): string {
  const n = hex.replace('#', '')
  const v = parseInt(n.length === 3 ? n.split('').map((c) => c + c).join('') : n, 16)
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const L = 0.2126 * channel((v >> 16) & 255) + 0.7152 * channel((v >> 8) & 255) + 0.0722 * channel(v & 255)
  return L > 0.179 ? '#000000' : '#ffffff'
}

/** Mix two hex colours, for sequential ramps. */
export function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const n = hex.replace('#', '')
    const v = parseInt(n.length === 3 ? n.split('').map((c) => c + c).join('') : n, 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * Math.max(0, Math.min(1, t)))
  return `#${[c(r1, r2), c(g1, g2), c(b1, b2)].map((n) => n.toString(16).padStart(2, '0')).join('')}`
}
