import { HomeView } from '@/components/HomeView'
import { readSession, getUser } from '@/lib/auth'
import { repoFor } from '@/lib/store/repo'

export const dynamic = 'force-dynamic'

/**
 * Folders are fetched on the server so the first paint already has them -
 * the seeding of the sample folder happens here too, on first visit, which
 * means a brand-new account never sees an empty screen.
 */
export default async function Home() {
  const session = (await readSession())!
  const repo = repoFor({ id: session.userId, backend: session.backend })

  const [folders, user] = await Promise.all([
    repo.listFolders().catch(() => []),
    getUser(session.userId),
  ])

  return <HomeView initialFolders={folders} analyticsEnabled={user?.settings.analyticsEnabled ?? false} />
}
