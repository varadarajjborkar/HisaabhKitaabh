import { notFound } from 'next/navigation'
import { readSession } from '@/lib/auth'
import { repoFor } from '@/lib/store/repo'
import { SheetView } from '@/components/sheet/SheetView'

export const dynamic = 'force-dynamic'

export default async function FilePage({ params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params
  const session = (await readSession())!
  const repo = repoFor({ id: session.userId, backend: session.backend })

  const doc = await repo.tryGetDoc(fileId)
  if (!doc) notFound()
  const folder = await repo.getFolder(doc.folderId).catch(() => null)

  return (
    <SheetView
      fileId={fileId}
      folderId={doc.folderId}
      folderName={folder?.name ?? 'Folder'}
      initialDoc={doc}
    />
  )
}
