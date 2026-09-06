/**
 * How wide a string will be, before anything is drawn.
 *
 * SVG has no layout engine. A `<text>` element is placed at a coordinate and
 * whatever it is, it is: nothing reflows, nothing wraps, and a label too long
 * for its column runs straight across the next one. So every label in a chart
 * has to be measured before it is positioned, which means knowing the advance
 * width of each character without a canvas to ask.
 *
 * The table below is the answer, measured rather than guessed. Each entry is
 * the advance width of one character at font-weight 400, in thousandths of the
 * font size, read out of a real `<text>` node with getComputedTextLength on the
 * app's own stack. Codes 32 to 126 in order, then the non-ASCII a ledger prints.
 *
 * It is calibrated at 13px, and that detail matters. A first pass measured at
 * 200px and under-estimated every string by up to 18%, because the system font
 * has optical sizes: the wide, open Text cut is used at label sizes and the
 * tight Display cut at headline sizes. Numbers taken at a size no chart uses
 * describe a typeface no chart draws. Across 11-15px, where every label here
 * lives, the per-em widths hold to within 5%.
 *
 * Heavier weights are a scalar rather than three tables: 500 runs 2.28% wider
 * than 400 and 600 runs 4.57% wider, well inside the margin below.
 *
 * SAFETY is the reason this is usable at all. The table describes one font on
 * one platform; a Windows user gets Segoe UI and different widths. So the
 * estimate is deliberately generous - being wrong by a few pixels of slack
 * costs nothing, and being wrong the other way overlaps two labels.
 */

// prettier-ignore
const ASCII = [
  275, 305, 472, 624, 624, 919, 705, 291, 376, 376, 466, 622, 291, 464, 291, 299,
  623, 458, 598, 621, 636, 612, 630, 581, 633, 630, 291, 291, 623, 621, 623, 507,
  912, 667, 651, 709, 720, 590, 566, 740, 736, 262, 532, 653, 562, 868, 736, 765,
  629, 765, 647, 631, 622, 731, 667, 960, 673, 646, 656, 376, 299, 376, 624, 541,
  494, 546, 607, 553, 607, 563, 357, 602, 583, 241, 241, 537, 247, 864, 578, 583,
  603, 602, 384, 507, 357, 578, 536, 769, 519, 537, 533, 376, 253, 376, 624,
]

const SPECIAL: Record<string, number> = {
  '\u20b9': 624, '\u20ac': 624, '\u00a3': 624, '\u00a5': 624, '\u20a9': 888,
  '\u00b7': 290, '\u2014': 872, '\u2013': 578, '\u2026': 799,
  '\u201c': 452, '\u201d': 452, '\u2019': 290, '\u2018': 290,
  '\u2011': 464, '\u00a0': 275, '\u2212': 622, '\u00d7': 623,
}

/** Anything unlisted - an emoji, a Devanagari label - is assumed wide. */
const FALLBACK = 900

/*
 * Three corrections, fitted rather than guessed - a search over 729 real
 * strings measured at every size and weight a chart uses, keeping the
 * parameters that never fall short by more than a pixel while staying as
 * tight as possible on labels a user would actually type.
 *
 *   SAFETY  covers other platforms, where the stack resolves to Segoe UI or
 *           a Linux sans with its own metrics.
 *   FLOOR   a minimum advance. A glyph does not render narrower than about a
 *           quarter em however thin it is, so "iiii" is wider than four times
 *           the width of an isolated "i" suggests.
 *   SMALL   per-pixel widening below 13px, where the font opens up further.
 *
 * The result: never short by more than 0.97px anywhere, and at worst 14%
 * generous on a real label - which costs an early ellipsis, not an overlap.
 */
const SAFETY = 1.01
const FLOOR = 260
const SMALL = 0.012

export function weightScale(weight: number): number {
  if (weight >= 600) return 1.0457
  if (weight >= 500) return 1.0228
  return 1
}

/** Width of `text` at `size` px, in px. */
export function textWidth(text: string, size: number, weight = 400): number {
  let units = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const raw = cp >= 32 && cp < 127 ? ASCII[cp - 32] : (SPECIAL[ch] ?? FALLBACK)
    units += Math.max(raw, FLOOR)
  }
  const small = 1 + Math.max(0, 13 - size) * SMALL
  return (units / 1000) * size * weightScale(weight) * SAFETY * small
}

/**
 * The longest prefix of `text` that fits in `max`, with an ellipsis if it had
 * to cut. Returns the text unchanged when it already fits, so a label that is
 * short enough never grows a character it did not have.
 */
export function truncate(text: string, max: number, size: number, weight = 400): string {
  if (textWidth(text, size, weight) <= max) return text
  const dots = textWidth('…', size, weight)
  const budget = max - dots
  if (budget <= 0) return ''
  const chars = [...text]
  let width = 0
  let cut = 0
  for (; cut < chars.length; cut++) {
    const w = textWidth(chars[cut], size, weight)
    if (width + w > budget) break
    width += w
  }
  return chars.slice(0, cut).join('').trimEnd() + '…'
}

/** Greedy word wrap to `max` px, at most `maxLines` lines. */
export function wrap(text: string, max: number, size: number, weight = 400, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (textWidth(candidate, size, weight) <= max) { line = candidate; continue }
    if (line) lines.push(line)
    if (lines.length === maxLines) return finish(lines, text, max, size, weight, maxLines)
    // A single word wider than the line gets cut rather than allowed to bleed.
    line = textWidth(word, size, weight) > max ? truncate(word, max, size, weight) : word
  }
  if (line) lines.push(line)
  return lines.slice(0, maxLines)
}

function finish(lines: string[], text: string, max: number, size: number, weight: number, maxLines: number): string[] {
  const kept = lines.slice(0, maxLines)
  const last = kept.length - 1
  if (last >= 0 && kept.join(' ').length < text.length) kept[last] = truncate(`${kept[last]} …`, max, size, weight)
  return kept
}
