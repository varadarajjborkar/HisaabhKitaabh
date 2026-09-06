import type { CellValue, Column, FileMeta, FolderMeta, Row, SheetDoc } from '../model/types'
import { formatDate, formatMoney } from '../util/format'

/**
 * Search, ranked by what matched and then by where you were standing.
 *
 * Two rules, in that order.
 *
 * **What matched comes first.** A folder is not automatically a better answer
 * than a row inside a file just because folders are further up the tree. If you
 * type "insurance" and there is a row called Insurance and a folder called
 * Insurance stuff, both are candidates and the closer of the two names wins.
 * Grouping the output by type would decide that question by category instead of
 * by relevance, which is the thing being asked.
 *
 * **Where you are is a tie-break, not a filter - until it is.** On the home
 * screen everything is in range and proximity does nothing. Inside a folder the
 * folder *is* the question: "where did that 450 go" means in here, so results
 * from elsewhere are not ranked lower, they are not results.
 *
 * All of this is pure. Nothing here reads a database, which is what lets the
 * scoring be argued with directly.
 */

export type Match = {
  /** 0 to 1: how squarely the term landed. */
  strength: number
  /** What it landed in, for the "why" line under a result. */
  field: string
  /** The text that matched, for highlighting. */
  text: string
}

export type Hit =
  | { kind: 'folder'; score: number; why: string; id: string; name: string; icon: string; color: string; fileCount: number }
  | { kind: 'file'; score: number; why: string; id: string; name: string; folderId: string; folderName: string; total: number; currency: string; rowCount: number }
  | {
      kind: 'row'
      score: number
      why: string
      fileId: string
      fileName: string
      folderId: string
      folderName: string
      rowId: string
      title: string
      amount: number
      currency: string
      snippet: string
    }

/**
 * How much each kind of field is worth having matched.
 *
 * A name is what a thing *is*; a cell is something it contains. Both are worth
 * finding, and a name is worth slightly more, but not so much more that an
 * exact hit on a caption loses to a partial hit on a title.
 */
const FIELD_WEIGHT: Record<string, number> = {
  folder: 1,
  file: 0.94,
  title: 0.84,
  amount: 0.8,
  date: 0.76,
  cell: 0.66,
}

/** Standing inside a folder makes its contents better answers, not the only ones. */
const NEAR_BOOST = 1.25

/**
 * Split a query into terms.
 *
 * On whitespace only. Splitting on commas as well seemed tidier until the first
 * search for an amount: "5,500" became the two terms "5" and "500", which every
 * document in the account satisfies somewhere, and the search went from precise
 * to useless. A comma inside a number is part of the number. One that ends a
 * word is punctuation, and only that one is dropped.
 */
export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[,;.]+|[,;.]+$/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 8)
}

/**
 * The same terms, as the stored JSON would spell them.
 *
 * Amounts are kept as bare numbers on disk, so a search for "5,500" has to look
 * for 5500 when narrowing candidates - the grouping only exists once a figure
 * has been formatted for a person to read. The ranking still sees the term the
 * user typed, and matches it against both spellings.
 */
export function storageTerms(terms: string[]): string[] {
  return terms.map((t) => (/^[\d,]*\d[\d,]*(\.\d+)?$/.test(t) ? t.replace(/,/g, '') : t))
}

/**
 * How squarely one term lands in one value.
 *
 * The gaps between these numbers matter more than the numbers: a whole-value
 * match has to beat a prefix, a prefix has to beat a word start, and a word
 * start has to beat a fragment buried mid-word - otherwise "cab" ranks a row
 * about a "scabbard" alongside the taxi.
 */
export function matchStrength(value: string, term: string): number {
  if (!value || !term) return 0
  const v = value.toLowerCase()
  if (v === term) return 1
  if (v.startsWith(term)) return 0.86
  const at = v.indexOf(term)
  if (at < 0) return 0
  const before = v[at - 1]
  return /[\s\-_/,.:()[\]]/.test(before) ? 0.72 : 0.46
}

/** The strongest landing of `term` across several fields. */
function best(term: string, fields: Array<[field: string, value: string]>): Match | null {
  let top: Match | null = null
  for (const [field, value] of fields) {
    const strength = matchStrength(value, term) * (FIELD_WEIGHT[field] ?? 0.5)
    if (strength > 0 && (!top || strength > top.strength)) top = { strength, field, text: value }
  }
  return top
}

/**
 * Score one candidate against every term.
 *
 * Every term has to land somewhere or the candidate is not a result at all:
 * "cab october" should not return every cab in the year because one of the two
 * words matched. The score is the mean of the per-term bests, so a candidate
 * that matches both terms well beats one that matches one term perfectly and
 * the other barely.
 */
function scoreAll(terms: string[], fields: Array<[string, string]>): { score: number; matches: Match[] } | null {
  const matches: Match[] = []
  for (const term of terms) {
    const m = best(term, fields)
    if (!m) return null
    matches.push(m)
  }
  const score = matches.reduce((s, m) => s + m.strength, 0) / matches.length
  return { score, matches }
}

/** The searchable text of one cell, as a person would read it. */
export function cellText(value: CellValue, column: Column, currency: string): string {
  if (value == null || value === '') return ''
  if (Array.isArray(value)) return value.map((a) => a.name).join(' ')
  if (column.kind === 'amount' || column.kind === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return String(value)
    // Both the bare digits and the grouped form, so "1200" and "1,200" both hit.
    return `${n} ${formatMoney(n, currency, { symbol: false })}`
  }
  if (column.kind === 'date') {
    const raw = String(value)
    // The ISO form and the printed form, so "2025-10" and "Oct" both hit.
    return `${raw} ${formatDate(raw)}`
  }
  return String(value)
}

