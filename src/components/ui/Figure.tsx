'use client'

import { useState } from 'react'
import { compactMoney, formatMoney } from '@/lib/util/format'

/**
 * A money figure that is short until you look at it.
 *
 * Analytics has a genuine conflict in it. Four totals sitting side by side are
 * only comparable if they are short - "₹1.2L" against "₹94.3k" is a glance,
 * "₹1,20,450" against "₹94,310" is arithmetic. But a rounded figure is not the
 * figure, and this is the screen people open to find out what something cost.
 *
 * So the short form is what is on the page and the exact one is a hover away,
 * to the paisa. The exact figure comes up in place, over the short one, rather
 * than replacing it: swapping the text would reflow the tile every time the
 * pointer crossed it, and four tiles doing that is a page that will not sit
 * still.
 *
 * The gesture is not hover alone. It is also focus, so a keyboard reaches it,
 * and tap, so a phone does. `title` covers the rest.
 */
export function Figure({
  value,
  currency,
  align = 'left',
  className = '',
}: {
  value: number
  /** null or omitted when a selection spans currencies: the figure prints bare. */
  currency?: string | null
  /** Which edge the exact figure grows from. Right, for a right-aligned column. */
  align?: 'left' | 'right'
  className?: string
}) {
  const [open, setOpen] = useState(false)

  const code = currency || 'INR'
  const symbol = Boolean(currency)
  const short = compactMoney(value, code, { symbol })
  const plain = formatMoney(value, code, { symbol })
  const exact = formatMoney(value, code, { decimals: true, symbol })

  // Nothing was rounded away, so there is nothing to reveal and no reason to
  // dress the number up as something you can interact with.
  if (short === plain) return <span className={className}>{plain}</span>

  return (
    <span className={`relative inline-block ${className}`}>
      <span
        role="button"
        tabIndex={0}
        aria-label={`${short}, exactly ${exact}`}
        aria-expanded={open}
        title={exact}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
        className="cursor-help underline decoration-dotted decoration-from-font underline-offset-[3px] decoration-line outline-none rounded focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        {short}
      </span>
      {open && (
        <span
          aria-hidden
          className={`absolute -top-1 z-30 whitespace-nowrap rounded-lg border border-line bg-raised px-2 py-1 shadow-pop animate-fade ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${align === 'right' ? 'origin-right' : 'origin-left'}`}
        >
          {exact}
        </span>
      )}
    </span>
  )
}
