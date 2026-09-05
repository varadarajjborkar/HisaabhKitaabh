import type { AttachmentRef, FileMeta, FolderMeta, SheetDoc, StorageBackend, User } from '../model/types'
import { K, kv, backends } from './kv'
import { accountFootprint, blobs, sqlEnabled } from '../db/sql'
import { LockTimeoutError, withLock } from './locks'
import { applyOps, checkRev, computeTotals, docEtag, liveRows, newSheet, RevisionConflictError } from '../crdt/doc'
import type { Op, OpBatch, StampedOp } from '../crdt/ops'
import { ulid } from '../util/ids'
import { env } from '../env'
import * as driveStore from '../drive/store'
import { hasDrive } from '../drive/client'
import { seedSampleFolder } from './seed'

/**
 * The repository is the only thing in the app that touches persistence.
 *
 * Two backends sit behind it:
 *   - `app`   - the account's own storage in our database. The default: every
 *     account gets one, and nothing about signing up requires a Google account.
 *   - `drive` - the user's own Google Drive, for people who would rather hold
 *     their own data. Zero storage cost to us, and the user owns the files
 *     outright.
 *
 * Reads go through a short-TTL cache; writes go through a lock, a revision
 * check, and a read-back. Nothing writes a whole document blindly.
 */

const DOC_CACHE_TTL = 120
const OPLOG_LIMIT = 300

export type MutateResult = {
  doc: SheetDoc
  etag: string
  applied: StampedOp[]
  duplicates: string[]
  superseded: string[]
  rejected: Array<{ opId: string; reason: string }>
}

