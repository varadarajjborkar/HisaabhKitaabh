'use client'

import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons'
import { useDismiss } from '@/lib/client/useDismiss'
import { useThemeMode, type ThemeMode } from '@/lib/client/useThemeMode'

const OPTIONS: Array<{ value: ThemeMode; label: string; icon: (p: { size?: number }) => React.ReactElement }> = [
  { value: 'light', label: 'Light', icon: Icon.Sun },
  { value: 'dark', label: 'Dark', icon: Icon.Moon },
  { value: 'system', label: 'System', icon: Icon.Monitor },
]

/**
 * Light, dark, or whatever the machine says.
 *
 * A segmented control rather than a two-state switch, because "follow the
 * system" is the default and a toggle cannot express it: flipping a switch back
 * and forth would leave the user pinned to an explicit choice with no way back.
 */
export function ThemeSwitch({ className = '' }: { className?: string }) {
  const [mode, setMode] = useThemeMode()

  return (
    <div
      className={`grid grid-cols-3 gap-1 p-1 rounded-lg bg-raised border border-line ${className}`}
      role="radiogroup"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, icon: Glyph }) => {
        const active = mode === value
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            onClick={() => setMode(value)}
            className={`flex flex-col items-center justify-center gap-1 h-[46px] rounded-md text-[10.5px]
                        transition-colors pressable ${
                          active
                            ? 'bg-surface text-accent shadow-sm border border-line'
                            : 'text-muted hover:text-ink hover:bg-surface/60 border border-transparent'
                        }`}
          >
            <Glyph size={15} />
            {label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * How long a press has to be held before it stops being a tap.
 *
 * A deliberate tap is done inside about 150ms, so this leaves room to tell the
 * two apart without making the hold feel like it is waiting you out.
 */
const LONG_PRESS_MS = 290
/**
 * How far out from the button the options sit.
 *
 * Set by the gap between neighbours rather than by the reach: three spokes over
 * a quarter turn are 45 degrees apart, and at anything under about seventy the
 * two on the diagonal touch the moment one of them grows.
 */
const RADIUS = 76
/** Travel before a press counts as aiming at something rather than resting. */
const DEAD_ZONE = 22

/**
 * Where each option sits, as a direction out of the button.
 *
 * The button lives in a corner, so there is nowhere above it and nowhere to its
 * right to put anything. The three fan into the quarter that is actually there:
 * left, down-left, down. Reading them off is the same as pointing at them,
 * which is the whole reason for laying them out this way rather than stacking
 * them in a list the thumb has to travel down.
 */
const SQRT_HALF = Math.SQRT1_2
const SPOKES = [
  { ...OPTIONS[0], ux: -1, uy: 0 },
  { ...OPTIONS[1], ux: -SQRT_HALF, uy: SQRT_HALF },
  { ...OPTIONS[2], ux: 0, uy: 1 },
]

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * The same preference as a single button, for surfaces with no account menu.
 *
 * Two gestures on one control. A tap cycles light, dark, system, which is fast
 * and needs no aiming - the tooltip names the *next* state so the tap is
 * predictable rather than a guess. Holding it fans the three out of the corner,
 * and you choose by pointing: the option nearest the direction of your thumb is
 * the one that takes the release.
 *
 * Direction, not distance. A list would make the far option cost three times
 * the travel of the near one and would run off the edge of a screen this button
 * is pinned to the corner of. Aiming costs the same in every direction, and the
 * fan grows towards whatever it is being aimed at continuously, so half a
 * gesture looks like half a gesture rather than like being ignored.
 *
 * Anyone who has asked for reduced motion gets the same fan without the growth.
 */
export function ThemeCycleButton({ className = '' }: { className?: string }) {
  const [mode, setMode] = useThemeMode()
  const [open, setOpen] = useState(false)
  /** Where the thumb is, measured from the middle of the button. */
  const [aim, setAim] = useState<{ x: number; y: number } | null>(null)
  /** A pointer is driving the fan right now. */
  const [live, setLive] = useState(false)
  const [hover, setHover] = useState<number | null>(null)
  const [flat, setFlat] = useState(false)

  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const longPressed = useRef(false)

  const index = Math.max(0, OPTIONS.findIndex((o) => o.value === mode))
  const next: ThemeMode = OPTIONS[(index + 1) % OPTIONS.length].value
  const Glyph = mode === 'light' ? Icon.Sun : mode === 'dark' ? Icon.Moon : Icon.Monitor

  // How squarely the thumb is pointing at each option, 0 to 1. This is what the
  // fan is drawn from, so the growth tracks the aim instead of snapping when it
  // crosses a boundary.
  const reach = aim ? Math.hypot(aim.x, aim.y) : 0
  const aimed = SPOKES.map((s) =>
    aim && reach > 0 ? clamp((aim.x * s.ux + aim.y * s.uy) / reach, 0, 1) : 0,
  )
  const pointingAt = reach >= DEAD_ZONE ? aimed.indexOf(Math.max(...aimed)) : -1
  const highlight = live ? (pointingAt >= 0 ? pointingAt : index) : hover ?? index

  useEffect(() => {
    setFlat(window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [])

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  const close = () => {
    setOpen(false)
    setLive(false)
    setAim(null)
    setHover(null)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    longPressed.current = false
    // Measured from the middle of the button rather than from where the finger
    // landed on it, so a press that starts near an edge does not read as a
    // gesture already half-aimed at something.
    const box = e.currentTarget.getBoundingClientRect()
    origin.current = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
    // Both of these have to be read now. React clears currentTarget once the
    // handler returns, so reaching for it inside the timeout below finds null -
    // and without the capture, the first move past the button's 36 pixels stops
    // being delivered and the gesture dies halfway through.
    const el = e.currentTarget
    const pointerId = e.pointerId
    clearTimer()
    timer.current = setTimeout(() => {
      longPressed.current = true
      setAim(null)
      setLive(true)
      setOpen(true)
      try { el.setPointerCapture(pointerId) } catch { /* not fatal */ }
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!origin.current) return
    const v = { x: e.clientX - origin.current.x, y: e.clientY - origin.current.y }
    // A press that turns into a scroll should not also become a long press.
    if (!longPressed.current) {
      if (Math.hypot(v.x, v.y) > DEAD_ZONE) clearTimer()
      return
    }
    setAim(v)
  }

  const onPointerUp = () => {
    clearTimer()
    // Released while pointing at one: take it. Released without aiming
    // anywhere: leave the fan open so it can be tapped instead.
    if (longPressed.current && pointingAt >= 0) {
      setMode(SPOKES[pointingAt].value)
      close()
    } else {
      setLive(false)
      setAim(null)
    }
    origin.current = null
  }

  const onClick = () => {
    // The long press already did the work; do not also cycle underneath it.
    if (longPressed.current) {
      longPressed.current = false
      if (open) close()
      return
    }
    setMode(next)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Escape') return close()
    // The fan is worth reaching without a pointer, so the arrows open it and
    // walk it. Enter takes what is showing; a tap alone would only ever cycle.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setHover(clamp((open ? highlight : index) + (e.key === 'ArrowDown' ? 1 : -1), 0, SPOKES.length - 1))
      setLive(false)
      setOpen(true)
      longPressed.current = true
      return
    }
    if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      setMode(SPOKES[highlight].value)
      close()
    }
  }

  const span = 2 * (RADIUS + 20)

  return (
    // The caller's classes go on the outer element and nothing else does: a
    // `relative` of our own here would quietly outrank an `absolute` passed in,
    // since the two land in that order in the stylesheet and the later one wins
    // whatever the class attribute says. The inner box is what the fan hangs
    // off, so it is the one that has to be positioned.
    <div className={className}>
      <div className="relative" ref={ref}>
        <button
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          className={`relative z-10 h-9 w-9 grid place-items-center rounded-lg border bg-surface/70 backdrop-blur
                      transition-colors pressable touch-none select-none ${
                        open ? 'border-accent/50 text-accent' : 'border-line text-muted hover:text-ink hover:bg-raised'
                      }`}
          title={`Theme: ${mode}. Tap for ${next}, hold to pick.`}
          aria-label={`Colour theme, currently ${mode}. Tap to switch to ${next}, hold to choose.`}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <Glyph size={16} />
        </button>

        {open && (
          <div
            role="listbox"
            aria-label="Colour theme"
            aria-activedescendant={`theme-spoke-${SPOKES[highlight].value}`}
            className="absolute left-1/2 top-1/2 pointer-events-none"
            style={{ width: span, height: span, transform: 'translate(-50%, -50%)' }}
          >
            {/* The spokes, so the fan reads as three things attached to one
                thing rather than three loose buttons near a corner. */}
            <svg width={span} height={span} className="absolute inset-0" aria-hidden>
              {SPOKES.map((s, i) => (
                <line
                  key={s.value}
                  x1={span / 2 + s.ux * 22}
                  y1={span / 2 + s.uy * 22}
                  x2={span / 2 + s.ux * (RADIUS - 22)}
                  y2={span / 2 + s.uy * (RADIUS - 22)}
                  stroke={i === highlight ? 'rgb(var(--accent) / .55)' : 'rgb(var(--line))'}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                />
              ))}
            </svg>

            {SPOKES.map(({ value, label, icon: Item, ux, uy }, i) => {
              const on = i === highlight
              // Growth follows the aim, not the selection, so the fan leans
              // towards the thumb the whole way rather than at the boundary.
              const grow = flat ? 0 : live ? aimed[i] : on ? 1 : 0
              return (
                <div
                  key={value}
                  className="absolute left-1/2 top-1/2"
                  style={{ transform: `translate(-50%, -50%) translate(${ux * RADIUS}px, ${uy * RADIUS}px)` }}
                >
                  <div className={flat ? '' : 'animate-scale-in'} style={{ animationDelay: `${i * 45}ms` }}>
                    <div
                      id={`theme-spoke-${value}`}
                      role="option"
                      aria-selected={mode === value}
                      title={label}
                      aria-label={label}
                      onClick={() => { setMode(value); close() }}
                      onPointerEnter={() => { if (!live) setHover(i) }}
                      onPointerLeave={() => { if (!live) setHover(null) }}
                      className={`pointer-events-auto h-9 w-9 grid place-items-center rounded-lg border cursor-pointer
                                  select-none shadow-pop ${live ? 'transition-none' : 'transition-all duration-200'} ${
                                    on
                                      ? 'bg-surface border-accent/50 text-accent'
                                      : 'bg-raised border-line text-muted'
                                  }`}
                      style={{ transform: `scale(${1 + grow * 0.16})`, opacity: 0.6 + grow * 0.4 }}
                    >
                      <Item size={16} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
