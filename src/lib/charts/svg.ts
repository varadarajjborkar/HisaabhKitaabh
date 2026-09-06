import type { Mark } from './marks'
import { buildPlot, type PlotOptions } from './plot'
import { FONT, type ChartTheme } from './theme'
import type { ChartSpec } from './spec'

/**
 * Marks to SVG.
 *
 * The only file here that knows what SVG is, and it knows nothing about
 * charts: five shapes, a background, and a string. Which is the point - the
 * chart on screen and the file the user downloads come out of this one
 * function, so they cannot drift apart the way a display renderer and an
 * export renderer always eventually do.
 *
 * The output is self-contained on purpose. No stylesheet, no CSS variables, no
 * external font file, no `<use>` into a sprite: every colour is a literal and
 * every size is a number, because the browser rasterises this through an
 * `<img>` where none of those would resolve.
 */

export type SvgOptions = PlotOptions & {
  /** Paint the surface behind the chart. On for a file, off inside a card. */
  background?: boolean
  /** A title attribute for assistive technology. */
  label?: string
}

export function renderChartSvg(spec: ChartSpec, options: SvgOptions = {}): string {
  const plot = buildPlot(spec, options)
  const body = plot.marks.map((m) => draw(m, plot.theme)).join('')
  const bg = options.background
    ? `<rect width="${plot.width}" height="${plot.height}" fill="${plot.theme.surface}"/>`
    : ''
  const label = esc(options.label ?? spec.title ?? 'Chart')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${plot.width}" height="${plot.height}" ` +
    `viewBox="0 0 ${plot.width} ${plot.height}" role="img" aria-label="${label}" ` +
    `font-family="${esc(FONT)}" text-rendering="optimizeLegibility">` +
    `<title>${label}</title>${bg}${body}</svg>`
  )
}

/** The same chart as a standalone .svg file, with a background painted in. */
export function renderChartFile(spec: ChartSpec, options: SvgOptions = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${renderChartSvg(spec, { background: true, showTitle: true, showNote: true, ...options })}`
}

function draw(mark: Mark, theme: ChartTheme): string {
  switch (mark.m) {
    case 'rect': {
      const rect = `<rect x="${n(mark.x)}" y="${n(mark.y)}" width="${n(Math.max(0, mark.w))}" height="${n(Math.max(0, mark.h))}"${
        mark.rx ? ` rx="${n(mark.rx)}"` : ''
      } fill="${mark.fill}"${mark.stroke ? ` stroke="${mark.stroke}" stroke-width="1"` : ''}${opacity(mark.opacity)}`
      // A shape with a tooltip has to be an element with children, so it closes
      // rather than self-closes. Without one the extra bytes are not spent.
      return mark.title ? `${rect}><title>${esc(mark.title)}</title></rect>` : `${rect}/>`
    }

    case 'path':
      return `<path d="${mark.d}" fill="${mark.fill ?? 'none'}"${
        mark.stroke ? ` stroke="${mark.stroke}" stroke-width="${n(mark.width ?? 1)}"` : ''
      }${mark.join ? ` stroke-linejoin="${mark.join}" stroke-linecap="round"` : ''}${
        mark.dash ? ` stroke-dasharray="${mark.dash}"` : ''
      }${opacity(mark.opacity)}/>`

    case 'circle':
      return `<circle cx="${n(mark.cx)}" cy="${n(mark.cy)}" r="${n(mark.r)}" fill="${mark.fill}"${
        mark.stroke ? ` stroke="${mark.stroke}" stroke-width="${n(mark.width ?? 1)}"` : ''
      }${opacity(mark.opacity)}/>`

    case 'line':
      return `<line x1="${n(mark.x1)}" y1="${n(mark.y1)}" x2="${n(mark.x2)}" y2="${n(mark.y2)}" stroke="${mark.stroke}" stroke-width="${n(
        mark.width ?? 1,
      )}"${mark.dash ? ` stroke-dasharray="${mark.dash}"` : ''}${opacity(mark.opacity)}/>`

    case 'text': {
      const transform = mark.rotate ? ` transform="rotate(${mark.rotate} ${n(mark.x)} ${n(mark.y)})"` : ''
      // Tabular figures so a column of amounts lines up on its digits, which is
      // the whole reason a ledger's numbers are readable at a glance.
      const tnum = mark.tnum ? ` font-variant-numeric="tabular-nums" style="font-variant-numeric:tabular-nums"` : ''
      return `<text x="${n(mark.x)}" y="${n(mark.y)}" font-size="${n(mark.size)}"${
        mark.weight && mark.weight !== 400 ? ` font-weight="${mark.weight}"` : ''
      } fill="${mark.fill}"${mark.anchor && mark.anchor !== 'start' ? ` text-anchor="${mark.anchor}"` : ''}${
        opacity(mark.opacity)
      }${tnum}${transform}>${mark.title ? `<title>${esc(mark.title)}</title>` : ''}${esc(mark.s)}</text>`
    }
  }
  void theme
  return ''
}

function opacity(value: number | undefined): string {
  return value == null || value >= 1 ? '' : ` opacity="${n(value)}"`
}

/** Two decimals is under a tenth of a pixel and halves the file. */
function n(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * Escaped for both attribute values and text content.
 *
 * The double quote has to go, because every attribute here is delimited by
 * one - that is exactly how the font stack broke the document once already.
 * The apostrophe deliberately does not: attributes are never delimited by it,
 * and escaping it turns the perfectly good `'Segoe UI'` in the font stack into
 * `&apos;Segoe UI&apos;` in every file for no gain.
 */
function esc(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
