/**
 * A small Markdown reader, for text a model wrote.
 *
 * The assistant already writes Markdown - bold figures, a bullet per bucket, a
 * fenced block when it quotes a row - and until now the transcript printed the
 * asterisks. This turns that text into a tree the panel can render.
 *
 * It is deliberately not a CommonMark implementation. It covers what a model
 * emits into a chat panel and nothing else, which keeps it to one file with no
 * dependency, in a project that also hand-rolls its table layout. The rule for
 * everything outside that set is the same rule a reader would apply: if the
 * syntax is not recognised, the characters are the text.
 *
 * Streaming is the reason for one particular decision. Text arrives a token at
 * a time, so a half-written "**tot" is a normal intermediate state, not an
 * error. An unclosed marker is therefore never an error case: it falls through
 * to a literal, and repairs itself on the token that closes it.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; kids: Inline[] }
  | { t: 'em'; kids: Inline[] }
  | { t: 'del'; kids: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; kids: Inline[] }

export type Align = 'left' | 'right' | 'center'

export type Block =
  | { t: 'p'; kids: Inline[] }
  | { t: 'h'; level: number; kids: Inline[] }
  | { t: 'pre'; lang: string; v: string }
  | { t: 'quote'; kids: Block[] }
  | { t: 'list'; ordered: boolean; start: number; tight: boolean; items: Block[][] }
  | { t: 'table'; head: Inline[][]; align: Align[]; rows: Inline[][][] }
  | { t: 'rule' }

const FENCE = /^(\s{0,3})(```+|~~~+)[ \t]*([\w+#.-]*)[ \t]*$/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/
const DELIM = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/

type Marker = { indent: number; ordered: boolean; start: number; text: string; width: number }

/** A list line, or null. Tabs count as four columns so indentation compares. */
function markerAt(line: string): Marker | null {
  const m = BULLET.exec(line) ?? ORDERED.exec(line)
  if (!m) return null
  const ordered = !/^[-*+]$/.test(m[2])
  // A rule (`---`, `***`) also matches BULLET; it is not a list.
  if (!ordered && RULE.test(line)) return null
  return {
    indent: width(m[1]),
    ordered,
    start: ordered ? Number(m[2]) : 1,
    text: m[3],
    width: width(m[1]) + m[2].length + 1,
  }
}

function width(pad: string): number {
  let n = 0
  for (const c of pad) n += c === '\t' ? 4 - (n % 4) : 1
  return n
}

/** Remove up to `n` columns of leading whitespace, keeping the rest. */
function dedent(line: string, n: number): string {
  let i = 0
  let used = 0
  while (i < line.length && used < n) {
    const c = line[i]
    if (c === ' ') used += 1
    else if (c === '\t') used += 4 - (used % 4)
    else break
    i++
  }
  return line.slice(i)
}

