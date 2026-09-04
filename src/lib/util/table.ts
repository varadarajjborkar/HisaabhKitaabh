/**
 * Delimited-text parsing for imports.
 *
 * Written by hand rather than pulled from a package: the surface we need is
 * small, and a dependency here would ship parsing code for a dozen dialects we
 * never see. Handles quoted fields, embedded newlines, escaped quotes, and
 * sniffed delimiters, which covers what banks and shops actually export.
 */

export type Table = { headers: string[]; rows: Array<Record<string, string>> }

export function parseDelimited(text: string, delimiter?: string): string[][] {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const delim = delimiter ?? sniffDelimiter(body)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i++ }
        else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === delim) { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 4000).split('\n').slice(0, 10)
  const candidates = [',', '\t', ';', '|']
  let best = ','
  let bestScore = -1
  for (const d of candidates) {
    const counts = sample.map((line) => line.split(d).length - 1)
    const nonZero = counts.filter((c) => c > 0)
    if (nonZero.length === 0) continue
    // A good delimiter appears a consistent number of times on every line.
    const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length
    const variance = nonZero.reduce((a, b) => a + (b - mean) ** 2, 0) / nonZero.length
    const score = mean - variance
    if (score > bestScore) { bestScore = score; best = d }
  }
  return best
}

export function parseTable(text: string, name = ''): Table {
  if (name.endsWith('.json') || text.trimStart().startsWith('[') || text.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(text)
      const list: unknown[] = Array.isArray(data) ? data : Array.isArray((data as { rows?: unknown[] }).rows) ? (data as { rows: unknown[] }).rows : [data]
      const objects = list.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      const headers = [...new Set(objects.flatMap((o) => Object.keys(o)))]
      return {
        headers,
        rows: objects.map((o) => Object.fromEntries(headers.map((h) => [h, o[h] == null ? '' : String(o[h])]))),
      }
    } catch {
      /* fall through to delimited */
    }
  }

  const grid = parseDelimited(text)
  if (grid.length === 0) return { headers: [], rows: [] }

  const headerRow = pickHeaderRow(grid)
  const headers = grid[headerRow].map((h, i) => h.trim() || `Column ${i + 1}`)
  const rows = grid.slice(headerRow + 1).map((cells) =>
    Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()])),
  )
  return { headers, rows }
}

/** Bank exports often carry a preamble; the header is the first mostly-text row. */
function pickHeaderRow(grid: string[][]): number {
  const width = Math.max(...grid.slice(0, 20).map((r) => r.length))
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const row = grid[i]
    if (row.length < Math.max(2, width - 1)) continue
    const textish = row.filter((c) => c.trim() && Number.isNaN(Number(c.replace(/[₹,\s]/g, '')))).length
    if (textish >= Math.ceil(row.length * 0.6)) return i
  }
  return 0
}

export function toDelimited(headers: string[], rows: string[][], delimiter = ','): string {
  const esc = (v: string) => (/["\n,\t;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  return [headers, ...rows].map((r) => r.map((c) => esc(c ?? '')).join(delimiter)).join('\n')
}
