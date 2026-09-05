export type StorageBackend = 'app' | 'drive'

export type ColumnKind = 'amount' | 'text' | 'number' | 'date' | 'attachment' | 'select'

export type Column = {
  id: string
  name: string
  kind: ColumnKind
  /** System columns (amount / title / notes) can be renamed but never removed. */
  system?: boolean
  options?: string[]
  order: string
}

export type AttachmentRef = {
  id: string
  name: string
  mime: string
  size: number
  /**
   * Where the bytes live. 'drive' is a Google Drive file id; 'app' is a row in
   * our own store. 'kv' is what 'app' used to be called and is still accepted
   * on read, because refs written before the rename live inside saved rows.
   */
  backend: StorageBackend | 'kv'
  ref: string
  uploadedAt: number
}

export type CellValue = string | number | null | AttachmentRef[]

export type Row = {
  id: string
  order: string
  cells: Record<string, CellValue>
  createdAt: number
  updatedAt: number
  /** Soft delete. Tombstones keep a concurrent edit from resurrecting a deleted row. */
  deleted?: boolean
}

export type Duration = {
  enabled: boolean
  mode: 'date' | 'month'
  from?: string
  to?: string
}

/** Last-writer-wins stamp: higher lamport wins, actor id breaks ties deterministically. */
export type Stamp = [lamport: number, actor: string]

export type SheetDoc = {
  id: string
  folderId: string
  ownerId: string
  name: string
  currency: string
  columns: Column[]
  rows: Row[]
  duration: Duration
  /** Per-field LWW stamps: `${rowId}:${columnId}` -> Stamp. Also `row:${id}`, `col:${id}`, `doc:name`. */
  stamps: Record<string, Stamp>
  /** Monotonic revision. Bumped on every accepted mutation batch. */
  rev: number
  /** Lamport clock, max(seen) + 1 on every local op. */
  lamport: number
  /** Recently-applied operation ids, for dedupe. Capped; see DEDUPE_WINDOW. */
  seenOps: string[]
  createdAt: number
  updatedAt: number
  updatedBy: string
  schemaVersion: 1
}

export type FolderMeta = {
  id: string
  name: string
  color: string
  icon: string
  createdAt: number
  updatedAt: number
  fileCount: number
  sample?: boolean
}

export type FileMeta = {
  id: string
  folderId: string
  name: string
  createdAt: number
  updatedAt: number
  rowCount: number
  total: number
  currency: string
  starred?: boolean
  tags?: string[]
  rev: number
}

export type User = {
  id: string
  email: string
  name: string
  picture?: string
  provider: 'google' | 'password' | 'dev'
  passwordHash?: string
  /**
   * Where this account's files live. Every account has a home in the app's own
   * database; Drive is something a user turns on, not a consequence of how they
   * happened to sign in.
   */
  backend: StorageBackend
  role: 'user' | 'admin'
  createdAt: number
  settings: {
    analyticsEnabled: boolean
    analyticsSelection: { folderId: string | null; fileIds: string[] }
    theme: 'light' | 'dark' | 'system'
  }
}

export type Session = {
  userId: string
  email: string
  name: string
  picture?: string
  role: 'user' | 'admin'
  backend: StorageBackend
  provider: User['provider']
}
