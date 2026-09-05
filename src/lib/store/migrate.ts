import type { AttachmentRef, CellValue, SheetDoc, StorageBackend } from '../model/types'
import { Repo } from './repo'

/**
 * Moving an account between storage backends.
 *
 * Somebody who signed up with a password and later decides they would rather
 * hold their own data in Drive - or the reverse, somebody who connected Drive
 * and wants out - should not have to re-key a year of expenses. Switching where
 * files live is a setting, and this is what makes that setting honest.
 *
 * Two rules shape the implementation:
 *
 *   1. Copy, never move. The source is left exactly as it was. A migration that
 *      dies halfway through - a Drive token expiring, a function timing out -
 *      then costs a retry rather than the user's records. Cleaning up the old
 *      copy is a separate, explicit act.
 *
 *   2. Idempotent. Folders and files are created with their existing ids, and
 *      creating something that is already there returns it untouched, so
 *      running this twice does not produce two of everything.
 */

export type MigrationReport = {
  from: StorageBackend
  to: StorageBackend
  folders: number
  files: number
  attachments: number
  failures: string[]
}

function attachments(value: CellValue): AttachmentRef[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  return typeof value[0] === 'object' && value[0] !== null && 'ref' in value[0] ? (value as AttachmentRef[]) : null
}

/** 'kv' is the pre-rename spelling of 'app'; both mean our own store. */
function livesIn(ref: AttachmentRef): StorageBackend {
  return ref.backend === 'drive' ? 'drive' : 'app'
}

export async function moveAccount(
  userId: string,
  from: StorageBackend,
  to: StorageBackend,
): Promise<MigrationReport> {
  const report: MigrationReport = { from, to, folders: 0, files: 0, attachments: 0, failures: [] }
  if (from === to) return report

  const source = new Repo({ id: userId, backend: from })
  const target = new Repo({ id: userId, backend: to })

  const folders = await source.listFolders()
  for (const folder of folders) {
    await target.createFolder({ id: folder.id, name: folder.name, color: folder.color, icon: folder.icon })
    report.folders++

    for (const meta of await source.listFiles(folder.id)) {
      try {
        const doc = await source.getDoc(meta.id)

        // The document cache is keyed by file id alone, so a doc just read from
        // the source would otherwise be handed straight back to the target as
        // proof the file already exists there.
        await target.invalidate(meta.id)

        const seed = await copyAttachments(source, target, folder.id, doc, report)
        await target.createFile({ folderId: folder.id, name: doc.name, id: doc.id, seed })
        report.files++
      } catch (err) {
        report.failures.push(`${meta.name}: ${(err as Error).message}`)
      }
    }
  }

  // Anything cached against the old backend is now wrong for every read.
  await target.invalidate()
  return report
}

/**
 * Rewrite a document's attachment references to point at the new store.
 *
 * A reference that already lives where we are going is left alone, so a file
 * whose receipts were never in Drive costs nothing to migrate. A reference we
 * cannot read is kept as it was rather than dropped: a broken link the user can
 * see beats a cell that silently emptied.
 */
async function copyAttachments(
  source: Repo,
  target: Repo,
  folderId: string,
  doc: SheetDoc,
  report: MigrationReport,
): Promise<SheetDoc> {
  const rows = await Promise.all(
    doc.rows.map(async (row) => {
      const cells: Record<string, CellValue> = { ...row.cells }
      for (const [columnId, value] of Object.entries(row.cells)) {
        const refs = attachments(value)
        if (!refs) continue

        const moved: AttachmentRef[] = []
        for (const ref of refs) {
          if (livesIn(ref) === report.to) {
            moved.push(ref)
            continue
          }
          try {
            const blob = await source.getAttachment(ref)
            const next = await target.putAttachment(folderId, { name: blob.name, mime: blob.mime, bytes: blob.bytes })
            moved.push({ ...next, id: ref.id, uploadedAt: ref.uploadedAt })
            report.attachments++
          } catch (err) {
            report.failures.push(`${ref.name}: ${(err as Error).message}`)
            moved.push(ref)
          }
        }
        cells[columnId] = moved
      }
      return { ...row, cells }
    }),
  )
  return { ...doc, rows }
}
