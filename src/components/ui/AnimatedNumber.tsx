'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * A number that counts to its new value instead of jumping.
 *
 * This is the one place a running total earns motion: when a row lands, the
 * total sliding to its new figure tells you *that it changed* and roughly by
 * how much, which a hard swap does not. Duration scales with the size of the
 * jump so a ₹40 correction doesn't animate as long as a ₹40,000 one - and a
 * first render never animates at all.
 */
export function AnimatedNumber({
  value,
  format,
  className,
  duration,
}: {
  value: number
  format: (n: number) => string
  className?: string
  duration?: number
}) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const frame = useRef<number>(0)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      from.current = value
      setShown(value)
      return
    }
    if (from.current === value) return

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value
      setShown(value)
      return
    }

    const start = performance.now()
    const origin = from.current
    const delta = value - origin
    const span = duration ?? Math.min(620, Math.max(240, Math.abs(delta) > 0 ? 240 + Math.log10(Math.abs(delta) + 1) * 90 : 240))

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / span)
      // Ease-out cubic: fast to begin, settling at the end.
      const eased = 1 - (1 - t) ** 3
      setShown(origin + delta * eased)
      if (t < 1) frame.current = requestAnimationFrame(tick)
      else from.current = value
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [value, duration])

  return <span className={className}>{format(shown)}</span>
}
