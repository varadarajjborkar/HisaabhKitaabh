'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Modal, ConfirmModal } from './ui/Modal'
import { Icon } from './ui/Icons'
import { toast } from './ui/Toast'
import { del, get, patch, post } from '@/lib/client/api'

type Profile = {
  id: string
  email: string
  name: string
  username: string
  phone: string
  picture: string
  provider: 'google' | 'password' | 'dev'
  createdAt: number
}

/** The longest side of a stored avatar. Enough for a 40px circle at 3x. */
const AVATAR_PX = 128

/**
 * Shrink an image in the browser before it is ever sent.
 *
 * A phone camera produces four megabytes and the account has a storage budget,
 * so the resize happens here rather than being paid for on the server and then
 * again on every page load. Square-cropped from the middle, because an avatar
 * is drawn in a circle and letterboxing it would put the person's face off to
 * one side.
 */
async function toAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_PX
  canvas.height = AVATAR_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not read that image')
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PX, AVATAR_PX)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.82)
}

/**
 * The account, as its owner sees it.
 *
 * Only the name is required, because it is the one thing the app has to print
 * somewhere. A handle, a phone number and a picture are slots people like
 * having and nothing here depends on - the phone number in particular is stored
 * and never used, which is worth saying out loud in the form rather than
 * implying that filling it in switches something on.
 *
 * The two destructive actions are deliberately different shapes. Emptying is
 * one confirmation; leaving asks the account's own name to be typed, because
 * "are you sure" is not a meaningful obstacle to a decision this final.
 */
export function ProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [phone, setPhone] = useState('')
  const [picture, setPicture] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [emptying, setEmptying] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setError('')
    void get<{ profile: Profile | null }>('/api/account').then((res) => {
      if (!res.profile) return
      setProfile(res.profile)
      setName(res.profile.name)
      setUsername(res.profile.username)
      setPhone(res.profile.phone)
      setPicture(res.profile.picture)
    })
  }, [open])

  const dirty =
    profile != null &&
    (name !== profile.name || username !== profile.username || phone !== profile.phone || picture !== profile.picture)

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await patch('/api/account', { name, username: username || null, phone: phone || null, picture: picture || null })
      toast.success('Profile saved')
      setProfile((p) => (p ? { ...p, name, username, phone, picture } : p))
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that')
    } finally {
      setBusy(false)
    }
  }

  const pickImage = async (file: File | undefined) => {
    if (!file) return
    try {
      setPicture(await toAvatar(file))
    } catch {
      toast.error('Could not read that image', 'Try a JPEG or a PNG.')
    }
  }

  const emptyAccount = async () => {
    const res = await post<{ folders: number }>('/api/account/empty')
    toast.success(`Cleared ${res.folders} folder${res.folders === 1 ? '' : 's'}`)
    onClose()
    router.refresh()
  }

  const closeAccount = async () => {
    await del('/api/account')
    router.push('/login')
    router.refresh()
  }

  const initial = (profile?.name || profile?.email || '?').trim().charAt(0).toUpperCase()

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Your account"
        description="Everything here except your name is optional."
        size="lg"
        footer={
          <>
            <button className="btn-ghost" onClick={onClose}>Close</button>
            <button className="btn-primary pressable" onClick={save} disabled={!dirty || busy || !name.trim()}>
              {busy ? <Icon.Spinner /> : 'Save changes'}
            </button>
          </>
        }
      >
        <div className="flex items-center gap-4">
          <div className="h-16 w-16 rounded-full bg-accent-soft text-accent grid place-items-center text-[22px]
                          font-semibold border border-line overflow-hidden shrink-0">
            {picture
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={picture} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              : initial}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap gap-1.5">
              <button className="btn-outline h-8 text-[12.5px] pressable" onClick={() => fileRef.current?.click()}>
                <Icon.Upload size={14} /> Choose a picture
              </button>
              {picture && (
                <button className="btn-ghost h-8 text-[12.5px]" onClick={() => setPicture('')}>Remove</button>
              )}
            </div>
            <p className="text-[11.5px] text-faint mt-1.5 leading-relaxed">
              Scaled to {AVATAR_PX}px square in your browser before it is sent, so it costs
              your account a few kilobytes rather than a few megabytes.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => { void pickImage(e.target.files?.[0]); e.target.value = '' }}
            />
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3 mt-5">
          <div>
            <label className="label" htmlFor="pf-name">Name</label>
            <input id="pf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor="pf-username">Username</label>
            <input
              id="pf-username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Optional"
              maxLength={24}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-faint mt-1">You can sign in with this as well as your email.</p>
          </div>
          <div>
            <label className="label" htmlFor="pf-email">Email</label>
            <input id="pf-email" className="input" value={profile?.email ?? ''} readOnly disabled />
            <p className="text-[11px] text-faint mt-1">
              {profile?.provider === 'google' ? 'Comes from your Google account.' : 'This is what your account is filed under.'}
            </p>
          </div>
          <div>
            <label className="label" htmlFor="pf-phone">Phone</label>
            <input
              id="pf-phone"
              className="input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Optional"
              maxLength={28}
              inputMode="tel"
            />
            <p className="text-[11px] text-faint mt-1">Stored, and nothing sends to it.</p>
          </div>
        </div>

        {error && (
          <p className="text-[12.5px] text-bad mt-3 flex items-center gap-1.5">
            <Icon.Warning size={14} /> {error}
          </p>
        )}

        <div className="mt-6 pt-5 border-t border-line">
          <p className="text-[11px] uppercase tracking-wide text-faint">Danger</p>

          <div className="flex items-start justify-between gap-3 mt-3">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Empty this account</p>
              <p className="text-[12px] text-muted mt-0.5 leading-relaxed">
                Every folder, file and row goes. The account, and everything on this page, stays.
              </p>
            </div>
            <button className="btn-outline h-8 text-[12.5px] text-bad border-bad/40 hover:bg-bad/10 pressable shrink-0"
                    onClick={() => setEmptying(true)}>
              Empty
            </button>
          </div>

          <div className="flex items-start justify-between gap-3 mt-4">
            <div className="min-w-0">
              <p className="text-[13px] font-medium">Delete this account</p>
              <p className="text-[12px] text-muted mt-0.5 leading-relaxed">
                The data and the account itself. There is no undo and no copy kept.
              </p>
            </div>
            <button className="btn-outline h-8 text-[12.5px] text-bad border-bad/40 hover:bg-bad/10 pressable shrink-0"
                    onClick={() => { setConfirmText(''); setLeaving(true) }}>
              Delete
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={emptying}
        onClose={() => setEmptying(false)}
        onConfirm={emptyAccount}
        title="Empty this account?"
        body="Every folder and every file inside them is deleted. Your account, your sign-in and this profile stay exactly as they are."
      />

      <Modal
        open={leaving}
        onClose={() => setLeaving(false)}
        title="Delete this account?"
        description="This removes your account and everything in it. It cannot be undone."
        footer={
          <>
            <button className="btn-ghost" onClick={() => setLeaving(false)}>Cancel</button>
            <button
              className="btn-primary bg-bad hover:bg-bad pressable"
              disabled={confirmText.trim().toLowerCase() !== (profile?.email ?? '').toLowerCase()}
              onClick={closeAccount}
            >
              Delete for good
            </button>
          </>
        }
      >
        <label className="label" htmlFor="pf-confirm">
          Type <span className="text-ink font-medium">{profile?.email}</span> to confirm
        </label>
        <input
          id="pf-confirm"
          className="input"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </Modal>
    </>
  )
}
