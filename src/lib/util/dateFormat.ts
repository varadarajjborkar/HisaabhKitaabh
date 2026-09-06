/**
 * How dates are written.
 *
 * There is no correct answer here, only a local one: 06-09-2026 is the sixth
 * of September to most of the world and the ninth of June in the United
 * States, and neither reading is wrong. A ledger that guesses will be
 * misread by somebody, so the format is a setting.
 *
 * The tokens are the ones people already recognise from spreadsheets, which
 * makes the setting readable without a legend: dd is the day, mm the month as
 * digits, mmm the month as a word, yyyy the full year, yy the last two.
 * Anything not a token passes through, so a pattern can use dashes, slashes,
 * dots or spaces without this needing to know about any of them.
 */

export const DATE_FORMATS = [
  { value: 'dd-mm-yyyy', label: '06-09-2026', hint: 'Day first' },
  { value: 'dd/mm/yyyy', label: '06/09/2026', hint: 'Day first, slashes' },
  { value: 'mm-dd-yyyy', label: '09-06-2026', hint: 'Month first' },
  { value: 'mm/dd/yyyy', label: '09/06/2026', hint: 'Month first, slashes' },
  { value: 'yyyy-mm-dd', label: '2026-09-06', hint: 'Sorts alphabetically' },
  { value: 'dd-mm-yy', label: '06-09-26', hint: 'Short year' },
  { value: 'dd mmm yyyy', label: '06 Sep 2026', hint: 'Month in words' },
  { value: 'mmm dd, yyyy', label: 'Sep 06, 2026', hint: 'Month in words, US' },
  { value: 'd mmm yyyy', label: '6 Sep 2026', hint: 'No leading zero' },
] as const

export type DateFormat = (typeof DATE_FORMATS)[number]['value']
export const DEFAULT_DATE_FORMAT: DateFormat = 'dd-mm-yyyy'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function isDateFormat(value: unknown): value is DateFormat {
  return typeof value === 'string' && DATE_FORMATS.some((f) => f.value === value)
}

/**
 * A pattern applied to a date.
 *
 * Longest token first, so "mmm" is not consumed as "mm" followed by a stray
 * "m", and "yyyy" is not read as two "yy".
 */
export function applyDateFormat(date: Date, format: DateFormat | string): string {
  if (Number.isNaN(date.getTime())) return ''
  const day = date.getDate()
  const month = date.getMonth()
  const year = date.getFullYear()

  return format.replace(/yyyy|yy|mmmm|mmm|mm|m|dd|d/g, (token) => {
    switch (token) {
      case 'yyyy': return String(year)
      case 'yy': return String(year % 100).padStart(2, '0')
      case 'mmmm': return new Date(year, month, 1).toLocaleString('en', { month: 'long' })
      case 'mmm': return MONTHS[month]
      case 'mm': return String(month + 1).padStart(2, '0')
      case 'm': return String(month + 1)
      case 'dd': return String(day).padStart(2, '0')
      case 'd': return String(day)
      default: return token
    }
  })
}

/** An ISO day, or a "YYYY-MM" month, in the user's format. */
export function formatIsoDate(iso: string, format: DateFormat | string): string {
  if (!iso) return ''
  const parts = iso.split('-')
  if (parts.length === 2) {
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en', { month: 'short', year: 'numeric' })
  }
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : applyDateFormat(d, format)
}

/** A timestamp in the user's format. */
export function formatStamp(ts: number, format: DateFormat | string): string {
  return applyDateFormat(new Date(ts), format)
}

/**
 * The format the model is allowed to set, from whatever the user said.
 *
 * "day first", "dd-mm-yyyy" and "the one with the month spelled out" all have
 * to land on a real pattern, because the assistant is offered as the easy way
 * to change this and an easy way that only accepts exact strings is not one.
 */
export function resolveDateFormat(request: string): DateFormat | null {
  const text = request.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!text) return null

  const exact = DATE_FORMATS.find((f) => f.value === text)
  if (exact) return exact.value
  // A worked example is a legitimate way to ask: "like 06 Sep 2026".
  const sample = DATE_FORMATS.find((f) => f.label.toLowerCase() === text)
  if (sample) return sample.value

  // A pattern with separators this list does not carry, e.g. "dd.mm.yyyy".
  const pattern = /^[dmy]{1,4}([^dmy])[dmy]{1,4}\1?[dmy]{0,4}$/.test(text)
  if (pattern) {
    const order = text.replace(/[^dmy]/g, '')
    const slash = text.includes('/')
    if (order.startsWith('y')) return 'yyyy-mm-dd'
    if (order.startsWith('m')) return slash ? 'mm/dd/yyyy' : 'mm-dd-yyyy'
    return text.endsWith('yy') && !text.endsWith('yyyy') ? 'dd-mm-yy' : slash ? 'dd/mm/yyyy' : 'dd-mm-yyyy'
  }

  /*
   * Only phrases that actually name something count.
   *
   * An earlier version treated any run of letters as "spell the month out",
   * which meant "gibberish here" resolved to a real format and got applied.
   * Silence is the right answer to a request nobody can read: the caller lists
   * the options instead of guessing.
   */
  const has = (...words: string[]) => words.some((w) => text.includes(w))

  const wordy = has('word', 'spell', 'letters', 'name of the month', 'written out', 'sep', 'jan')
  const american = has('american', 'us style', 'us format', 'united states', 'month first', 'month-first')
  const iso = has('iso', 'sorts', 'sortable', 'year first', 'year-first')
  const dayFirst = has('day first', 'day-first', 'indian', 'british', 'uk', 'european', 'normal way')
  const shortYear = has('short year', 'two digit year', '2 digit year', 'yy')
  const slashes = has('slash', '/')

  if (iso) return 'yyyy-mm-dd'
  if (wordy) return american ? 'mmm dd, yyyy' : 'dd mmm yyyy'
  if (american) return slashes ? 'mm/dd/yyyy' : 'mm-dd-yyyy'
  if (shortYear) return 'dd-mm-yy'
  if (dayFirst) return slashes ? 'dd/mm/yyyy' : 'dd-mm-yyyy'
  return null
}
