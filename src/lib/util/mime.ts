/**
 * What may be attached to a cell.
 *
 * Video is excluded deliberately: a single clip can be larger than every
 * receipt in an account put together, and Drive quota is the user's own. The
 * check is on both the declared MIME type and the extension, because browsers
 * disagree about both and a rename shouldn't get a file past the gate.
 */
const ALLOWED_PREFIXES = ['image/', 'text/']

const ALLOWED_EXACT = new Set([
  'application/pdf',
  'application/json',
  'application/csv',
  'application/rtf',
  'application/zip',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
])

const BLOCKED_PREFIXES = ['video/', 'audio/']

const BLOCKED_EXTENSIONS = new Set([
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ogv',
  'mp3', 'wav', 'aac', 'flac', 'm4a', 'ogg',
  'exe', 'dmg', 'app', 'msi', 'bat', 'sh', 'com', 'scr',
])

const ALLOWED_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'svg',
  'pdf', 'csv', 'tsv', 'txt', 'md', 'json', 'rtf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'zip',
])

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function checkAttachment(name: string, mime: string): { ok: true } | { ok: false; reason: string } {
  const ext = extensionOf(name)
  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { ok: false, reason: ext.length <= 4 && /mp4|mov|avi|mkv|webm|flv|wmv|m4v|mpg|3gp|ogv/.test(ext)
      ? 'Video files are not supported — attach a still frame or a receipt instead.'
      : `.${ext} files are not supported here.` }
  }
  if (BLOCKED_PREFIXES.some((p) => mime.startsWith(p))) {
    return { ok: false, reason: 'Video and audio files are not supported.' }
  }
  const mimeOk = ALLOWED_PREFIXES.some((p) => mime.startsWith(p)) || ALLOWED_EXACT.has(mime)
  const extOk = ALLOWED_EXTENSIONS.has(ext)
  if (!mimeOk && !extOk) return { ok: false, reason: `${mime || 'That file type'} is not supported.` }
  return { ok: true }
}

/** Files we can read as text and turn into rows without a vision model. */
export function isTabularText(name: string, mime: string): boolean {
  const ext = extensionOf(name)
  return ['csv', 'tsv', 'txt', 'json', 'md'].includes(ext) || mime.startsWith('text/') || mime === 'application/json'
}

export function isImage(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * The content type we are willing to *serve back*.
 *
 * The attachment reference travels through the client, so its declared MIME
 * type is user-controlled. Echoing it into a response header would let someone
 * have their own upload served as text/html from this origin — stored XSS
 * against their own session, and a foothold worth not granting. Anything
 * outside this list is served as an opaque download instead.
 */
const INLINE_SAFE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff',
  'application/pdf', 'text/plain', 'text/csv',
])

export function safeServeType(mime: string): { type: string; disposition: 'inline' | 'attachment' } {
  const base = (mime || '').split(';')[0].trim().toLowerCase()
  if (INLINE_SAFE.has(base)) return { type: base, disposition: 'inline' }
  // SVG is an image that can carry script, so it downloads rather than renders.
  return { type: 'application/octet-stream', disposition: 'attachment' }
}

/** Strip anything that could break out of a Content-Disposition filename. */
export function safeFilename(name: string): string {
  return name.replace(/[\r\n"\\]/g, '').replace(/[^\w\s.\-()\[\]]/g, '_').slice(0, 120) || 'attachment'
}