function fieldFor(kind: Column['kind']): string {
  if (kind === 'amount' || kind === 'number') return 'amount'
  if (kind === 'date') return 'date'
  return 'cell'
}

export type Context = {
  /** The folder the user is looking at, if any. */
  folderId?: string | null
  /** Restrict to that folder rather than merely preferring it. */
  scoped?: boolean
}

export function rankFolders(terms: string[], folders: FolderMeta[], ctx: Context): Hit[] {
  if (ctx.scoped) return [] // inside a folder, a list of folders is not an answer
  const out: Hit[] = []
  for (const f of folders) {
    const scored = scoreAll(terms, [['folder', f.name]])
    if (!scored) continue
    out.push({
      kind: 'folder',
      score: scored.score * (ctx.folderId === f.id ? NEAR_BOOST : 1),
      why: 'Folder name',
      id: f.id,
      name: f.name,
      icon: f.icon,
      color: f.color,
      fileCount: f.fileCount,
    })
  }
  return out
}

export function rankFiles(terms: string[], files: FileMeta[], folderName: (id: string) => string, ctx: Context): Hit[] {
  const out: Hit[] = []
  for (const f of files) {
    if (ctx.scoped && f.folderId !== ctx.folderId) continue
    const scored = scoreAll(terms, [
      ['file', f.name],
      // The folder's name is part of a file's address, so "goa cabs" can find
      // the Cabs file inside Goa without either word being in the file's name.
      ['cell', folderName(f.folderId)],
    ])
    if (!scored) continue
    out.push({
      kind: 'file',
      score: scored.score * (!ctx.scoped && ctx.folderId === f.folderId ? NEAR_BOOST : 1),
      why: scored.matches.some((m) => m.field === 'file') ? 'File name' : 'In this folder',
      id: f.id,
      name: f.name,
      folderId: f.folderId,
      folderName: folderName(f.folderId),
      total: f.total,
      currency: f.currency,
      rowCount: f.rowCount,
    })
  }
  return out
}

/**
 * A row's summary line: what it holds besides the two things already on screen.
 *
 * The amount and the title get their own places in the result, so repeating
 * them here spends the line saying "First row - First row" instead of showing
 * the caption that would tell you which of the four First rows this one is.
 */
function rowSnippet(doc: SheetDoc, row: Row, matched: Match[], titleId?: string): string {
  const wanted = new Set(matched.map((m) => m.text))
  const parts: string[] = []
  for (const col of doc.columns) {
    if (col.kind === 'amount' || col.id === titleId) continue
    const text = cellText(row.cells[col.id], col, doc.currency).trim()
    if (!text) continue
    if (wanted.has(text) || parts.length < 2) parts.push(text)
    if (parts.length >= 3) break
  }
  return parts.join(' · ')
}

export function rankRows(terms: string[], docs: SheetDoc[], folderName: (id: string) => string, ctx: Context): Hit[] {
  const out: Hit[] = []
  for (const doc of docs) {
    if (ctx.scoped && doc.folderId !== ctx.folderId) continue
    const titleCol = doc.columns.find((c) => c.system && c.kind === 'text') ?? doc.columns.find((c) => c.kind === 'text')
    const amountCol = doc.columns.find((c) => c.system && c.kind === 'amount') ?? doc.columns.find((c) => c.kind === 'amount')

    for (const row of doc.rows) {
      if (row.deleted) continue
      const fields: Array<[string, string]> = []
      for (const col of doc.columns) {
        const text = cellText(row.cells[col.id], col, doc.currency)
        if (!text) continue
        fields.push([col.id === titleCol?.id ? 'title' : fieldFor(col.kind), text])
      }
      // The file it lives in is part of the row's address too.
      fields.push(['cell', doc.name])
      const scored = scoreAll(terms, fields)
      if (!scored) continue

      const amount = amountCol ? Number(row.cells[amountCol.id] ?? 0) : 0
      out.push({
        kind: 'row',
        score: scored.score * (!ctx.scoped && ctx.folderId === doc.folderId ? NEAR_BOOST : 1),
        why: scored.matches[0]?.field === 'title' ? 'Row' : `In ${scored.matches[0]?.field ?? 'a cell'}`,
        fileId: doc.id,
        fileName: doc.name,
        folderId: doc.folderId,
        folderName: folderName(doc.folderId),
        rowId: row.id,
        title: titleCol ? String(row.cells[titleCol.id] ?? '') : '',
        amount: Number.isFinite(amount) ? amount : 0,
        currency: doc.currency,
        snippet: rowSnippet(doc, row, scored.matches, titleCol?.id),
      })
    }
  }
  return out
}

/**
 * One ranked list, highest first.
 *
 * Deliberately not grouped by kind. The whole point is that the best answer
 * wins whatever shape it happens to be, and a list sorted by type would answer
 * a different question - "what kinds of thing matched" rather than "what
 * matched best".
 */
export function mergeHits(groups: Hit[][], limit: number): Hit[] {
  return groups
    .flat()
    .sort((a, b) => b.score - a.score || keyOf(a).localeCompare(keyOf(b)))
    .slice(0, limit)
}

function keyOf(h: Hit): string {
  return h.kind === 'row' ? `${h.fileId}:${h.rowId}` : h.id
}
