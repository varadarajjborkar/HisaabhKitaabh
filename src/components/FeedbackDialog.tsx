'use client'

import { useEffect, useRef, useState } from 'react'
import { Modal } from './ui/Modal'
import { Icon } from './ui/Icons'
import { toast } from './ui/Toast'
import { post } from '@/lib/client/api'

/**
 * Writing to whoever runs this.
 *
 * One field. Not a category dropdown, not a severity, not a title - this is a
 * deployment with one person behind it, and every extra control is a decision
 * asked of someone who only wanted to say that something is wrong.
 *
 * The account's email goes with the message and the form says so plainly rather
 * than attaching it quietly. It is the difference between a reply arriving and
 * a message that could not be answered, and someone who does not want their
 * address sent should get to know before they type.
 */
export function FeedbackDialog({
  open,
  onClose,
  topic = 'general',
  email,
}: {
  open: boolean
  onClose: () => void
  /** 'storage' when opened from the storage notice, so the subject line says so. */
  topic?: 'storage' | 'general'
  email: string
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setError('')
    // Straight into the field: there is nothing else on this screen to do.
    const t = setTimeout(() => box.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [open])

  const send = async () => {
    if (message.trim().length < 4) { setError('Say a little more than that.'); return }
    setBusy(true)
    setError('')
    try {
      await post('/api/feedback', { message: message.trim(), topic }, { quiet: true })
      toast.success('Message sent', 'You will hear back at your account address.')
      setMessage('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that just now.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={topic === 'storage' ? 'Ask for more space' : 'Send feedback'}
      description={
        topic === 'storage'
          ? 'Tell whoever runs this what you are using the app for and how much room you need.'
          : 'Anything that is broken, missing, or in the way.'
      }
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary pressable" onClick={() => void send()} disabled={busy || !message.trim()}>
            {busy ? <Icon.Spinner /> : <Icon.Send size={15} />}
            {busy ? 'Sending' : 'Send'}
          </button>
        </>
      }
    >
      <textarea
        ref={box}
        value={message}
        onChange={(e) => { setMessage(e.target.value); setError('') }}
        rows={6}
        maxLength={4000}
        className="input h-auto py-2.5 resize-y leading-relaxed"
        placeholder={
          topic === 'storage'
            ? 'For example: I photograph about thirty receipts a month and I have run out after four months.'
            : 'What happened, and what you expected instead.'
        }
        aria-label="Your message"
      />

      {error && (
        <p className="text-[12.5px] text-bad mt-2.5 flex items-start gap-1.5" role="alert">
          <Icon.Warning size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </p>
      )}

      <p className="text-[11.5px] text-faint mt-3 leading-relaxed">
        Sent with <span className="text-muted">{email}</span> and how much storage this
        account is using, so a reply can reach you and the numbers do not have to be
        asked for. Nothing from inside your files goes with it.
      </p>
    </Modal>
  )
}
