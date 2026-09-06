import type { SheetDoc } from '../model/types'
import { computeTotals, liveRows, numeric } from '../crdt/doc'
import { makeZip } from './zip'

/**
 * A spreadsheet, written by hand.
 *
 * An .xlsx file is a ZIP of XML parts, and this writes the smallest set Excel,
 * Numbers, LibreOffice and Sheets will all open: a content-type map, two
 * relationship files, a workbook, and one worksheet. There is no styling
 * beyond a number format for money and a bold header, because the point of
 * exporting to a spreadsheet is to do arithmetic in one, not to arrive
 * pre-decorated.
 *
 * What matters is that amounts land as *numbers*. A CSV export of "₹1,20,450"
 * arrives in a spreadsheet as text, and the first thing anyone does with an
 * export is sum a column - which silently returns zero. Here the cell holds
 * 120450 and carries a currency format, so the column adds up.
 */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

/** Two cell formats: bold for the header row, a currency pattern for money. */
function styles(currency: string): string {
  const symbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : ''
  // Indian grouping is a real number format, not a hack: #,##,##0 groups by
  // two after the first thousand, which is how a rupee figure is written.
  const pattern = currency === 'INR' ? `&quot;${symbol}&quot;#,##,##0` : `&quot;${symbol}&quot;#,##0.00`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="${pattern}"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
}

/** A1, B1 ... AA1. Column index is zero based. */
function ref(col: number, row: number): string {
  let name = ''
  let n = col
  do {
    name = String.fromCharCode(65 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return `${name}${row}`
}

type Cell = { v: string | number; style?: number }

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((cells, r) => {
      const inner = cells
        .map((cell, c) => {
          if (cell.v === '' || cell.v == null) return ''
          const at = ref(c, r + 1)
          const style = cell.style ? ` s="${cell.style}"` : ''
          return typeof cell.v === 'number' && isFinite(cell.v)
            ? `<c r="${at}"${style}><v>${cell.v}</v></c>`
            // inlineStr avoids a shared-string table, which is a second part,
            // a second index and a second thing to keep consistent.
            : `<c r="${at}"${style} t="inlineStr"><is><t xml:space="preserve">${esc(String(cell.v))}</t></is></c>`
        })
        .join('')
      return `<row r="${r + 1}">${inner}</row>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

function workbookXml(name: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
}

/** A sheet name Excel will accept: 31 characters, none of []:*?/\ */
function tabName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, '-').slice(0, 31).trim() || 'Sheet1'
}

/** One file as a workbook, ready to be written into an archive. */
export async function toXlsx(doc: SheetDoc): Promise<Uint8Array> {
  const columns = [...doc.columns].sort((a, b) => (a.order < b.order ? -1 : 1))
  const totals = computeTotals(doc)

  const header: Cell[] = columns.map((c) => ({ v: c.name, style: 1 }))
  const body: Cell[][] = liveRows(doc).map((row) =>
    columns.map((col): Cell => {
      const raw = row.cells[col.id]
      if (raw == null || raw === '') return { v: '' }
      if (Array.isArray(raw)) return { v: raw.map((a) => a.name).join('; ') }
      // Money and counts stay numeric so the column can be summed.
      if (col.kind === 'amount') return { v: numeric(raw), style: 2 }
      if (col.kind === 'number') return { v: numeric(raw) }
      return { v: String(raw) }
    }),
  )

  const firstText = columns.findIndex((c) => c.kind !== 'amount' && c.kind !== 'number')
  const footer: Cell[] = columns.map((col, i) =>
    col.kind === 'amount'
      ? { v: totals.byColumn[col.id] ?? totals.total, style: 2 }
      : i === firstText
        ? { v: 'TOTAL', style: 1 }
        : { v: '' },
  )

  const zip = await makeZip([
    { path: '[Content_Types].xml', data: CONTENT_TYPES },
    { path: '_rels/.rels', data: ROOT_RELS },
    { path: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { path: 'xl/workbook.xml', data: workbookXml(tabName(doc.name)) },
    { path: 'xl/styles.xml', data: styles(doc.currency || 'INR') },
    { path: 'xl/worksheets/sheet1.xml', data: sheetXml([header, ...body, [], footer]) },
  ])

  return new Uint8Array(await zip.arrayBuffer())
}
