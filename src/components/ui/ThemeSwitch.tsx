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

/** How long a press has to be held before it stops being a tap. */
const LONG_PRESS_MS = 380
/** Vertical travel worth one card. Matches the cards' own pitch: 42 high, 6 apart. */
const CARD_STEP = 48
/** Below this, a release is a tap on an open picker rather than a drag-select. */
const DRAG_SLOP = 6

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * The same preference as a single button, for surfaces with no account menu.
 *
 * Two gestures on one control. A tap cycles light, dark, system, which is fast
 * and needs no aiming - the tooltip names the *next* state so the tap is
 * predictable rather than a guess. Holding it opens the three as a stack you
 * can swipe through and release on, which is what you want when you know
 * exactly which one you are after and do not fancy tapping twice to reach it.
 *
 * The stack tracks the thumb continuously rather than jumping a whole card at
 * a time: the position it is driven by is fractional, and only the release
 * rounds it. A control that snaps between three states while you are still
 * moving feels like it is arguing with you, and there is no way to tell a
 * gesture that is being ignored from one that has not been noticed yet.
 *
 * Depth carries the selection, so the option under your thumb is the one facing
 * you and the choice survives being looked at in either theme. Anyone who has
 * asked for reduced motion gets the same stack laid flat.
 */
export function ThemeCycleButton({ className = '' }: { className?: string }) {
  const [mode, setMode] = useThemeMode()
  const [open, setOpen] = useState(false)
  /** Fractional position in the stack. Whole numbers are cards; the rest is thumb. */
  const [pos, setPos] = useState(0)
  /** A pointer is driving the stack right now, so it should not also animate. */
  const [live, setLive] = useState(false)
  const [flat, setFlat] = useState(false)

  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const origin = useRef<{ y: number; index: number } | null>(null)
  const dragging = useRef(false)
  const longPressed = useRef(false)

  const index = Math.max(0, OPTIONS.findIndex((o) => o.value === mode))
  const highlight = clamp(Math.round(pos), 0, OPTIONS.length - 1)
  const next: ThemeMode = OPTIONS[(index + 1) % OPTIONS.length].value
  const Glyph = mode === 'light' ? Icon.Sun : mode === 'dark' ? Icon.Moon : Icon.Monitor

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
  }

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    longPressed.current = false
    dragging.current = false
    origin.current = { y: e.clientY, index }
    // Both of these have to be read now. React clears currentTarget once the
    // handler returns, so reaching for it inside the timeout below finds null -
    // and without the capture, the first swipe past the button's 36 pixels
    // stops delivering moves and the gesture dies halfway through.
    const el = e.currentTarget
    const pointerId = e.pointerId
    clearTimer()
    timer.current = setTimeout(() => {
      longPressed.current = true
      setPos(index)
      setLive(true)
      setOpen(true)
      try { el.setPointerCapture(pointerId) } catch { /* not fatal */ }
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!origin.current) return
    const dy = e.clientY - origin.current.y
    // A press that turns into a scroll should not also become a long press.
    if (!longPressed.current) {
      if (Math.abs(dy) > DRAG_SLOP) clearTimer()
      return
    }
    if (Math.abs(dy) > DRAG_SLOP) dragging.current = true
    setPos(clamp(origin.current.index + dy / CARD_STEP, 0, OPTIONS.length - 1))
  }

  const onPointerUp = () => {
    clearTimer()
    // Released after actually swiping: commit what is under the thumb. Released
    // without moving: leave the stack open so it can be tapped instead.
    if (longPressed.current && dragging.current) {
      setMode(OPTIONS[highlight].value)
      close()
    } else {
      setLive(false)
      setPos(highlight)
    }
    origin.current = null
    dragging.current = false
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
    // The stack is worth reaching without a pointer, so the arrows open it and
    // walk it. Enter takes what is showing; a tap alone would only ever cycle.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const from = open ? highlight : index
      setPos(clamp(from + (e.key === 'ArrowDown' ? 1 : -1), 0, OPTIONS.length - 1))
      setLive(false)
      setOpen(true)
      longPressed.current = true
      return
    }
    if (open && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      setMode(OPTIONS[highlight].value)
      close()
    }
  }

  return (
    // The caller's classes go on the outer element and nothing else does: a
    // `relative` of our own here would quietly outrank an `absolute` passed in,
    // since the two land in that order in the stylesheet and the later one wins
    // whatever the class attribute says. The inner box is what the stack hangs
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
          className="h-9 w-9 grid place-items-center rounded-lg border border-line bg-surface/70 backdrop-blur
                     text-muted hover:text-ink hover:bg-raised transition-colors pressable touch-none select-none"
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
            aria-activedescendant={`theme-card-${OPTIONS[highlight].value}`}
            className="absolute right-0 top-full mt-2 z-50 w-[132px] animate-scale-in origin-top-right"
            style={{ perspective: flat ? undefined : '760px' }}
          >
            {OPTIONS.map(({ value, label, icon: Item }, i) => {
              const d = i - pos
              const on = i === highlight
              const style = flat
                ? undefined
                : {
                    transform: `translateZ(${-Math.abs(d) * 58}px) rotateX(${d * -20}deg)`,
                    opacity: Math.max(0.45, 1 - Math.abs(d) * 0.3),
                  }
              return (
                <div
                  key={value}
                  id={`theme-card-${value}`}
                  role="option"
                  aria-selected={mode === value}
                  onClick={() => { setMode(value); close() }}
                  onPointerEnter={() => { if (!live) setPos(i) }}
                  className={`h-[42px] mb-1.5 rounded-lg border grid grid-cols-[auto_1fr] items-center gap-2 px-3
                              cursor-pointer select-none ${
                                // Following a thumb means following it exactly; the
                                // easing is for the jumps a thumb is not making.
                                live ? 'transition-none' : 'transition-all duration-200'
                              } ${
                                on
                                  ? 'bg-surface border-accent/50 text-accent shadow-pop'
                                  : 'bg-raised border-line text-muted'
                              }`}
                  style={{ ...style, transformStyle: flat ? undefined : 'preserve-3d' }}
                >
                  <Item size={15} />
                  <span className="text-[12.5px]">{label}</span>
                </div>
              )
            })}
            <p className="text-[10.5px] text-faint text-center mt-1 leading-snug">Swipe and release</p>
          </div>
        )}
      </div>
    </div>
  )
}
