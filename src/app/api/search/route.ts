import { ok, withAuth } from '@/lib/http/route'
import { mergeHits, rankFiles, rankFolders, rankRows, tokenize, type Hit } from '@/lib/search/rank'

export const dynamic = 'force-dynamic'

const MIN_TERM = 2
const MAX_HITS = 24

/**
 * One search across folders, files and the rows inside them.
 *
 * Scope comes in as `folderId`. Standing on the home screen there is none and
 * everything is in range; standing inside a folder there is one, and the folder
 * is part of the question rather than a preference - "where did that 450 go"
 * asked from inside Goa is not asking about Bangalore.
 *
 * The row search is the expensive half, so it is the half that is narrowed
 * first: the store returns only the documents that could contain every term,
 * and the ranking opens those. A one-character query is not narrowed by
 * anything, so it is refused rather than served slowly.
 */
export const GET = withAuth(async ({ repo }, req: Request) => {
  const url = new URL(req.url)
  const query = (url.searchParams.get('q') ?? '').slice(0, 120)
  const folderId = url.searchParams.get('folderId') || null
  const scoped = url.searchParams.get('scoped') === 'true' && Boolean(folderId)

  const terms = tokenize(query)
  if (terms.length === 0 || terms.every((t) => t.length < MIN_TERM)) {
    return ok({ query, results: [] as Hit[], scoped, truncated: false })
  }

  const [folders, files, docs] = await Promise.all([
    repo.listFolders(),
    repo.listAllFiles(),
    repo.searchDocs(terms),
  ])

  const names = new Map(folders.map((f) => [f.id, f.name]))
  const folderName = (id: string) => names.get(id) ?? ''
  const ctx = { folderId, scoped }

  const results = mergeHits(
    [
      rankFolders(terms, folders, ctx),
      rankFiles(terms, files, folderName, ctx),
      rankRows(terms, docs, folderName, ctx),
    ],
    MAX_HITS,
  )

  return ok({ query, results, scoped, truncated: results.length >= MAX_HITS })
})
