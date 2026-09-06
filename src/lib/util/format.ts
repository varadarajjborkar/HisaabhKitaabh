/**
 * Money, written the way the currency is actually written.
 *
 * Two things vary and they vary independently. The symbol is obvious. The
 * grouping is not: the subcontinent groups the last three digits and then in
 * pairs - 12,34,567 - while most of the world groups in threes throughout. A
 * file kept in dirhams showing 12,34,567 would be as wrong as one in rupees
 * showing 1,234,567, so the grouping follows the currency rather than the user.
 */

export type Currency = { code: string; symbol: string; name: string }

/**
 * What the column picker offers. Ordered by who is likely to reach for it here
 * rather than alphabetically, which would bury the rupee under the Australian
 * dollar. Any three-letter code is still valid - this list is a shortcut, not a
 * whitelist.
 */
export const CURRENCIES: Currency[] = [
  { code: 'INR', symbol: '₹', name: 'Indian rupee' },
  { code: 'USD', symbol: '$', name: 'US dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'Pound sterling' },
  { code: 'AED', symbol: 'د.إ', name: 'UAE dirham' },
  { code: 'SAR', symbol: '﷼', name: 'Saudi riyal' },
  { code: 'SGD', symbol: 'S$', name: 'Singapore dollar' },
  { code: 'AUD', symbol: 'A$', name: 'Australian dollar' },
  { code: 'CAD', symbol: 'C$', name: 'Canadian dollar' },
  { code: 'JPY', symbol: '¥', name: 'Japanese yen' },
  { code: 'CNY', symbol: '¥', name: 'Chinese yuan' },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss franc' },
  { code: 'NPR', symbol: 'रु', name: 'Nepalese rupee' },
  { code: 'PKR', symbol: '₨', name: 'Pakistani rupee' },
  { code: 'BDT', symbol: '৳', name: 'Bangladeshi taka' },
  { code: 'LKR', symbol: 'Rs', name: 'Sri Lankan rupee' },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian ringgit' },
  { code: 'THB', symbol: '฿', name: 'Thai baht' },
  { code: 'ZAR', symbol: 'R', name: 'South African rand' },
]

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]))

/** Currencies whose speakers count in lakhs and crores. */
const INDIAN_GROUPING = new Set(['INR', 'PKR', 'NPR', 'LKR', 'BDT'])

/** The symbol if we know one, otherwise the code itself, which always reads. */
export function currencySymbol(code = 'INR'): string {
  return BY_CODE.get(code.toUpperCase())?.symbol ?? code.toUpperCase()
}

export function currencyName(code = 'INR'): string {
  return BY_CODE.get(code.toUpperCase())?.name ?? code.toUpperCase()
}

function group(whole: string, indian: boolean): string {
  if (!indian) return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  if (whole.length <= 3) return whole
  const head = whole.slice(0, whole.length - 3)
  const tail = whole.slice(-3)
  return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail
}

export function formatMoney(
  amount: number,
  currency = 'INR',
  opts: { decimals?: boolean; symbol?: boolean } = {},
): string {
  const { decimals = Math.abs(amount % 1) > 0.001, symbol = true } = opts
  const code = (currency || 'INR').toUpperCase()
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  const [whole, frac] = abs.toFixed(decimals ? 2 : 0).split('.')
  const grouped = group(whole, INDIAN_GROUPING.has(code))
  // A multi-character symbol needs air; "$450" is right and "CHF450" is not.
  const sym = symbol ? currencySymbol(code) : ''
  const gap = sym.length > 1 ? ' ' : ''
  return `${sign}${sym}${gap}${grouped}${frac ? '.' + frac : ''}`
}

/**
 * A figure shortened to fit: 1,20,450 becomes 1.2L.
 *
 * Rounding a total is a real loss, so nothing in the interface shows one of
 * these on its own - every call site pairs it with the exact figure, on hover
 * or in a tooltip. Short enough to scan, one gesture away from the truth.
 */
export function compactMoney(amount: number, currency = 'INR', opts: { symbol?: boolean } = {}): string {
  const { symbol = true } = opts
  const code = (currency || 'INR').toUpperCase()
  const abs = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''
  const sym = symbol ? currencySymbol(code) : ''
  const gap = sym.length > 1 ? ' ' : ''
  const head = `${sign}${sym}${gap}`

  if (INDIAN_GROUPING.has(code)) {
    if (abs >= 1e7) return `${head}${(abs / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`
    if (abs >= 1e5) return `${head}${(abs / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`
  } else {
    if (abs >= 1e9) return `${head}${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`
    if (abs >= 1e6) return `${head}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  }
  if (abs >= 1e3) return `${head}${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return formatMoney(amount, code, { decimals: false, symbol })
}

/** Indian digit grouping: ₹12,34,567.89 - not ₹1,234,567.89. */
export function formatINR(amount: number, opts: { decimals?: boolean; symbol?: boolean } = {}): string {
  return formatMoney(amount, 'INR', opts)
}

export function compactINR(amount: number): string {
  return compactMoney(amount, 'INR')
}

export function formatDate(iso: string): string {
  if (!iso) return ''
  const parts = iso.split('-')
  if (parts.length === 2) {
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
    return d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
  }
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}
