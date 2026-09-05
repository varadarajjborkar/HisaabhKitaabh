'use client'

import { useRef, useState } from 'react'

/**
 * File drop on any surface.
 *
 * Two details that a naive implementation gets wrong, both fixed here.
 *
 * First, `dragenter` and `dragleave` fire once for *every* element the pointer
 * crosses, not once per drop zone. A boolean set on enter and cleared on leave
 * therefore flickers off the instant the cursor moves from the container onto
 * one of its children. Counting enters against leaves keeps the state steady
 * until the pointer genuinely leaves the zone.
 *
 * Second, dragging text or a link also fires these events. Checking
 * `dataTransfer.types` for "Files" means highlighting a drop target only when
 * something droppable is actually in flight.
 */
export function useFileDrop(onFiles: (files: File[]) => void, options: { max?: number } = {}) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const max = options.max ?? 4

  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

  return {
    over,
    handlers: {
      onDragEnter: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current++
        setOver(true)
      },
      onDragOver: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        depth.current = 0
        setOver(false)
        const files = Array.from(e.dataTransfer.files).slice(0, max)
        if (files.length) onFiles(files)
      },
    },
  }
}
