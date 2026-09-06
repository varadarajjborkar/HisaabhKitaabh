/**
 * A ZIP writer.
 *
 * No dependency, for the same reason this app renders its own charts and lays
 * out its own text tables: the format needed here is a few hundred lines, and
 * a library would ship a hundred kilobytes to write files that are mostly
 * commas. It writes the 1989 base format - local headers, a central directory,
 * an end record - which every unzipper on every platform has read for decades.
 *
 * Entries are deflated through the browser's own CompressionStream where it
 * exists and stored uncompressed where it does not. Both are valid ZIP; the
 * only difference is the size of the download.
 */

export type ZipEntry = { path: string; data: Uint8Array | string }

const encoder = new TextEncoder()

export async function makeZip(entries: ZipEntry[]): Promise<Blob> {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  let count = 0

  for (const entry of entries) {
    const name = encoder.encode(sanitise(entry.path))
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const crc = crc32(raw)
    const body = await deflate(raw)
    const method = body === raw ? 0 : 8

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)          // version needed
    lv.setUint16(6, 0x0800, true)      // UTF-8 names
    lv.setUint16(8, method, true)
    lv.setUint16(10, 0, true)          // time
    lv.setUint16(12, 0x21, true)       // date, 1 Jan 20xx: ZIP has no room for a real one
    lv.setUint32(14, crc, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)

    const dir = new Uint8Array(46 + name.length)
    const dv = new DataView(dir.buffer)
    dv.setUint32(0, 0x02014b50, true)
    dv.setUint16(4, 20, true)          // version made by
    dv.setUint16(6, 20, true)
    dv.setUint16(8, 0x0800, true)
    dv.setUint16(10, method, true)
    dv.setUint16(12, 0, true)
    dv.setUint16(14, 0x21, true)
    dv.setUint32(16, crc, true)
    dv.setUint32(20, body.length, true)
    dv.setUint32(24, raw.length, true)
    dv.setUint16(28, name.length, true)
    dv.setUint32(42, offset, true)     // where the local header sits
    dir.set(name, 46)

    chunks.push(local, body)
    central.push(dir)
    offset += local.length + body.length
    count++
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, count, true)
  ev.setUint16(10, count, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return new Blob([...chunks, ...central, end] as BlobPart[], { type: 'application/zip' })
}

/**
 * Deflate, if the browser can.
 *
 * Returns the input unchanged when it cannot, and the caller stores it
 * uncompressed - which is why the return value is compared by identity rather
 * than by a flag.
 */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return data
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
    const out = new Uint8Array(await new Response(stream).arrayBuffer())
    // A tiny file can come out larger than it went in.
    return out.length < data.length ? out : data
  } catch {
    return data
  }
}

/** A path that is safe inside an archive: no drive letters, no climbing out. */
function sanitise(path: string): string {
  return path
    .split('/')
    .map((part) => part.replace(/[\\:*?"<>|]/g, '-').replace(/^\.+$/, '_').trim())
    .filter(Boolean)
    .join('/')
}

/** A filename component with the separators taken out. */
export function safeSegment(name: string, fallback = 'untitled'): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean || fallback
}

let TABLE: Uint32Array | null = null

function crc32(data: Uint8Array): number {
  if (!TABLE) {
    TABLE = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      TABLE[i] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