export class ConflictError extends Error {
  readonly conflicts: string[]
  readonly current: SheetDoc
  constructor(conflicts: string[], current: SheetDoc) {
    super('Some of these edits touch cells that changed since you loaded them')
    this.name = 'ConflictError'
    this.conflicts = conflicts
    this.current = current
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`)
    this.name = 'NotFoundError'
  }
}

export class Repo {
  private readonly user: { id: string; backend: StorageBackend }

  constructor(user: { id: string; backend: StorageBackend }) {
    this.user = user
  }

  private get uid() {
    return this.user.id
  }

  /**
   * Drive accounts fall back to app storage if the grant is gone, so a revoked
   * or expired Google authorisation degrades to a working app rather than an
   * error page on every read.
   */
  private async backend(): Promise<StorageBackend> {
    if (this.user.backend !== 'drive') return 'app'
    return (await hasDrive(this.uid)) ? 'drive' : 'app'
  }

  // ------------------------------------------------------------- folders

  async listFolders(): Promise<FolderMeta[]> {
    const backend = await this.backend()
    const folders =
      backend === 'drive'
        ? (await driveStore.readIndex(this.uid)).folders
        : (await kv().get<FolderMeta[]>(K.folders(this.uid))) ?? []

    if (folders.length === 0) {
      const seeded = await this.ensureSample()
      if (seeded) return this.listFolders()
    }
    return [...folders].sort((a, b) => (a.sample === b.sample ? b.updatedAt - a.updatedAt : a.sample ? 1 : -1))
  }

  async getFolder(folderId: string): Promise<FolderMeta> {
    const folder = (await this.listFolders()).find((f) => f.id === folderId)
    if (!folder) throw new NotFoundError('Folder')
    return folder
  }

  async createFolder(input: { name: string; color?: string; icon?: string; id?: string; sample?: boolean }): Promise<FolderMeta> {
    const now = Date.now()
    const folder: FolderMeta = {
      id: input.id ?? ulid(),
      name: input.name.trim().slice(0, 80) || 'Untitled folder',
      color: input.color ?? pickColor(input.name),
      icon: input.icon ?? '📁',
      createdAt: now,
      updatedAt: now,
      fileCount: 0,
      ...(input.sample ? { sample: true } : {}),
    }
    await this.markStarted()
    await this.withFolders((folders) => {
      // Idempotent by id: a retried create returns the existing folder.
      if (folders.some((f) => f.id === folder.id)) return folders
      return [...folders, folder]
    })
    if ((await this.backend()) === 'drive') await driveStore.folderDirId(this.uid, folder)
    return folder
  }

  async updateFolder(folderId: string, patch: Partial<Pick<FolderMeta, 'name' | 'color' | 'icon'>>): Promise<FolderMeta> {
    let updated: FolderMeta | null = null
    await this.withFolders((folders) =>
      folders.map((f) => {
        if (f.id !== folderId) return f
        updated = { ...f, ...patch, name: (patch.name ?? f.name).trim().slice(0, 80) || f.name, updatedAt: Date.now(), sample: undefined }
        return updated
      }),
    )
    if (!updated) throw new NotFoundError('Folder')
    return updated
  }

  async deleteFolder(folderId: string): Promise<void> {
    // 404s if this is not one of the caller's folders, so deleting a folder the
    // account does not have reports honestly instead of a silent no-op success.
    await this.getFolder(folderId)
    const files = await this.listFiles(folderId)
    for (const f of files) await this.deleteFile(f.id)
    await this.withFolders((folders) => folders.filter((f) => f.id !== folderId))
    if ((await this.backend()) === 'drive') await driveStore.deleteFolderDir(this.uid, folderId)
    await kv().del(K.files(this.uid, folderId))
  }

  private async withFolders(fn: (folders: FolderMeta[]) => FolderMeta[]): Promise<FolderMeta[]> {
    return withLock(`folders:${this.uid}`, async () => {
      if ((await this.backend()) === 'drive') {
        const index = await driveStore.mutateIndex(this.uid, (idx) => ({ ...idx, folders: fn(idx.folders) }))
        return index.folders
      }
      const current = (await kv().get<FolderMeta[]>(K.folders(this.uid))) ?? []
      const next = fn(current)
      await kv().set(K.folders(this.uid), next)
      return next
    })
  }

  // --------------------------------------------------------------- files

  async listFiles(folderId: string): Promise<FileMeta[]> {
    const backend = await this.backend()
    if (backend === 'drive') {
      const index = await driveStore.readIndex(this.uid)
      return Object.entries(index.files)
        .filter(([, v]) => v.folderId === folderId)
        .map(([id, v]) => ({
          id,
          folderId: v.folderId,
          name: v.name,
          createdAt: v.updatedAt,
          updatedAt: v.updatedAt,
          rowCount: v.rowCount,
          total: v.total,
          currency: 'INR',
          rev: v.rev,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }
    const metas = (await kv().get<FileMeta[]>(K.files(this.uid, folderId))) ?? []
    return [...metas].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async listAllFiles(): Promise<FileMeta[]> {
    const folders = await this.listFolders()
    const lists = await Promise.all(folders.map((f) => this.listFiles(f.id)))
    return lists.flat()
  }

  async createFile(input: { folderId: string; name: string; id?: string; seed?: SheetDoc }): Promise<SheetDoc> {
    const folder = await this.getFolder(input.folderId)
    const existing = input.id ? await this.tryGetDoc(input.id) : null
    if (existing) return existing // idempotent create

    const doc = input.seed ?? newSheet({ id: input.id, folderId: input.folderId, ownerId: this.uid, name: input.name })
    await this.persist(doc, folder)
    await this.indexFile(doc)
    return doc
  }

  async getDoc(fileId: string): Promise<SheetDoc> {
    const doc = await this.tryGetDoc(fileId)
    if (!doc) throw new NotFoundError('File')
    return doc
  }

  async tryGetDoc(fileId: string, opts: { fresh?: boolean } = {}): Promise<SheetDoc | null> {
    if (!opts.fresh) {
      const cached = await kv().get<SheetDoc>(K.cacheDoc(this.uid, fileId))
      if (cached) return cached
    }
    const backend = await this.backend()
    const doc =
      backend === 'drive'
        ? await driveStore.readSheet(this.uid, fileId)
        : await kv().get<SheetDoc>(K.doc(this.uid, fileId))
    if (doc) await kv().set(K.cacheDoc(this.uid, fileId), doc, { ex: DOC_CACHE_TTL })
    return doc
  }

  async deleteFile(fileId: string): Promise<void> {
    const doc = await this.tryGetDoc(fileId)
    // Every key below is built from this account's id, so a delete could only
    // ever reach this account's own data - there is no path to another user's
    // file here. But a request to delete a file this account does not have must
    // be a 404, not a fabricated success: the endpoint should never report
    // having removed something it never held, and an ownership check that is
    // explicit is one that survives a future change to how storage is keyed.
    if (!doc) throw new NotFoundError('File')
    await withLock(`doc:${this.uid}:${fileId}`, async () => {
      if ((await this.backend()) === 'drive') await driveStore.deleteSheet(this.uid, fileId)
      else await kv().del(K.doc(this.uid, fileId))
      await kv().del(K.cacheDoc(this.uid, fileId), `oplog:${this.uid}:${fileId}`)
    })
    await this.unindexFile(doc)
  }

  // ------------------------------------------------------------- mutation

  /**
   * The write path. Everything that changes a document goes through here -
   * the UI, the AI agent, imports, undo. One code path means one set of
   * guarantees.
   *
   *   lock -> fresh read -> revision check -> apply -> persist -> verify -> log
   *
   * Callers pass the revision they were looking at. If someone else has since
   * touched a field this batch also touches, we refuse the batch and hand back
   * the current document so the caller can rebase - we never merge blindly and
   * we never silently drop an edit.
   */
  async mutate(fileId: string, batch: OpBatch): Promise<MutateResult> {
    if (batch.ops.length === 0) {
      const doc = await this.getDoc(fileId)
      return { doc, etag: docEtag(doc), applied: [], duplicates: [], superseded: [], rejected: [] }
    }
    if (batch.ops.length > 500) throw new Error('Too many operations in one batch (max 500)')

    try {
      return await withLock(
        `doc:${this.uid}:${fileId}`,
        async () => {
          const doc = await this.tryGetDoc(fileId, { fresh: true })
          if (!doc) throw new NotFoundError('File')

          const since = await this.opsSince(fileId, batch.baseRev)
          const gate = checkRev(doc, batch, since)
          if (!gate.ok) throw new ConflictError(gate.conflicts, doc)

          const guard = guardLimits(doc, batch.ops)
          if (guard) throw new Error(guard)

          const result = applyOps(doc, { actor: batch.actor, ops: batch.ops })
          if (result.applied.length === 0) {
            return { doc: result.doc, etag: docEtag(result.doc), ...pick(result) }
          }

          const folder = await this.getFolder(result.doc.folderId)
          await this.persist(result.doc, folder)
          await this.appendOplog(fileId, result.doc.rev, result.applied)
          await this.indexFile(result.doc)

          return { doc: result.doc, etag: docEtag(result.doc), ...pick(result) }
        },
        { ttlMs: 20_000, waitMs: 12_000 },
      )
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        throw new Error('This file is being written to right now. Try again in a moment.')
      }
      throw err
    }
  }

  /** Ops applied after `rev`, newest last. `null` when history no longer covers it. */
  private async opsSince(fileId: string, rev: number): Promise<StampedOp[] | null> {
    const entries = await kv().lrange<{ rev: number; ops: StampedOp[] }>(`oplog:${this.uid}:${fileId}`, 0, OPLOG_LIMIT)
    if (entries.length === 0) return null
    const oldest = entries[entries.length - 1]
    if (oldest.rev > rev + 1) return null // history has been trimmed past the client's base
    return entries.filter((e) => e.rev > rev).flatMap((e) => e.ops)
  }

  private async appendOplog(fileId: string, rev: number, ops: StampedOp[]): Promise<void> {
    const key = `oplog:${this.uid}:${fileId}`
    await kv().lpush(key, { rev, ops })
    await kv().ltrim(key, 0, OPLOG_LIMIT)
    await kv().expire(key, 60 * 60 * 24 * 7)
  }

  async recentActivity(fileId: string, limit = 40): Promise<Array<{ rev: number; ops: StampedOp[] }>> {
    return kv().lrange(`oplog:${this.uid}:${fileId}`, 0, limit)
  }

  private async persist(doc: SheetDoc, folder: FolderMeta): Promise<void> {
    if ((await this.backend()) === 'drive') await driveStore.writeSheet(this.uid, doc, folder)
    else await kv().set(K.doc(this.uid, doc.id), doc)
    await kv().set(K.cacheDoc(this.uid, doc.id), doc, { ex: DOC_CACHE_TTL })
  }

  private async indexFile(doc: SheetDoc): Promise<void> {
    const totals = computeTotals(doc)
    const meta: FileMeta = {
      id: doc.id,
      folderId: doc.folderId,
      name: doc.name,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      rowCount: totals.count,
      total: totals.total,
      currency: doc.currency,
      rev: doc.rev,
    }
    if ((await this.backend()) === 'drive') {
      await driveStore.mutateIndex(this.uid, (idx) => {
        idx.files[doc.id] = {
          folderId: doc.folderId,
          driveId: idx.files[doc.id]?.driveId ?? '',
          name: doc.name,
          rev: doc.rev,
          updatedAt: doc.updatedAt,
          rowCount: totals.count,
          total: totals.total,
        }
        idx.folders = idx.folders.map((f) =>
          f.id === doc.folderId
            ? { ...f, fileCount: Object.values(idx.files).filter((x) => x.folderId === doc.folderId).length, updatedAt: Date.now() }
            : f,
        )
        return idx
      })
      return
    }
    await withLock(`files:${this.uid}:${doc.folderId}`, async () => {
      const list = (await kv().get<FileMeta[]>(K.files(this.uid, doc.folderId))) ?? []
      const next = list.some((f) => f.id === doc.id) ? list.map((f) => (f.id === doc.id ? meta : f)) : [...list, meta]
      await kv().set(K.files(this.uid, doc.folderId), next)
    })
    await this.withFolders((folders) =>
      folders.map((f) => (f.id === doc.folderId ? { ...f, fileCount: Math.max(f.fileCount, 1), updatedAt: Date.now() } : f)),
    )
  }

  private async unindexFile(doc: SheetDoc): Promise<void> {
    if ((await this.backend()) === 'drive') {
      await driveStore.mutateIndex(this.uid, (idx) => {
        delete idx.files[doc.id]
        idx.folders = idx.folders.map((f) =>
          f.id === doc.folderId
            ? { ...f, fileCount: Object.values(idx.files).filter((x) => x.folderId === doc.folderId).length }
            : f,
        )
        return idx
      })
      return
    }
    await withLock(`files:${this.uid}:${doc.folderId}`, async () => {
      const list = (await kv().get<FileMeta[]>(K.files(this.uid, doc.folderId))) ?? []
      await kv().set(K.files(this.uid, doc.folderId), list.filter((f) => f.id !== doc.id))
    })
  }

  // --------------------------------------------------------- attachments

  async putAttachment(folderId: string, file: { name: string; mime: string; bytes: Buffer }): Promise<AttachmentRef> {
    const id = ulid()
    if (file.bytes.length > env.limits.maxAttachmentBytes) {
      throw new Error(`Attachment is larger than the ${Math.round(env.limits.maxAttachmentBytes / 1024 / 1024)} MB limit`)
    }
    if ((await this.backend()) === 'drive') {
      const free = await driveStore.quota(this.uid).catch(() => null)
      if (free && free.free < file.bytes.length * 1.2) {
        throw new Error('Not enough free space in your Google Drive for this attachment')
      }
      return driveStore.putAttachment(this.uid, folderId, { id, name: file.name, mime: file.mime, bytes: file.bytes })
    }

    if (sqlEnabled) {
      // One account should not be able to fill the disk everyone else shares.
      const used = await blobs.usage(this.uid)
      if (used.bytes + file.bytes.length > env.limits.maxStorageBytesPerUser) {
        throw new Error(
          `This account has used its ${Math.round(env.limits.maxStorageBytesPerUser / 1024 / 1024)} MB of attachment storage. ` +
            'Delete some receipts, or switch this account to Google Drive in settings.',
        )
      }
      await blobs.put(this.uid, { id, name: file.name, mime: file.mime, bytes: file.bytes })
    } else {
      // Without a database the bytes go into the key/value store base64-encoded,
      // which costs a third more space and is exactly why Postgres is the
      // recommended configuration for anything holding real receipts.
      await kv().set(K.attachment(this.uid, id), {
        name: file.name,
        mime: file.mime,
        data: file.bytes.toString('base64'),
      })
    }
    return { id, name: file.name, mime: file.mime, size: file.bytes.length, backend: 'app', ref: id, uploadedAt: Date.now() }
  }

  async getAttachment(ref: AttachmentRef): Promise<{ bytes: Buffer; mime: string; name: string }> {
    if (ref.backend === 'drive') {
      return { bytes: await driveStore.getAttachment(this.uid, ref), mime: ref.mime, name: ref.name }
    }
    if (sqlEnabled) {
      const stored = await blobs.get(this.uid, ref.ref)
      if (stored) return stored
      // Fall through: a deployment that gained a database still has to serve
      // the receipts uploaded before it had one.
    }
    const blob = await kv().get<{ name: string; mime: string; data: string }>(K.attachment(this.uid, ref.ref))
    if (!blob) throw new NotFoundError('Attachment')
    return { bytes: Buffer.from(blob.data, 'base64'), mime: blob.mime, name: blob.name }
  }

  async deleteAttachment(ref: AttachmentRef): Promise<void> {
    if (ref.backend === 'drive') {
      await driveStore.deleteAttachment(this.uid, ref)
      return
    }
    if (sqlEnabled) await blobs.del(this.uid, ref.ref)
    await kv().del(K.attachment(this.uid, ref.ref))
  }

  // ---------------------------------------------------------------- misc

  async invalidate(fileId?: string): Promise<void> {
    await kv().del(`idx:${this.uid}`)
    if (fileId) await kv().del(K.cacheDoc(this.uid, fileId))
    else {
      const keys = await kv().keys(`c:${this.uid}:doc:*`)
      if (keys.length) await kv().del(...keys)
    }
  }

  async storageInfo(): Promise<{ backend: string; durable: boolean; used?: number; limit?: number; files?: number }> {
    const backend = await this.backend()
    if (backend === 'drive') {
      const q = await driveStore.quota(this.uid).catch(() => null)
      return { backend: 'Google Drive', durable: true, used: q?.used, limit: q?.limit }
    }
    if (sqlEnabled) {
      const f = await accountFootprint(this.uid)
      return {
        backend: 'App storage',
        durable: true,
        used: f.jsonBytes + f.blobBytes,
        limit: env.limits.maxStorageBytesPerUser,
        files: f.blobCount,
      }
    }
    const { primaryName } = backends()
    return { backend: `App storage (${primaryName})`, durable: kv().durable }
  }

  /**
   * Seed the sample folder - exactly once per account, ever.
   *
   * Gated on a persistent marker rather than "the folder list is empty", which
   * was wrong in both directions: a user whose first action was creating a
   * folder never got the sample at all, and a user who deleted everything had
   * it silently reappear on their next visit, as though the app had undone
   * their cleanup.
   */
  private async ensureSample(): Promise<boolean> {
    return withLock(`seed:${this.uid}`, async () => {
      if (await kv().get<number>(K.seeded(this.uid))) return false
      await kv().set(K.seeded(this.uid), Date.now())

      const backend = await this.backend()
      const existing =
        backend === 'drive'
          ? (await driveStore.readIndex(this.uid)).folders
          : (await kv().get<FolderMeta[]>(K.folders(this.uid))) ?? []
      if (existing.length > 0) return false

      await seedSampleFolder(this)
      return true
    }, { ttlMs: 30_000, waitMs: 20_000 })
  }

  /** Someone who makes their own folder has started; they don't need the sample. */
  private async markStarted(): Promise<void> {
    await kv().set(K.seeded(this.uid), Date.now())
  }
}

function pick(r: { applied: StampedOp[]; duplicates: string[]; superseded: string[]; rejected: Array<{ opId: string; reason: string }> }) {
  return { applied: r.applied, duplicates: r.duplicates, superseded: r.superseded, rejected: r.rejected }
}

function guardLimits(doc: SheetDoc, ops: Op[]): string | null {
  const inserts = ops.filter((o) => o.type === 'row.insert').length
  if (liveRows(doc).length + inserts > env.limits.maxRowsPerFile) {
    return `This file would exceed the ${env.limits.maxRowsPerFile}-row limit. Split it into two files.`
  }
  const newCols = ops.filter((o) => o.type === 'column.insert').length
  if (doc.columns.length + newCols > env.limits.maxColumnsPerFile) {
    return `This file would exceed the ${env.limits.maxColumnsPerFile}-column limit.`
  }
  return null
}

const COLORS = ['#3b7dd8', '#c2410c', '#0f766e', '#7c3aed', '#b91c1c', '#0369a1', '#4d7c0f', '#a16207']
function pickColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return COLORS[Math.abs(h) % COLORS.length]
}

export function repoFor(user: Pick<User, 'id' | 'backend'>): Repo {
  return new Repo({ id: user.id, backend: user.backend })
}

export { RevisionConflictError }
