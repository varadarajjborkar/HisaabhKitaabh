/**
 * Fixed-width table layout for plain text.
 *
 * Everything that leaves this app as text - the mail draft, the clipboard copy -
 * goes through here, because "the columns line up" is not something you get by
 * padding with `String.padEnd`. Three things break that naive version, and all
 * three are handled below.
 *
 *   1. `"₹1,234".length` is not how wide "₹1,234" is on screen. A CJK ideograph
 *      occupies two cells, a combining accent occupies none, and an emoji with a
 *      variation selector is one glyph made of several code points. Padding by
 *      `.length` puts every subsequent column at a different offset on any row
 *      containing one of them.
 *
 *   2. A cell longer than its column has to go somewhere. Truncating loses the
 *      user's data; letting it run pushes every column after it sideways for
 *      that row only, which is exactly the "overlapping into someone else's
 *      space" this is written to prevent. It wraps, and the wrapped lines are
 *      indented to sit under their own column.
 *
 *   3. The table has to fit a width. Mail wraps at around 78 characters, and a
 *      table wider than the window gets folded by the client at arbitrary
 *      points, which destroys the grid far more thoroughly than any of the
 *      above. Columns are shrunk to fit, widest first, and never below what
 *      their own longest word needs.
 *
 * The invariant every row satisfies: each column starts at the same character
 * offset on every line, including continuation lines, so no value can ever
 * occupy a neighbour's span.
 */

// ------------------------------------------------------------------- width

/**
 * Code points that occupy two terminal cells.
 *
 * The standard East Asian Wide and Fullwidth blocks, plus the emoji planes.
 * This is the pragmatic set, not a generated Unicode table: it covers what
 * actually turns up in an expense ledger (a Hindi or Japanese caption, an emoji
 * in a title) without shipping a 40KB range table for the rest.
 */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

/** Combining marks, joiners and variation selectors: no advance of their own. */
const ZERO: Array<[number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0900, 0x0903], [0x093a, 0x094f], [0x0951, 0x0957],
  [0x200b, 0x200f], [0x2028, 0x202e], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
]

function inRanges(cp: number, ranges: Array<[number, number]>): boolean {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false
    if (cp <= hi) return true
  }
  return false
}

function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0x200d) return 0 // zero-width joiner, inside emoji sequences
  if (inRanges(cp, ZERO)) return 0
  if (inRanges(cp, WIDE)) return 2
  return 1
}

/**
 * Grapheme segmentation, so a family emoji or an accented letter counts once.
 *
 * `Intl.Segmenter` is present in every runtime this ships to; the fallback is
 * for older Node in a test harness, where per-code-point counting is close
 * enough that nothing visibly misaligns.
 */
const segmenter: { segment: (s: string) => Iterable<{ segment: string }> } | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new (Intl as unknown as { Segmenter: new (l?: string, o?: object) => { segment: (s: string) => Iterable<{ segment: string }> } })
        .Segmenter(undefined, { granularity: 'grapheme' })
    : null

export function graphemes(text: string): string[] {
  if (!segmenter) return [...text]
  return [...segmenter.segment(text)].map((s) => s.segment)
}

/** How many character cells `text` occupies. */
export function displayWidth(text: string): number {
  let total = 0
  for (const g of graphemes(text)) {
    // A cluster is as wide as its widest code point: "e" plus an accent is 1,
    // an emoji plus a variation selector is 2.
    let w = 0
    for (const ch of g) w = Math.max(w, codePointWidth(ch.codePointAt(0)!))
    total += w
  }
  return total
}

/** Pad to exactly `width` cells. Over-long input is returned untouched. */
export function padTo(text: string, width: number, align: 'left' | 'right'): string {
  const gap = width - displayWidth(text)
  if (gap <= 0) return text
  const pad = ' '.repeat(gap)
  return align === 'right' ? pad + text : text + pad
}

/** Cut a single over-long word into pieces of at most `width` cells. */
function splitWord(word: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  let used = 0
  for (const g of graphemes(word)) {
    const w = displayWidth(g)
    if (used + w > width && line) {
      out.push(line)
      line = ''
      used = 0
    }
    line += g
    used += w
  }
  if (line) out.push(line)
  return out
}

