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

  /*
   * A closed modal is not in the document at all.
   *
   * Leaving it mounted meant a page could carry eight hidden <dialog> elements,
   * and any id inside one of them existed several times over: three copies of
   * `#col-name` once the add-column form could be opened from the table header,
   * the columns manager and the phone toolbar. A selector for that id then
   * resolved to whichever hidden copy came first in the DOM. Duplicate ids also
   * break the label-to-field association they exist for.
   *
   * Unmounting has a second benefit: every form inside a modal now starts
   * clean, instead of remembering what was typed the last time it was open.
   */
  if (!open) return null

  return (
    <dialog
      ref={ref}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      /*
       * `hidden open:flex`, not plain `flex`.
       *
       * The UA stylesheet hides a closed dialog with `dialog:not([open])
       * { display: none }`, but cascade *origin* outranks specificity: any
       * author-level `display: flex` beats it. A bare `flex` here left every
       * closed modal as a full-viewport, invisible element that swallowed every
       * click on the page behind it.
       */
      className={`hidden open:flex backdrop:bg-black/45 backdrop:backdrop-blur-[2px]
                  bg-transparent p-0 m-0 w-full h-full max-w-none max-h-none
                  items-end sm:items-center justify-center`}
    >
      {/*
        * `text-left normal-case tracking-normal font-normal` is not belt and
        * braces. A <dialog> sits in the top layer but still inherits from its
        * DOM parent, and the "add a column" dialog is mounted inside a <th>,
        * whose UA style is `text-align: center`. Every line of that dialog came
        * out centred. Resetting the inherited text properties here means a
        * modal looks the same wherever it happens to be rendered from.
        */}
      <div className={`card shadow-pop w-full ${width} max-h-[88dvh] flex flex-col animate-rise
                       text-left normal-case tracking-normal font-normal
                       rounded-b-none sm:rounded-b-xl2`}>
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
