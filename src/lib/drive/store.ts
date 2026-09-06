import type { AttachmentRef, FolderMeta, SheetDoc } from '../model/types'
import { K, kv } from '../store/kv'
import { withLock } from '../store/locks'
import { drive, type DriveFile } from './client'

/**
 * Document layout inside the user's Drive:
 *
 *   My Drive/
 *     HisaabhKitaabh/                  appProperties: hisaab=root
 *       _index.json                  appProperties: hisaab=index
 *       Groceries/                   appProperties: hisaab=folder, fid=<folderId>
 *         <fileId>.hisaab.json       appProperties: hisaab=sheet, sid=<fileId>
 *         attachments/               appProperties: hisaab=attachments
 *           <attachmentId>-name.pdf  appProperties: hisaab=attachment, aid=<id>
 *
 * Every object carries a `hisaabKey` in appProperties. That key - not the file
 * name, not the path - is the identity. Names can be edited by the user in
 * Drive without breaking anything, and duplicates are detectable by key.
 */

const ROOT_NAME = 'HisaabhKitaabh'
const SHEET_MIME = 'application/json'

type Resolved = { id: string; duplicates: string[] }

/** Cached key -> Drive id. Saves a `files.list` round-trip on the hot path. */
async function cachedId(userId: string, key: string): Promise<string | null> {
  return kv().get<string>(`drv:${userId}:${key}`)
}
async function cacheId(userId: string, key: string, id: string): Promise<void> {
  await kv().set(`drv:${userId}:${key}`, id, { ex: 60 * 60 * 12 })
}
async function forgetId(userId: string, key: string): Promise<void> {
  await kv().del(`drv:${userId}:${key}`)
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

/**
 * Find-or-create by hisaabKey, exactly once.
 *
 * This is the single choke point for object creation in Drive, and the reason
 * duplicate folders can't accumulate: the whole find-then-create sequence runs
 * under a per-key lock, so two concurrent requests for the same key produce one
 * object and both get its id. If duplicates already exist (created before this
 * code, or by a partial failure), the oldest wins and the rest are reported so
 * the caller can reconcile them.
 */
async function resolveOrCreate(
  userId: string,
  key: string,
  create: () => Promise<string>,
): Promise<Resolved> {
  const hit = await cachedId(userId, key)
  if (hit) return { id: hit, duplicates: [] }

  return withLock(`drv:${userId}:${key}`, async () => {
    const again = await cachedId(userId, key)
    if (again) return { id: again, duplicates: [] }

    const found = await drive.list(userId, `appProperties has { key='hisaabKey' and value='${esc(key)}' } and trashed=false`)
    if (found.length > 0) {
      // Oldest wins - `drive.list` orders by createdTime.
      const [winner, ...rest] = found
      await cacheId(userId, key, winner.id)
      return { id: winner.id, duplicates: rest.map((f) => f.id) }
    }

    const id = await create()
    await cacheId(userId, key, id)
    return { id, duplicates: [] }
  }, { ttlMs: 20_000, waitMs: 15_000 })
}

export async function rootFolderId(userId: string): Promise<string> {
  const { id, duplicates } = await resolveOrCreate(userId, 'root', () =>
    drive.createFolder(userId, ROOT_NAME, null, { hisaabKey: 'root', hisaab: 'root' }),
  )
  await reconcileDuplicates(userId, duplicates, 'root')
  return id
}

export async function folderDirId(userId: string, folder: FolderMeta): Promise<string> {
  const root = await rootFolderId(userId)
  const key = `folder:${folder.id}`
  const { id, duplicates } = await resolveOrCreate(userId, key, () =>
    drive.createFolder(userId, safeName(folder.name), root, { hisaabKey: key, hisaab: 'folder', fid: folder.id }),
  )
  await reconcileDuplicates(userId, duplicates, key)
  return id
}

async function attachmentsDirId(userId: string, folderId: string): Promise<string> {
  const parent = await resolveOrCreate(userId, `folder:${folderId}`, async () => {
    throw new Error('folder directory missing: create the folder first')
  })
  const key = `attachments:${folderId}`
  const { id, duplicates } = await resolveOrCreate(userId, key, () =>
    drive.createFolder(userId, 'attachments', parent.id, { hisaabKey: key, hisaab: 'attachments' }),
  )
  await reconcileDuplicates(userId, duplicates, key)
  return id
}

/**
 * Duplicate reconciliation.
 *
 * Extra objects sharing a hisaabKey are stamped as duplicates and trashed (not
 * hard-deleted) so nothing is ever irrecoverably lost - the user can restore
 * from Drive's own trash if a reconciliation was wrong.
 */
async function reconcileDuplicates(userId: string, ids: string[], key: string): Promise<void> {
  for (const id of ids) {
    try {
      await drive.updateMetadata(userId, id, {
        appProperties: { hisaabKey: `dup:${key}:${id}`, hisaabDuplicateOf: key },
        name: `(duplicate) ${key}`,
      })
      await drive.trash(userId, id)
    } catch {
      /* best effort; the winner is already chosen so reads stay correct */
    }
  }
}

// ------------------------------------------------------------------- indexing

export type DriveIndex = {
  folders: FolderMeta[]
  /** fileId -> { folderId, driveId, name, rev, updatedAt, rowCount, total } */
  files: Record<string, { folderId: string; driveId: string; name: string; rev: number; updatedAt: number; rowCount: number; total: number }>
  rev: number
  updatedAt: number
}

const EMPTY_INDEX: DriveIndex = { folders: [], files: {}, rev: 0, updatedAt: 0 }

async function indexFileId(userId: string): Promise<string> {
  const root = await rootFolderId(userId)
  const { id, duplicates } = await resolveOrCreate(userId, 'index', () =>
    drive.createFile(userId, {
      name: '_index.json',
      parentId: root,
      mime: SHEET_MIME,
      content: JSON.stringify(EMPTY_INDEX),
      appProperties: { hisaabKey: 'index', hisaab: 'index' },
    }),
  )
  await reconcileDuplicates(userId, duplicates, 'index')
  return id
}

export async function readIndex(userId: string): Promise<DriveIndex> {
  const cached = await kv().get<DriveIndex>(`idx:${userId}`)
  if (cached) return cached
  const id = await indexFileId(userId)
  try {
    const raw = await drive.downloadText(userId, id)
    const parsed = JSON.parse(raw) as DriveIndex
    const index = { ...EMPTY_INDEX, ...parsed }
    await kv().set(`idx:${userId}`, index, { ex: 300 })
    return index
  } catch {
    return { ...EMPTY_INDEX }
  }
}

/**
 * Read-modify-write the index under a lock, then verify the write landed.
 *
 * Drive has no compare-and-swap, so the lock is what serialises writers and the
 * read-back is what proves we didn't lose to one. If the read-back shows a
 * different revision, someone wrote outside the lock and we retry from fresh
 * state rather than reporting a success that didn't happen.
 */
export async function mutateIndex(userId: string, fn: (index: DriveIndex) => DriveIndex | Promise<DriveIndex>): Promise<DriveIndex> {
  return withLock(`idx:${userId}`, async () => {
    const id = await indexFileId(userId)
    for (let attempt = 0; attempt < 3; attempt++) {
      let current: DriveIndex
      try {
        current = { ...EMPTY_INDEX, ...(JSON.parse(await drive.downloadText(userId, id)) as DriveIndex) }
      } catch {
        current = { ...EMPTY_INDEX }
      }
      const next = await fn(structuredClone(current))
      next.rev = current.rev + 1
      next.updatedAt = Date.now()

      await drive.updateContent(userId, id, SHEET_MIME, JSON.stringify(next))

      const verify = JSON.parse(await drive.downloadText(userId, id)) as DriveIndex
      if (verify.rev === next.rev) {
        await kv().set(`idx:${userId}`, verify, { ex: 300 })
        return verify
      }
      await kv().del(`idx:${userId}`)
    }
    throw new Error('Drive index write could not be verified after 3 attempts')
  }, { ttlMs: 25_000, waitMs: 20_000 })
}

// ---------------------------------------------------------------- sheet files

export async function readSheet(userId: string, fileId: string): Promise<SheetDoc | null> {
  const index = await readIndex(userId)
  const entry = index.files[fileId]
  const key = `sheet:${fileId}`
  let driveId = entry?.driveId ?? (await cachedId(userId, key))

  if (!driveId) {
    const found = await drive.list(userId, `appProperties has { key='hisaabKey' and value='${esc(key)}' } and trashed=false`)
    if (found.length === 0) return null
    driveId = found[0].id
    await reconcileDuplicates(userId, found.slice(1).map((f) => f.id), key)
    await cacheId(userId, key, driveId)
  }

  try {
    const raw = await drive.downloadText(userId, driveId)
    return JSON.parse(raw) as SheetDoc
  } catch (err) {
    if (String(err).includes('404')) {
      await forgetId(userId, key)
      return null
    }
    throw err
  }
}

export async function writeSheet(userId: string, doc: SheetDoc, folder: FolderMeta): Promise<void> {
  const key = `sheet:${doc.id}`
  const parent = await folderDirId(userId, folder)
  const { id, duplicates } = await resolveOrCreate(userId, key, () =>
    drive.createFile(userId, {
      name: `${safeName(doc.name)}.hisaab.json`,
      parentId: parent,
      mime: SHEET_MIME,
      content: JSON.stringify(doc),
      appProperties: { hisaabKey: key, hisaab: 'sheet', sid: doc.id, fid: doc.folderId },
    }),
  )
  await reconcileDuplicates(userId, duplicates, key)

  await drive.updateContent(userId, id, SHEET_MIME, JSON.stringify(doc))

  // Read-back verification: prove the revision we intended is the one on disk.
  const verify = JSON.parse(await drive.downloadText(userId, id)) as SheetDoc
  if (verify.rev !== doc.rev) {
    throw new Error(`Drive write verification failed for ${doc.id} (wrote r${doc.rev}, read back r${verify.rev})`)
  }
}

export async function deleteSheet(userId: string, fileId: string): Promise<void> {
  const key = `sheet:${fileId}`
  const id = (await cachedId(userId, key)) ?? (await drive.list(userId, `appProperties has { key='hisaabKey' and value='${esc(key)}' } and trashed=false`))[0]?.id
  if (id) await drive.trash(userId, id)
  await forgetId(userId, key)
}

export async function deleteFolderDir(userId: string, folderId: string): Promise<void> {
  const key = `folder:${folderId}`
  const id = (await cachedId(userId, key)) ?? (await drive.list(userId, `appProperties has { key='hisaabKey' and value='${esc(key)}' } and trashed=false`))[0]?.id
  if (id) await drive.trash(userId, id)
  await forgetId(userId, key)
}

// ---------------------------------------------------------------- attachments

export async function putAttachment(
  userId: string,
  folderId: string,
  file: { id: string; name: string; mime: string; bytes: Buffer },
): Promise<AttachmentRef> {
  const parent = await attachmentsDirId(userId, folderId)
  const key = `attachment:${file.id}`
  const { id } = await resolveOrCreate(userId, key, () =>
    drive.createFile(userId, {
      name: `${file.id.slice(-6)}-${safeName(file.name)}`,
      parentId: parent,
      mime: file.mime,
      content: file.bytes,
      appProperties: { hisaabKey: key, hisaab: 'attachment', aid: file.id },
    }),
  )
  return { id: file.id, name: file.name, mime: file.mime, size: file.bytes.length, backend: 'drive', ref: id, uploadedAt: Date.now() }
}

export async function getAttachment(userId: string, ref: AttachmentRef): Promise<Buffer> {
  return drive.download(userId, ref.ref)
}

export async function deleteAttachment(userId: string, ref: AttachmentRef): Promise<void> {
  await drive.trash(userId, ref.ref)
  await forgetId(userId, `attachment:${ref.id}`)
}

/** Free space check before an upload, so we fail early instead of half-writing. */
export async function quota(userId: string): Promise<{ used: number; limit: number; free: number }> {
  const { used, limit } = await drive.about(userId)
  return { used, limit, free: limit ? Math.max(0, limit - used) : Number.POSITIVE_INFINITY }
}

/**
 * Health sweep: find objects sharing a hisaabKey and reconcile them.
 * Exposed through /api/maintenance/drive so the user can run it if Drive was
 * edited by hand or a write was interrupted mid-flight.
 */
export async function auditDrive(userId: string): Promise<{ scanned: number; duplicates: number; repaired: string[] }> {
  const all = await drive.list(userId, `appProperties has { key='hisaab' and value='sheet' } and trashed=false`)
  const byKey = new Map<string, DriveFile[]>()
  for (const f of all) {
    const key = f.appProperties?.hisaabKey
    if (!key) continue
    byKey.set(key, [...(byKey.get(key) ?? []), f])
  }
  const repaired: string[] = []
  let duplicates = 0
  for (const [key, files] of byKey) {
    if (files.length < 2) continue
    // Keep the copy with the highest document revision - the most complete one.
    const scored = await Promise.all(
      files.map(async (f) => {
        try {
          const doc = JSON.parse(await drive.downloadText(userId, f.id)) as SheetDoc
          return { file: f, rev: doc.rev ?? 0 }
        } catch {
          return { file: f, rev: -1 }
        }
      }),
    )
    scored.sort((a, b) => b.rev - a.rev)
    const [, ...losers] = scored
    duplicates += losers.length
    await reconcileDuplicates(userId, losers.map((l) => l.file.id), key)
    await cacheId(userId, key, scored[0].file.id)
    repaired.push(key)
  }
  return { scanned: all.length, duplicates, repaired }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 90) || 'untitled'
}
