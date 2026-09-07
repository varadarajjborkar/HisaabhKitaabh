/**
 * Making a receipt cost what a receipt is worth.
 *
 * A phone takes a twelve-megapixel photograph of a piece of paper the size of a
 * hand, and every one of those pixels then lives in a Postgres row forever. The
 * information on it - a shop name, a date, a column of amounts - survives being
 * reduced to sixteen hundred pixels on the long edge with room to spare. That
 * is the difference between forty receipts in an account and four.
 *
 * So the shrinking happens here, in the browser, before the bytes are ever
 * uploaded. Doing it on the server would still mean carrying three megabytes
 * over the wire on whatever connection the user has, which is the slow part.
 *
 * Deliberately conservative about when it refuses:
 *
 * - Only images. A PDF invoice is already compact and re-rendering one to JPEG
 *   would destroy its text layer.
 * - Never an increase. If the original is already smaller than what comes out -
 *   a tight JPEG, a small screenshot, a line-art PNG that JPEG handles badly -
 *   the original is kept.
 * - Never a failure. A format the browser cannot decode (HEIC outside Safari is
 *   the common one) falls back to the original file untouched. Losing an upload
 *   to save space on it would be a poor trade.
 */

/** Long edge, in pixels. Small print on a receipt is still legible here. */
const MAX_EDGE = 1600

/**
 * 0.72 is where the artefacts stop being visible on a photograph of paper.
 * Higher barely changes what can be read and roughly doubles the file.
 */
const QUALITY = 0.72

/** Below this there is nothing worth reclaiming, and re-encoding only loses. */
const FLOOR_BYTES = 320 * 1024

export type Shrunk = { file: File; from: number; to: number }

export async function shrinkImage(file: File): Promise<Shrunk> {
  const unchanged: Shrunk = { file, from: file.size, to: file.size }

  if (!file.type.startsWith('image/') || file.size <= FLOOR_BYTES) return unchanged
  if (typeof createImageBitmap !== 'function') return unchanged

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) { bitmap.close(); return unchanged }

    /*
     * A white ground first. A transparent PNG drawn straight onto JPEG turns
     * its transparent pixels black, which for a receipt scanned with a
     * cut-out background means a black page.
     */
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY))
    canvas.width = 0
    canvas.height = 0
    if (!blob || blob.size >= file.size) return unchanged

    return {
      file: new File([blob], renameToJpeg(file.name), { type: 'image/jpeg', lastModified: file.lastModified }),
      from: file.size,
      to: blob.size,
    }
  } catch {
    return unchanged
  }
}

/** The name the user sees should not claim to be a PNG once it is a JPEG. */
function renameToJpeg(name: string): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem}.jpg`
}
