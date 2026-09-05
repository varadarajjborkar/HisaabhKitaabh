'use client'

import { useEffect, useRef } from 'react'

/**
 * One dismissal rule for every popover in the app.
 *
 * Menus used to each carry their own full-screen invisible backdrop. That works
 * for a single menu, but two of them stack: the account menu's backdrop sat on
 * top of the column menu, so the first click closed nothing visible and the
 * second click landed on the wrong thing. Worse, opening menu B while menu A
 * was open left A's backdrop underneath, and A never closed at all.
 *
 * A backdropless rule fixes both. `pointerdown` on the document closes anything
 * whose own element does not contain the event target, so opening a second menu
 * closes the first as a side effect of the click that opened it, and clicks on
 * the page behind reach their real target on the first press.
 *
 * `pointerdown` rather than `click`: a menu must be gone before the underlying
 * control activates, otherwise a text selection started inside the menu and
 * released outside would count as an outside click.
 */
export function useDismiss<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
  options: { escape?: boolean; ignore?: React.RefObject<HTMLElement | null> } = {},
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const { escape = true, ignore } = options

  useEffect(() => {
    if (!open) return

    const onPointer = (e: PointerEvent | MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (ref.current?.contains(target)) return
      if (ignore?.current?.contains(target)) return
      // A click that lands on a <dialog> backdrop reports the dialog itself as
      // the target; that dialog owns the interaction, so leave it alone.
      if (target instanceof Element && target.closest('dialog[open]') && !ref.current) return
      close.current()
    }

    const onKey = (e: KeyboardEvent) => {
      if (escape && e.key === 'Escape') {
        e.stopPropagation()
        close.current()
      }
    }

    // Capture phase so a menu item's own handler still runs first on the way
    // down but nothing can stop the dismissal from being seen.
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, escape, ignore])

  return ref
}
