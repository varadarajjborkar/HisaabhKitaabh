/** Indian digit grouping: ₹12,34,567.89 - not ₹1,234,567.89. */
export function formatINR(amount: number, opts: { decimals?: boolean; symbol?: boolean } = {}): string {
  const { decimals = Math.abs(amount % 1) > 0.001, symbol = true } = opts
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  const fixed = abs.toFixed(decimals ? 2 : 0)
  const [whole, frac] = fixed.split('.')

  let grouped: string
  if (whole.length <= 3) {
    grouped = whole
  } else {
    const head = whole.slice(0, whole.length - 3)
    const tail = whole.slice(-3)
    grouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail
  }
  return `${sign}${symbol ? '₹' : ''}${grouped}${frac ? '.' + frac : ''}`
}

export function compactINR(amount: number): string {
  const abs = Math.abs(amount)
  const sign = amount < 0 ? '-' : ''
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return formatINR(amount, { decimals: false })
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
