'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Modal } from './ui/Modal'
import { Icon } from './ui/Icons'
import { get, post } from '@/lib/client/api'
import { toast } from './ui/Toast'
import type { StorageBackend } from '@/lib/model/types'

type StorageState = {
  backend: StorageBackend
  driveConnected: boolean
  driveAvailable: boolean
  storage: { backend: string; durable: boolean; used?: number; limit?: number; files?: number }
}

type MoveResult = {
  backend: StorageBackend
  needsAuth?: boolean
  authUrl?: string
  moved?: { folders: number; files: number; attachments: number; failures: string[] } | null
}

function size(bytes?: number): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Where your files live.
 *
 * Two honest options rather than a default that depends on which sign-in button
 * someone happened to press. The copy says what each one actually means for
 * them - who holds the data, what happens if they stop using the app - because
 * that is the only basis on which the choice can be made.
 *
 * Switching copies everything across and leaves the old copy where it was. That
 * is stated on the button, since "move my data" is a sentence people are right
 * to be nervous about.
 */
export function StorageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [state, setState] = useState<StorageState | null>(null)
  const [busy, setBusy] = useState<StorageBackend | null>(null)
  const router = useRouter()

  useEffect(() => {
    if (!open) return
    let live = true
    setState(null)
    get<StorageState>('/api/settings/storage')
      .then((s) => { if (live) setState(s) })
      .catch(() => { if (live) setState(null) })
    return () => { live = false }
  }, [open])

  const choose = async (backend: StorageBackend) => {
    if (!state || state.backend === backend || busy) return
    setBusy(backend)
    try {
      const res = await post<MoveResult>('/api/settings/storage', { backend })
      if (res.needsAuth && res.authUrl) {
        // Google has to be asked before anything can be copied there.
        window.location.href = res.authUrl
        return
      }
      const moved = res.moved
      if (moved && moved.failures.length > 0) {
        toast.warn(
          `Moved ${moved.files} of ${moved.files + moved.failures.length} files`,
          `${moved.failures.length} could not be copied and were left where they were.`,
        )
      } else if (moved) {
        toast.success(
          `Moved ${moved.files} ${moved.files === 1 ? 'file' : 'files'}`,
          moved.attachments > 0 ? `${moved.attachments} attachments came across too.` : undefined,
        )
      }
      onClose()
      router.refresh()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const current = state?.backend

  return (
    <Modal open={open} onClose={onClose} title="Where your files live" size="md">
      {!state ? (
        <div className="h-32 grid place-items-center text-muted"><Icon.Spinner /></div>
      ) : (
        <div className="space-y-2.5">
          <Option
            name="In this app"
            active={current === 'app'}
            busy={busy === 'app'}
            disabled={busy !== null}
            icon={<Icon.Folder size={16} />}
            onChoose={() => choose('app')}
            lines={[
              'Your account gets its own space in our database. Nothing to connect and nothing to set up.',
              current === 'app' && state.storage.used !== undefined
                ? `Using ${size(state.storage.used)}${state.storage.limit ? ` of ${size(state.storage.limit)}` : ''}${state.storage.files ? `, ${state.storage.files} attachments` : ''}.`
                : null,
              !state.storage.durable && current === 'app'
                ? 'This deployment has no database attached, so nothing here survives a restart.'
                : null,
            ]}
            warn={!state.storage.durable && current === 'app'}
          />

          <Option
            name="In my Google Drive"
            active={current === 'drive'}
            busy={busy === 'drive'}
            disabled={busy !== null || !state.driveAvailable}
            icon={<Icon.Drive size={16} />}
            onChoose={() => choose('drive')}
            lines={[
              'Files are written to a folder in your own Drive. You keep them if you ever stop using this app.',
              state.driveAvailable
                ? state.driveConnected ? 'Drive is connected.' : 'You will be asked to give access first. The app only ever sees files it created itself.'
                : 'Not available on this deployment.',
              current === 'drive' && state.storage.used !== undefined && state.storage.limit
                ? `Drive is ${Math.round((state.storage.used / state.storage.limit) * 100)}% full.`
                : null,
            ]}
          />

          <p className="text-[11.5px] text-faint leading-relaxed pt-1">
            Switching copies everything across and leaves the original where it
            is, so nothing is lost if the copy is interrupted. A big account can
            take a minute.
          </p>
        </div>
      )}
    </Modal>
  )
}

function Option({
  name, active, busy, disabled, icon, lines, onChoose, warn,
}: {
  name: string
  active: boolean
  busy: boolean
  disabled: boolean
  icon: React.ReactNode
  lines: Array<string | null | false>
  onChoose: () => void
  warn?: boolean
}) {
  return (
    <button
      onClick={onChoose}
      disabled={disabled || active}
      aria-pressed={active}
      className={`w-full text-left rounded-lg border p-3.5 transition-colors ${
        active ? 'border-accent/50 bg-accent-soft/50' : 'border-line bg-surface hover:bg-raised'
      } ${disabled && !active ? 'opacity-60' : ''} ${!active && !disabled ? 'pressable' : ''}`}
    >
      <span className="flex items-center gap-2">
        <span className={active ? 'text-accent' : 'text-muted'}>{icon}</span>
        <span className="text-[13.5px] font-medium">{name}</span>
        {active && <span className="chip h-5 px-1.5 text-[10px] ml-auto">in use</span>}
        {busy && <span className="ml-auto text-muted"><Icon.Spinner /></span>}
      </span>
      {lines.filter(Boolean).map((line, i) => (
        <span key={i} className={`block text-[12px] mt-1.5 leading-snug ${warn && i > 0 ? 'text-warn' : 'text-muted'}`}>
          {line}
        </span>
      ))}
    </button>
  )
}