/** Greedy word wrap by display width. Never returns an empty array. */
export function wrapCell(text: string, width: number): string[] {
  if (width <= 0) return ['']
  const source = text.replace(/\s+/g, ' ').trim()
  if (!source) return ['']
  if (displayWidth(source) <= width) return [source]

  const lines: string[] = []
  let line = ''
  for (const word of source.split(' ')) {
    if (displayWidth(word) > width) {
      if (line) { lines.push(line); line = '' }
      const pieces = splitWord(word, width)
      lines.push(...pieces.slice(0, -1))
      line = pieces[pieces.length - 1]
      continue
    }
    const candidate = line ? `${line} ${word}` : word
    if (displayWidth(candidate) <= width) {
      line = candidate
    } else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

// ------------------------------------------------------------------ layout

export type TextColumn = {
  header: string
  align: 'left' | 'right'
  /** One entry per row, in row order. */
  cells: string[]
  /**
   * Columns that must never wrap. An amount broken across two lines is not a
   * number any more, so money and counts keep their natural width and the
   * shrinking is taken out of the prose columns instead.
   */
  noWrap?: boolean
}

export type TableOptions = {
  /** Total line budget. 72 leaves room for a mail client's quoting prefix. */
  maxWidth?: number
  /** Spaces between columns. Two reads as a column break; one reads as a typo. */
  gap?: number
  /** A rule under the header, and above the footer if there is one. */
  rule?: boolean
  /** One extra row, rendered under a rule. Same shape as a data row. */
  footer?: string[]
}

const MIN_TEXT_WIDTH = 8

/**
 * Render columns into lines that all share one grid.
 *
 * Returns physical lines, already padded and joined. Callers should not pad
 * anything themselves; the whole point is that one function decides every
 * offset in the table.
 */
export function layoutTable(columns: TextColumn[], options: TableOptions = {}): string[] {
  const { maxWidth = 72, gap = 2, rule = true, footer } = options
  if (columns.length === 0) return []

  const rowCount = Math.max(0, ...columns.map((c) => c.cells.length))
  const gapText = ' '.repeat(gap)

  // Natural width: the widest thing the column has to show.
  const natural = columns.map((col, i) => {
    const values = [col.header, ...col.cells, ...(footer ? [footer[i] ?? ''] : [])]
    return Math.max(1, ...values.map(displayWidth))
  })

  // Floor: below this the column stops being readable. A no-wrap column's floor
  // is its natural width, so it is simply never chosen for shrinking.
  const floor = columns.map((col, i) => {
    if (col.noWrap) return natural[i]
    const words = [col.header, ...col.cells].flatMap((v) => v.split(/\s+/))
    const longestWord = Math.max(1, ...words.map(displayWidth))
    return Math.min(natural[i], Math.max(MIN_TEXT_WIDTH, Math.min(longestWord, 16)))
  })

  const widths = [...natural]
  const totalGap = gap * (columns.length - 1)
  const width = () => widths.reduce((a, b) => a + b, 0) + totalGap

  // Shrink the widest shrinkable column, one cell at a time. Taking from the
  // widest keeps the table balanced instead of collapsing whichever column
  // happens to come first.
  let guard = 4000
  while (width() > maxWidth && guard-- > 0) {
    let target = -1
    for (let i = 0; i < widths.length; i++) {
      if (widths[i] <= floor[i]) continue
      if (target === -1 || widths[i] > widths[target]) target = i
    }
    if (target === -1) break // everything is at its floor; the table is as narrow as it gets
    widths[target]--
  }

  const renderRow = (cells: string[]): string[] => {
    const wrapped = columns.map((col, i) => wrapCell(cells[i] ?? '', widths[i]))
    const height = Math.max(1, ...wrapped.map((w) => w.length))
    const lines: string[] = []
    for (let line = 0; line < height; line++) {
      const parts = columns.map((col, i) => padTo(wrapped[i][line] ?? '', widths[i], col.align))
      lines.push(parts.join(gapText).trimEnd())
    }
    return lines
  }

  const ruleLine = widths.map((w) => '-'.repeat(w)).join(gapText)

  const out: string[] = []
  out.push(...renderRow(columns.map((c) => c.header)))
  if (rule) out.push(ruleLine)
  for (let r = 0; r < rowCount; r++) out.push(...renderRow(columns.map((c) => c.cells[r] ?? '')))
  if (footer) {
    if (rule) out.push(ruleLine)
    out.push(...renderRow(footer))
  }
  return out
}

/** The width the table will actually occupy, for a preview that has to fit. */
export function tableWidth(lines: string[]): number {
  return Math.max(0, ...lines.map(displayWidth))
}
