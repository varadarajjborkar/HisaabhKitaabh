'use client'

import { useEffect, useRef } from 'react'
import { Icon } from './Icons'

/**
 * Dialog built on <dialog>, so focus trapping, Esc, and the top layer come from
 * the platform rather than from a thousand lines of focus-management code.
 * On phones it docks to the bottom as a sheet; on desktop it centres.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onCancel = (e: Event) => { e.preventDefault(); onClose() }
    el.addEventListener('cancel', onCancel)
    return () => el.removeEventListener('cancel', onCancel)
  }, [onClose])

  const width = size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-md'

  return (
    <dialog
      ref={ref}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      className={`backdrop:bg-black/45 backdrop:backdrop-blur-[2px] bg-transparent p-0 m-0 w-full h-full max-w-none max-h-none
                  flex items-end sm:items-center justify-center`}
    >
      <div className={`card shadow-pop w-full ${width} max-h-[88vh] flex flex-col animate-rise
                       rounded-b-none sm:rounded-b-xl2 mb-0 sm:mb-0`}>
        <header className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-line">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
            {description && <p className="text-[12.5px] text-muted mt-1 leading-snug">{description}</p>}
          </div>
          <button onClick={onClose} className="btn-ghost h-8 w-8 px-0 shrink-0 -mr-1.5" aria-label="Close">
            <Icon.Close size={16} />
          </button>
        </header>
        <div className="px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {footer && <footer className="px-5 py-3.5 border-t border-line flex justify-end gap-2 bg-raised/50 rounded-b-xl2">{footer}</footer>}
      </div>
    </dialog>
  )
}

/** Confirm dialog for destructive actions. Never used for anything reversible. */
export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel = 'Delete',
  danger = true,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={() => { onConfirm(); onClose() }}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-[13.5px] text-muted leading-relaxed">{body}</p>
    </Modal>
  )
}
