'use client'

import { renderChartFile, renderChartSvg } from '@/lib/charts/svg'
import type { ChartSpec } from '@/lib/charts/spec'
import { themeFor } from '@/lib/charts/theme'
import { toast } from '@/components/ui/Toast'

/**
 * A chart, as a file.
 *
 * The image is built from the same spec and the same renderer the panel draws
 * with, so what lands in Downloads is what was on screen rather than a second
 * rendering of the same numbers that agrees with it today. There is no service
 * involved and nothing leaves the machine: the SVG is written here, and the
 * browser rasterises it locally.
 *
 * That last part is the reason a chart is drawn rather than generated. An
 * image model asked for "two bars, 18,735 and 450" returns a picture with five
 * bars, a title in no language, and heights in no proportion to anything - it
 * has no arithmetic, only a sense of what charts tend to look like. A ledger
 * cannot use a chart whose numbers are decorative.
 */

const EXPORT_WIDTH = 900
const SCALE = 2

export type ExportOptions = {
  dark?: boolean
  width?: number
  /** Multiplier over CSS pixels. 2 is retina; 3 for a slide. */
  scale?: number
}

/** The chart as an SVG string, sized and themed for a standalone file. */
export function chartFileSvg(spec: ChartSpec, options: ExportOptions = {}): string {
  const width = options.width ?? EXPORT_WIDTH
  return renderChartFile(spec, { width, theme: themeFor(options.dark ?? false), showTitle: true, showNote: true })
}

/**
 * Rasterise an SVG string.
 *
 * The SVG goes in through a data URL rather than a blob URL because Safari
 * refuses to draw a blob-backed SVG image to a canvas. It carries no external
 * reference of any kind - no stylesheet, no font file, no linked image - which
 * is what keeps the canvas untainted and `toBlob` legal.
 */
export async function svgToPng(svg: string, width: number, height: number, scale = SCALE): Promise<Blob> {
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  const image = new Image()
  image.decoding = 'sync'

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('The chart could not be rasterised'))
    image.src = url
  })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser has no 2D canvas')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The image could not be encoded')
  return blob
}

/** Height of the chart the renderer will produce, so the canvas matches it. */
function sizeOf(svg: string): { width: number; height: number } {
  const w = /width="([\d.]+)"/.exec(svg)
  const h = /height="([\d.]+)"/.exec(svg)
  return { width: Number(w?.[1] ?? EXPORT_WIDTH), height: Number(h?.[1] ?? 400) }
}

export async function downloadChartPng(spec: ChartSpec, options: ExportOptions = {}): Promise<void> {
  try {
    const svg = chartFileSvg(spec, options)
    const { width, height } = sizeOf(svg)
    const blob = await svgToPng(svg, width, height, options.scale ?? SCALE)
    save(blob, `${safeName(spec.title)}.png`)
    toast.success('Chart saved', `PNG, ${Math.round(width * (options.scale ?? SCALE))}px wide.`)
  } catch {
    toast.error('Could not save the chart', 'Try the SVG instead.')
  }
}

export function downloadChartSvg(spec: ChartSpec, options: ExportOptions = {}): void {
  const svg = chartFileSvg(spec, options)
  save(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${safeName(spec.title)}.svg`)
  toast.success('Chart saved', 'SVG, sharp at any size.')
}

/**
 * The chart on the clipboard, ready to paste into a message.
 *
 * Written through a promise rather than an awaited blob: Safari drops the
 * user-gesture permission across an await, and a clipboard write outside a
 * gesture is refused.
 */
export async function copyChartPng(spec: ChartSpec, options: ExportOptions = {}): Promise<void> {
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      await downloadChartPng(spec, options)
      return
    }
    const svg = chartFileSvg(spec, options)
    const { width, height } = sizeOf(svg)
    const item = new ClipboardItem({ 'image/png': svgToPng(svg, width, height, options.scale ?? SCALE) })
    await navigator.clipboard.write([item])
    toast.success('Chart copied', 'Paste it anywhere that takes an image.')
  } catch {
    toast.error('Could not copy the chart', 'Saving it instead works everywhere.')
  }
}

function save(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

function safeName(name: string): string {
  return name.replace(/[^\w\s.-]/g, '').replace(/\s+/g, '-').slice(0, 60) || 'chart'
}

export { renderChartSvg }
