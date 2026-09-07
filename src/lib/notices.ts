import { env } from './env'
import { K, kv } from './store/kv'
import type { Repo } from './store/repo'

/**
 * Things the app needs to tell an account about, unprompted.
 *
 * There is one source of these today - running out of room - and the shape is
 * built for there to be more later. What it is not is a message feed. Nothing
 * is written when something happens and read back later; a notice is derived
 * from the account's current state every time it is asked for, which means it
 * cannot go stale, cannot be delivered twice, and disappears by itself the
 * moment the thing it was about stops being true. Deleting a folder full of
 * receipts clears the warning without anything having to remember to clear it.
 *
 * The only thing stored is how far the user has already been told, so the dot
 * on the bell goes out when they look and comes back when it gets worse rather
 * than when it merely stays bad.
 */

export type NoticeLevel = 'warning' | 'critical' | 'full'
export type NoticeAction = 'export' | 'empty' | 'feedback' | 'storage'

export type Notice = {
  id: string
  level: NoticeLevel
  title: string
  body: string
  actions: NoticeAction[]
  /** Present on storage notices, so the panel can draw the meter. */
  used?: number
  limit?: number
}

/*
 * Three quarters is early enough to be useful and late enough not to be noise.
 * A warning at half would arrive while there is still half a year of room in
 * the account, and the only thing a person learns from a warning that early is
 * to ignore the next one.
 */
const WARN_AT = 0.75
const CRITICAL_AT = 0.9

const RANK: Record<NoticeLevel, number> = { warning: 1, critical: 2, full: 3 }

/** Exported so the thresholds can be tested at their boundaries, where they matter. */
export function storageNoticeLevel(used: number, limit: number): NoticeLevel | null {
  if (limit <= 0) return null
  const share = used / limit
  if (share >= 1) return 'full'
  if (share >= CRITICAL_AT) return 'critical'
  if (share >= WARN_AT) return 'warning'
  return null
}

function mb(bytes: number): string {
  const m = bytes / (1024 * 1024)
  return `${m >= 10 ? Math.round(m) : m.toFixed(1)} MB`
}

/**
 * What this account should be told right now.
 *
 * Drive-backed accounts get nothing from here: their room is Google's problem
 * and Google already tells them about it, and a second app warning them about
 * a quota it does not control would be noise pretending to be help.
 */
export async function noticesFor(repo: Repo): Promise<Notice[]> {
  const info = await repo.storageInfo().catch(() => null)
  if (!info || info.backend !== 'App storage') return []
  if (info.used === undefined || !info.limit) return []

  const level = storageNoticeLevel(info.used, info.limit)
  if (!level) return []

  const left = Math.max(0, info.limit - info.used)
  const actions: NoticeAction[] = ['export', 'empty']
  if (env.feedback.enabled) actions.push('feedback')

  return [
    {
      id: 'storage',
      level,
      title:
        level === 'full'
          ? 'Your storage is full'
          : level === 'critical'
            ? 'Your storage is nearly full'
            : 'Your storage is filling up',
      body:
        level === 'full'
          ? `You have used all ${mb(info.limit)} of this account's space, so new receipts will not upload until some room is freed. Everything already here is safe and still readable.`
          : `You have used ${mb(info.used)} of ${mb(info.limit)}, with ${mb(left)} left. Receipts are what fills this up; sheets themselves take almost nothing.`,
      actions,
      used: info.used,
      limit: info.limit,
    },
  ]
}

/** The highest level this account has already looked at, if any. */
export async function seenLevel(userId: string): Promise<NoticeLevel | null> {
  return kv().get<NoticeLevel>(K.noticesSeen(userId))
}

/**
 * Whether the bell should carry a dot.
 *
 * A notice counts as unseen if it is worse than the worst one already
 * acknowledged. Marking "filling up" as read is not consent to be quiet about
 * "full" later, and being told twice about the same threshold is how a person
 * learns to stop opening the panel.
 */
export function unseenAmong(notices: Notice[], seen: NoticeLevel | null): boolean {
  if (notices.length === 0) return false
  const worst = Math.max(...notices.map((n) => RANK[n.level]))
  return worst > (seen ? RANK[seen] : 0)
}

export async function markSeen(userId: string, notices: Notice[]): Promise<void> {
  if (notices.length === 0) {
    await kv().del(K.noticesSeen(userId))
    return
  }
  const worst = notices.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a))
  await kv().set(K.noticesSeen(userId), worst.level)
}
