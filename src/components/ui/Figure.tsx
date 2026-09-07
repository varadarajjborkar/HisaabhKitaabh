import { compactMoney, formatMoney } from '@/lib/util/format'

/**
 * A money figure that is short until you look at it.
 *
 * Analytics has a genuine conflict in it. Four totals sitting side by side are
 * only comparable if they are short - "₹1.2L" against "₹94.3k" is a glance,
 * "₹1,20,450" against "₹94,310" is arithmetic. But a rounded figure is not the
 * figure, and this is the screen people open to find out what something cost.
 *
 * So the short form is on the page and the pointer swaps it for the exact one,
 * to the paisa, for as long as it rests there. The swap is two spans and a CSS
 * rule: no state, no re-render, no transition to sit through. It happens on the
 * same frame the pointer arrives, which is the only thing that makes a gesture
 * this small feel worth making.
 *
 * There is no popover. A panel floating over the number has to be positioned,
 * kept inside the viewport and animated in, and every one of those is a way for
 * it to end up somewhere the pointer is not. Replacing the text in place cannot
 * miss.
 *
 * Not a tab stop. A screen reader is read the exact figure and never the
 * rounded one, and a keyboard without one has the table under the charts, where
 * every number is already printed in full.
 */
export function Figure({
  value,
  currency,
  className = '',
}: {
  value: number
  /** null or omitted when a selection spans currencies: the figure prints bare. */
  currency?: string | null
  className?: string
}) {
  const code = currency || 'INR'
  const symbol = Boolean(currency)
  const short = compactMoney(value, code, { symbol })
  const plain = formatMoney(value, code, { symbol })
  const exact = formatMoney(value, code, { decimals: true, symbol })

  // Nothing was rounded away, so there is nothing to reveal and no reason to
  // dress the number up as something you can interact with.
  if (short === plain) return <span className={className}>{plain}</span>

  return (
    /*
     * A named group, because the bar rows are themselves `group` and a bare
     * `group-hover` is a descendant selector: hovering anywhere on the row
     * would expand a figure the pointer never went near.
     */
    <span data-figure className={`group/fig cursor-help ${className}`}>
      <span aria-hidden className="group-hover/fig:hidden">{short}</span>
      <span aria-hidden className="hidden group-hover/fig:inline">{exact}</span>
      <span className="sr-only">{exact}</span>
    </span>
  )
}
