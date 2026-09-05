'use client'

import { useCallback, useRef, useState } from 'react'

/**
 * Drag to reorder, on a pointer rather than the HTML5 drag-and-drop API.
 *
 * HTML5 dragging is the obvious choice and the wrong one here. It does not fire
 * at all for touch, so the phone layout would have been left without the
 * feature; it fights text selection inside the editable cells the rows are made
 * of; and its drag image is a browser-rendered ghost that cannot be styled to
 * match the row it came from. Pointer events cover mouse, pen and touch with
 * one code path, and pointer capture means a fast drag that outruns the row
 * never loses the grab.
 *
 * The hook stays deliberately geometric: it reports which slot the pointer is
 * over and leaves every visual decision to the caller.
 */
export type DragReorder = {
  /** Index currently being dragged, or null. */
  from: number | null
  /** Insertion slot under the pointer, in the *current* list (0 .. length). */
  to: number | null
  /** Attach to the scrolling ancestor so a drag can reach off-screen rows. */
  containerRef: React.RefObject<HTMLElement | null>
  /** Spread onto the grip of row `index`. */
  handleProps: (index: number) => {
    onPointerDown: (e: React.PointerEvent) => void
    onPointerMove: (e: React.PointerEvent) => void
    onPointerUp: (e: React.PointerEvent) => void
    onPointerCancel: (e: React.PointerEvent) => void
    style: React.CSSProperties
  }
}

const EDGE = 48
const EDGE_STEP = 10

export function useDragReorder(onMove: (from: number, to: number) => void): DragReorder {
  const containerRef = useRef<HTMLElement | null>(null)
  const [from, setFrom] = useState<number | null>(null)
  const [to, setTo] = useState<number | null>(null)
  const active = useRef<number | null>(null)

  const slotUnder = useCallback((clientY: number): number => {
    const root = containerRef.current
    if (!root) return 0
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-drag-index]'))
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) return i
    }
    return items.length
  }, [])

  /** Keep dragging usable when the list is taller than its scroller. */
  const edgeScroll = useCallback((clientY: number) => {
    let el: HTMLElement | null = containerRef.current
    while (el && el.scrollHeight <= el.clientHeight) el = el.parentElement
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (clientY < rect.top + EDGE) el.scrollTop -= EDGE_STEP
    else if (clientY > rect.bottom - EDGE) el.scrollTop += EDGE_STEP
  }, [])

  const handleProps = useCallback((index: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* capture is a nicety */ }
      active.current = index
      setFrom(index)
      setTo(index)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (active.current === null) return
      e.preventDefault()
      edgeScroll(e.clientY)
      setTo(slotUnder(e.clientY))
    },
    onPointerUp: (e: React.PointerEvent) => {
      const start = active.current
      active.current = null
      if (start === null) return
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* already released */ }
      const slot = slotUnder(e.clientY)
      setFrom(null)
      setTo(null)
      // The slot is an insertion point in the list as it stands, which still
      // contains the dragged row. Anything below that row shifts up by one once
      // it is lifted out, so a downward move loses a place.
      const target = slot > start ? slot - 1 : slot
      if (target !== start) onMove(start, target)
    },
    onPointerCancel: () => {
      active.current = null
      setFrom(null)
      setTo(null)
    },
    // Without this the browser claims the gesture for scrolling on touch and
    // the drag never starts.
    style: { touchAction: 'none' as const, cursor: active.current === null ? 'grab' : 'grabbing' },
  }), [edgeScroll, onMove, slotUnder])

  return { from, to, containerRef, handleProps }
}

/** Which edge of row `index` should show the insertion line, if any. */
export function dropEdge(drag: DragReorder, index: number, count: number): 'above' | 'below' | null {
  if (drag.from === null || drag.to === null) return null
  if (drag.to === index && drag.from !== index) return 'above'
  if (drag.to >= count && index === count - 1 && drag.from !== index) return 'below'
  return null
}
