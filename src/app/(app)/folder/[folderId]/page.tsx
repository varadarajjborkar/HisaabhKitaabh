import { notFound } from 'next/navigation'
import { readSession } from '@/lib/auth'
import { repoFor } from '@/lib/store/repo'
import { FolderView } from '@/components/FolderView'

export const dynamic = 'force-dynamic'

export default async function FolderPage({ params }: { params: Promise<{ folderId: string }> }) {
  const { folderId } = await params
  const session = (await readSession())!
  const repo = repoFor({ id: session.userId, backend: session.backend })

  try {
    const [folder, files] = await Promise.all([repo.getFolder(folderId), repo.listFiles(folderId)])
    return <FolderView folder={folder} initialFiles={files} />
  } catch {
    notFound()
  }
}
