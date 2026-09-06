'use client'

/**
 * PDFs, turned into pictures of themselves.
 *
 * The assistant can already read an image: a photo of a receipt goes to the
 * vision model and comes back as figures. A PDF could not be read at all - it
 * was accepted, stored, and then answered with "this format cannot be read
 * here", which is the worst of both, because the user has already spent the
 * upload.
 *
 * Rendering each page to a JPEG and sending those turns a document into
 * something the existing path already understands. No new server capability, no
 * PDF parsing in the API, no native binary on a serverless host - just the same
 * images the assistant reads every day.
 *
 * The cost is paid in the browser, once, on a file the user chose to attach:
 *
 *  - pdf.js is loaded on demand. It is about a megabyte, and a person who never
 *    attaches a PDF never downloads it.
 *  - Pages are rendered at a scale that makes small print legible and no
 *    larger; past a point the vision model gains nothing and the upload gets
 *    slower.
 *  - There is a page cap. A forty-page statement is not a thing to send to a
 *    vision model one page at a time, and the honest answer there is a CSV.
 */

/** Enough for a receipt's small print without doubling the upload for nothing. */
const TARGET_WIDTH = 1400
/** JPEG rather than PNG: a scanned page compresses to a fifth of the size. */
const QUALITY = 0.82
/** Beyond this the right answer is a spreadsheet, not a pile of screenshots. */
export const MAX_PAGES = 8

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

type PdfModule = typeof import('pdfjs-dist')

let cached: Promise<PdfModule> | null = null

/**
 * Load pdf.js and point it at its worker.
 *
 * The worker URL is resolved through the bundler rather than a CDN so the page
 * keeps working with no network and inside a strict content policy. The import
 * is cached because a second PDF should not pay for the download twice.
 */
function loadPdfJs(): Promise<PdfModule> {
  cached ??= import('pdfjs-dist').then((mod) => {
    mod.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()
    return mod
  })
  return cached
}

export type PdfPage = { file: File; page: number; pages: number }

/**
 * One image per page, in page order.
 *
 * Rendering is sequential on purpose. Each page needs a full-size canvas, and
 * running eight of those at once on a phone is how a tab gets killed for
 * memory - the work is the same either way, and this way it finishes.
 */
export async function pdfToImages(file: File, onProgress?: (done: number, total: number) => void): Promise<PdfPage[]> {
  const pdfjs = await loadPdfJs()
  const data = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise

  try {
    const total = Math.min(doc.numPages, MAX_PAGES)
    const base = file.name.replace(/\.pdf$/i, '')
    const out: PdfPage[] = []

    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n)
      const unscaled = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(2.5, TARGET_WIDTH / unscaled.width) })

      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('This browser cannot draw the pages')

      // A page with a transparent background renders as black on black once it
      // is flattened into a JPEG, which is unreadable to a person and to a
      // model. Paint the paper first.
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      page.cleanup()

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
      canvas.width = 0
      canvas.height = 0
      if (!blob) throw new Error('Could not turn that page into an image')

      const label = total === 1 ? `${base}.jpg` : `${base} - page ${n}.jpg`
      out.push({ file: new File([blob], label, { type: 'image/jpeg' }), page: n, pages: doc.numPages })
      onProgress?.(n, total)
    }

    return out
  } finally {
    await doc.destroy()
  }
}