const blank = (s: string) => s.trim() === ''

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, '\n').split('\n'))
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (blank(line)) { i++; continue }

    const fence = FENCE.exec(line)
    if (fence) {
      const close = fence[2][0].repeat(3)
      const body: string[] = []
      i++
      // An unterminated fence runs to the end of the text rather than being
      // discarded: mid-stream, that is simply a block still being written.
      while (i < lines.length && !(lines[i].trimStart().startsWith(close) && lines[i].trim().replace(/[`~]/g, '') === '')) {
        body.push(lines[i]); i++
      }
      if (i < lines.length) i++
      out.push({ t: 'pre', lang: fence[3] ?? '', v: body.join('\n') })
      continue
    }

    if (RULE.test(line)) { out.push({ t: 'rule' }); i++; continue }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ t: 'h', level: heading[1].length, kids: parseInline(heading[2]) })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && (QUOTE.test(lines[i]) || (!blank(lines[i]) && body.length > 0 && !markerAt(lines[i])))) {
        const q = QUOTE.exec(lines[i])
        body.push(q ? q[1] : lines[i])
        i++
      }
      out.push({ t: 'quote', kids: parseBlocks(body) })
      continue
    }

    const mark = markerAt(line)
    if (mark) {
      const [list, next] = parseList(lines, i, mark)
      out.push(list)
      i = next
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && DELIM.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const [table, next] = parseTable(lines, i)
      out.push(table)
      i = next
      continue
    }

    // A paragraph runs to the next blank line or the next block opener.
    const para: string[] = []
    while (i < lines.length && !blank(lines[i]) && !opensBlock(lines, i)) { para.push(lines[i]); i++ }
    if (para.length === 0) { para.push(lines[i]); i++ }
    out.push({ t: 'p', kids: parseInline(para.join('\n').trim()) })
  }

  return out
}

function opensBlock(lines: string[], i: number): boolean {
  const line = lines[i]
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    markerAt(line) !== null ||
    (line.includes('|') && i + 1 < lines.length && DELIM.test(lines[i + 1]) && lines[i + 1].includes('-'))
  )
}

/**
 * One list, and any list nested inside it.
 *
 * Items are split at markers sitting at the list's own indent; anything
 * further in belongs to the item that opened above it, is dedented, and goes
 * back through the block parser - which is what makes a sub-list, a paragraph
 * or a fenced block inside a bullet work without a special case for each.
 */
function parseList(lines: string[], from: number, first: Marker): [Block, number] {
  const ordered = first.ordered
  const indent = first.indent
  const items: string[][] = []
  let current: string[] | null = null
  let loose = false
  let pendingBlank = false
  let i = from

  while (i < lines.length) {
    const line = lines[i]

    if (blank(line)) {
      // A blank line ends the list unless the list continues after it.
      const next = lines[i + 1]
      const continues =
        next !== undefined &&
        !blank(next) &&
        (markerAt(next) !== null ? markerAt(next)!.indent >= indent : width(leading(next)) > indent)
      if (!continues) { i++; break }
      pendingBlank = true
      current?.push('')
      i++
      continue
    }

    const mark = markerAt(line)
    if (mark && mark.indent <= indent + 1 && mark.ordered === ordered) {
      if (pendingBlank && current) loose = true
      current = [mark.text]
      items.push(current)
      pendingBlank = false
      i++
      continue
    }
    if (mark && mark.indent <= indent + 1 && mark.ordered !== ordered) break

    if (!current) break

    // Deeper, or a plain continuation line under the current item.
    if (mark || width(leading(line)) > indent) { current.push(dedent(line, first.width)); i++; continue }
    if (pendingBlank) break

    // A lazy continuation: wrapped prose with no indent at all.
    current.push(line.trim())
    i++
  }

  while (items.length && items[items.length - 1].every(blank)) items.pop()

  return [
    { t: 'list', ordered, start: first.start, tight: !loose, items: items.map((item) => parseBlocks(item)) },
    i,
  ]
}

function leading(line: string): string {
  return /^[ \t]*/.exec(line)![0]
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { buf += '|'; i++; continue }
    if (s[i] === '|') { cells.push(buf.trim()); buf = ''; continue }
    buf += s[i]
  }
  cells.push(buf.trim())
  return cells
}

function parseTable(lines: string[], from: number): [Block, number] {
  const head = splitRow(lines[from])
  const align: Align[] = splitRow(lines[from + 1]).map((c) => {
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    return left && right ? 'center' : right ? 'right' : 'left'
  })
  const rows: Inline[][][] = []
  let i = from + 2
  while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
    const cells = splitRow(lines[i])
    // Ragged rows are padded rather than dropped: a missing cell is a gap in
    // the table, not a reason to stop rendering the rest of it.
    while (cells.length < head.length) cells.push('')
    rows.push(cells.slice(0, head.length).map(parseInline))
    i++
  }
  return [{ t: 'table', head: head.map(parseInline), align, rows }, i]
}

const PUNCT = /[\\`*_{}[\]()#+\-.!|~>]/
const AUTOLINK = /^(https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"])/

function run(src: string, i: number, ch: string): number {
  let n = 0
  while (src[i + n] === ch) n++
  return n
}

/** Where an emphasis run closes, or -1. The closer may not follow a space. */
function closerOf(src: string, from: number, marker: string): number {
  let i = from
  while (i < src.length) {
    const at = src.indexOf(marker, i)
    if (at === -1) return -1
    if (at === from) { i = at + marker.length; continue }
    const before = src[at - 1]
    const after = src[at + marker.length]
    const longer = after === marker[0]
    if (!/\s/.test(before) && !longer) return at
    i = at + (longer ? 1 : marker.length)
  }
  return -1
}

const WORDY = /[\p{L}\p{N}]/u

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  let i = 0
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = '' } }

  while (i < src.length) {
    const c = src[i]

    if (c === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue }

    if (c === '`') {
      const n = run(src, i, '`')
      const ticks = '`'.repeat(n)
      const close = src.indexOf(ticks, i + n)
      if (close !== -1 && src[close + n] !== '`') {
        flush()
        out.push({ t: 'code', v: src.slice(i + n, close).replace(/^ (.*?) $/, '$1') })
        i = close + n
        continue
      }
    }

    if (c === '~' && src.startsWith('~~', i)) {
      const close = closerOf(src, i + 2, '~~')
      if (close !== -1) {
        flush()
        out.push({ t: 'del', kids: parseInline(src.slice(i + 2, close)) })
        i = close + 2
        continue
      }
    }

    if (c === '*' || c === '_') {
      // snake_case and file_names are words, not emphasis, so an underscore
      // between two word characters never opens a run.
      const intraWord = c === '_' && i > 0 && WORDY.test(src[i - 1])
      if (!intraWord && !/\s/.test(src[i + 1] ?? ' ')) {
        const n = Math.min(run(src, i, c), 2)
        const marker = c.repeat(n)
        const close = closerOf(src, i + n, marker)
        if (close !== -1) {
          flush()
          const kids = parseInline(src.slice(i + n, close))
          out.push(n === 2 ? { t: 'strong', kids } : { t: 'em', kids })
          i = close + n
          continue
        }
      }
    }

    if (c === '[') {
      const link = linkAt(src, i)
      if (link) {
        flush()
        out.push({ t: 'link', href: link.href, kids: parseInline(link.text) })
        i = link.end
        continue
      }
    }

    if (c === 'h' && (i === 0 || !WORDY.test(src[i - 1]))) {
      const auto = AUTOLINK.exec(src.slice(i))
      if (auto) {
        flush()
        out.push({ t: 'link', href: auto[1], kids: [{ t: 'text', v: auto[1] }] })
        i += auto[1].length
        continue
      }
    }

    buf += c
    i++
  }

  flush()
  return out
}

/** `[text](href)`, with nesting in the label and parentheses in the target. */
function linkAt(src: string, i: number): { text: string; href: string; end: number } | null {
  let depth = 0
  let j = i
  for (; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue }
    if (src[j] === '[') depth++
    else if (src[j] === ']') { depth--; if (depth === 0) break }
  }
  if (depth !== 0 || src[j + 1] !== '(') return null
  const text = src.slice(i + 1, j)
  let k = j + 2
  let paren = 1
  for (; k < src.length; k++) {
    if (src[k] === '\\') { k++; continue }
    if (src[k] === '(') paren++
    else if (src[k] === ')') { paren--; if (paren === 0) break }
  }
  if (paren !== 0) return null
  const href = src.slice(j + 2, k).split(/\s+/)[0]
  return { text, href, end: k + 1 }
}

/**
 * Whether a URL is safe to put behind a link.
 *
 * The text is written by a model that has just read the user's own files, so
 * a "javascript:" target is not a hypothetical. Anything that is not plainly a
 * web or mail address renders as text.
 */
export function safeHref(href: string): string | null {
  const s = href.trim()
  if (/^(https?:|mailto:)/i.test(s)) return s
  if (/^[\w.-]+@[\w.-]+\.\w+$/.test(s)) return `mailto:${s}`
  if (/^[/#]/.test(s) && !s.startsWith('//')) return s
  return null
}

/** The text with its formatting removed, for titles and other flat contexts. */
export function plainText(blocks: Block[]): string {
  const inline = (kids: Inline[]): string =>
    kids.map((k) => (k.t === 'text' ? k.v : k.t === 'code' ? k.v : inline(k.kids))).join('')
  const walk = (bs: Block[]): string =>
    bs
      .map((b) => {
        switch (b.t) {
          case 'p': case 'h': return inline(b.kids)
          case 'pre': return b.v
          case 'quote': return walk(b.kids)
          case 'list': return b.items.map(walk).join('\n')
          case 'table': return [b.head, ...b.rows].map((r) => r.map(inline).join(' ')).join('\n')
          case 'rule': return ''
        }
      })
      .filter(Boolean)
      .join('\n')
  return walk(blocks)
}
