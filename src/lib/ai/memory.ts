import { isMarker } from './markers'
import { K, kv } from '../store/kv'
import { shortId } from '../util/ids'
import { chatStructured } from './ollama'
import { env } from '../env'

/**
 * Memory hierarchy.
 *
 * L0  Working set   - the open document. Derived per request, never stored;
 *                     stale copies of a ledger are worse than no copy.
 * L1  Recent turns  - last N messages, verbatim, in Redis. Fast, exact.
 * L2  Thread summary- rolling prose summary of what fell out of L1. Compaction
 *                     happens on write, so a long thread stays a fixed prompt cost.
 * L3  Durable facts - user-level preferences and standing corrections that
 *                     should outlive the thread ("call it Groceries, not Food").
 *
 * Retrieval is keyword + recency rather than vector search. For a few hundred
 * facts per user that is more accurate than an embedding index, costs one Redis
 * read, and never returns a confidently-wrong neighbour.
 */

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export type StoredMessage = {
  id: string
  role: ChatRole
  content: string
  at: number
  /** Rendered tool activity, kept for the transcript UI. */
  toolName?: string
  meta?: Record<string, unknown>
}

export type MemoryFact = {
  id: string
  text: string
  kind: 'preference' | 'correction' | 'context'
  createdAt: number
  hits: number
  scope?: { fileId?: string; folderId?: string }
}

const L1_LIMIT = 30
const SUMMARY_TRIGGER = 24
const MAX_FACTS = 120

// ------------------------------------------------------------------- L1 turns

export async function appendMessage(userId: string, threadId: string, msg: Omit<StoredMessage, 'id' | 'at'>): Promise<StoredMessage> {
  const full: StoredMessage = { id: shortId(10), at: Date.now(), ...msg }
  const key = K.chat(userId, threadId)
  await kv().lpush(key, full)
  await kv().ltrim(key, 0, L1_LIMIT * 2)
  await kv().expire(key, 60 * 60 * 24 * 60)
  await kv().zadd(K.chatIndex(userId), Date.now(), threadId)
  return full
}

export async function recentMessages(userId: string, threadId: string, limit = L1_LIMIT): Promise<StoredMessage[]> {
  const list = await kv().lrange<StoredMessage>(K.chat(userId, threadId), 0, limit - 1)
  return list.reverse() // stored newest-first, prompts read oldest-first
}

export type ThreadSummary = {
  id: string
  title: string
  at: number
  renamed: boolean
  /** The line that matched, when the list came back from a search. */
  snippet?: string
}

export async function listThreads(userId: string, limit = 20): Promise<ThreadSummary[]> {
  const ids = await kv().zrange<string>(K.chatIndex(userId), 0, limit - 1, true)
  const names = (await kv().hgetall<string>(K.chatTitles(userId))) ?? {}
  const out: ThreadSummary[] = []
  for (const id of ids) {
    const [first] = await kv().lrange<StoredMessage>(K.chat(userId, id), 0, 0)
    const msgs = await kv().lrange<StoredMessage>(K.chat(userId, id), 0, 12)
    const firstUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (!first) continue
    // A name the user typed always wins over the derived one; the first message
    // can be edited away by compaction, the name should not follow it.
    const custom = names[id]
    out.push({
      id,
      title: (custom || firstUser?.content || 'Conversation').slice(0, 60),
      at: first.at,
      renamed: Boolean(custom),
    })
  }
  return out
}

/**
 * Find a conversation again.
 *
 * Titles rank above content, and deliberately so: a title is what somebody
 * remembers a conversation *as*, and a match there is nearly always the one
 * they meant. Content is the fallback for the case a title cannot serve - "the
 * chat where I worked out the Goa split" is a thing that was said, not a thing
 * the conversation was called.
 *
 * A search reads more of each thread than the list does, but only of threads
 * it is going to score, and it stops at a bounded number of them. The
 * alternative - an index of every message - is a second store to keep
 * consistent for a feature used a few times a week.
 */
export async function searchThreads(userId: string, query: string, limit = 20): Promise<ThreadSummary[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return listThreads(userId, limit)

  const ids = await kv().zrange<string>(K.chatIndex(userId), 0, 199, true)
  const names = (await kv().hgetall<string>(K.chatTitles(userId))) ?? {}
  const scored: Array<{ thread: ThreadSummary; score: number }> = []

  for (const id of ids) {
    const msgs = await kv().lrange<StoredMessage>(K.chat(userId, id), 0, 60)
    if (msgs.length === 0) continue
    const firstUser = [...msgs].reverse().find((m) => m.role === 'user')
    const custom = names[id]
    const title = (custom || firstUser?.content || 'Conversation').slice(0, MAX_TITLE)
    const lowerTitle = title.toLowerCase()

    let score = 0
    let snippet: string | undefined

    for (const term of terms) {
      if (lowerTitle.includes(term)) { score += lowerTitle.startsWith(term) ? 12 : 8; continue }
      // Machinery is not content. A search for "chart" should find the
      // conversation where the user said chart, not every marker the app wrote.
      const hit = msgs.find((m) => !isMarker(m.content) && m.content.toLowerCase().includes(term))
      if (hit) {
        score += 3
        snippet ??= excerpt(hit.content, term)
      }
    }

    // Every term has to land somewhere, or "goa cab" would match a thread
    // that only ever mentioned cabs.
    if (score > 0 && terms.every((t) => lowerTitle.includes(t) || msgs.some((m) => !isMarker(m.content) && m.content.toLowerCase().includes(t)))) {
      scored.push({ thread: { id, title, at: msgs[0].at, renamed: Boolean(custom), snippet }, score })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || b.thread.at - a.thread.at)
    .slice(0, limit)
    .map((s) => s.thread)
}

/** A short window of text around the first hit, for the result row. */
function excerpt(content: string, term: string): string {
  const at = content.toLowerCase().indexOf(term)
  const from = Math.max(0, at - 32)
  const text = content.slice(from, from + 96).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${text}${from + 96 < content.length ? '…' : ''}`
}

const MAX_TITLE = 60

export async function renameThread(userId: string, threadId: string, title: string): Promise<string> {
  const clean = title.trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE)
  if (!clean) {
    // An empty name is a request to go back to the derived one, not a blank row.
    await kv().hdel(K.chatTitles(userId), threadId)
    return ''
  }
  await kv().hset(K.chatTitles(userId), threadId, clean)
  return clean
}

export async function deleteThread(userId: string, threadId: string): Promise<void> {
  await kv().del(K.chat(userId, threadId), K.chatSummary(userId, threadId))
  await kv().zrem(K.chatIndex(userId), threadId)
  await kv().hdel(K.chatTitles(userId), threadId)
}

// ----------------------------------------------------------------- L2 summary

export async function getSummary(userId: string, threadId: string): Promise<string> {
  return (await kv().get<string>(K.chatSummary(userId, threadId))) ?? ''
}

/**
 * Compact the thread when it grows past the window.
 *
 * Runs after the response is streamed, not before it - summarising is never
 * allowed to sit between the user pressing enter and the first token.
 */
export async function maybeCompact(userId: string, threadId: string): Promise<void> {
  if (!env.ollama.enabled) return
  const all = await kv().lrange<StoredMessage>(K.chat(userId, threadId), 0, L1_LIMIT * 2)
  if (all.length < SUMMARY_TRIGGER) return

  const older = all.slice(L1_LIMIT).reverse()
  if (older.length === 0) return
  const prior = await getSummary(userId, threadId)

  try {
    const result = await chatStructured<{ summary?: string; facts?: unknown }>({
      model: env.ollama.fastModel,
      temperature: 0,
      maxTokens: 2000,
      toolName: 'save_summary',
      description: 'Save the compacted conversation summary. Call exactly once.',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Under 200 words, third person.' },
          facts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Durable user preferences worth remembering beyond this thread. Empty array if none.',
          },
        },
        required: ['summary', 'facts'],
      },
      messages: [
        {
          role: 'system',
          content:
            'You compact a conversation between a person and an expense-tracking assistant. Keep decisions, corrections, names of files and folders, and anything the user asked to be done differently. Drop pleasantries and superseded intermediate steps. Write in the third person, under 200 words.',
        },
        {
          role: 'user',
          content: `Existing summary:\n${prior || '(none)'}\n\nNew messages to fold in:\n${older
            .map((m) => `${m.role}: ${m.content.slice(0, 600)}`)
            .join('\n')}`,
        },
      ],
    })

    if (!result?.summary) return

    await kv().set(K.chatSummary(userId, threadId), result.summary, { ex: 60 * 60 * 24 * 60 })
    await kv().ltrim(K.chat(userId, threadId), 0, L1_LIMIT - 1)
    const facts = Array.isArray(result.facts) ? result.facts : []
    for (const fact of facts.slice(0, 3)) {
      if (typeof fact === 'string') await rememberFact(userId, { text: fact, kind: 'preference' })
    }
  } catch (err) {
    console.warn('[hisaabhkitaabh] compaction skipped:', err)
  }
}

// ------------------------------------------------------------------- L3 facts

export async function rememberFact(userId: string, fact: Omit<MemoryFact, 'id' | 'createdAt' | 'hits'>): Promise<void> {
  const text = fact.text.trim()
  if (text.length < 8 || text.length > 400) return

  const existing = await allFacts(userId)
  // Cheap dedupe: near-identical wording replaces rather than accumulates.
  const dupe = existing.find((f) => similarity(f.text, text) > 0.82)
  if (dupe) {
    await kv().hset(K.memory(userId), dupe.id, { ...dupe, text, hits: dupe.hits + 1 })
    return
  }
  if (existing.length >= MAX_FACTS) {
    const weakest = [...existing].sort((a, b) => a.hits - b.hits || a.createdAt - b.createdAt)[0]
    if (weakest) await kv().hdel(K.memory(userId), weakest.id)
  }
  const id = shortId(8)
  await kv().hset(K.memory(userId), id, { id, createdAt: Date.now(), hits: 0, ...fact, text })
}

export async function allFacts(userId: string): Promise<MemoryFact[]> {
  const map = await kv().hgetall<MemoryFact>(K.memory(userId))
  return Object.values(map ?? {}).filter((f): f is MemoryFact => Boolean(f?.text))
}

export async function forgetFact(userId: string, id: string): Promise<void> {
  await kv().hdel(K.memory(userId), id)
}

/** Facts relevant to this message, scored by keyword overlap and past usefulness. */
export async function recallFacts(userId: string, query: string, scope: { fileId?: string; folderId?: string }, limit = 6): Promise<MemoryFact[]> {
  const facts = await allFacts(userId)
  if (facts.length === 0) return []
  const words = new Set(query.toLowerCase().split(/[^a-z0-9₹]+/).filter((w) => w.length > 2))

  const scored = facts.map((f) => {
    const fw = f.text.toLowerCase().split(/[^a-z0-9₹]+/).filter((w) => w.length > 2)
    const overlap = fw.filter((w) => words.has(w)).length
    let score = overlap / Math.max(4, fw.length)
    if (f.kind === 'correction') score += 0.25 // a correction the user made once should stick
    if (f.scope?.fileId && f.scope.fileId === scope.fileId) score += 0.4
    if (f.scope?.folderId && f.scope.folderId === scope.folderId) score += 0.2
    score += Math.min(f.hits, 5) * 0.03
    return { fact: f, score }
  })

  return scored
    .filter((s) => s.score > 0.12)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.fact)
}

function similarity(a: string, b: string): number {
  const A = new Set(a.toLowerCase().split(/\W+/).filter(Boolean))
  const B = new Set(b.toLowerCase().split(/\W+/).filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  return shared / Math.max(A.size, B.size)
}

// -------------------------------------------------------------- session grants

/**
 * "Allow for the rest of this chat" - scoped to one thread and one tool, and
 * dropped after an hour. Broad standing permission is exactly what we do not
 * want for a tool that edits money.
 */
export async function grantTool(userId: string, threadId: string, toolName: string): Promise<void> {
  await kv().sadd(K.grants(userId, threadId), toolName)
  await kv().expire(K.grants(userId, threadId), 60 * 60)
}

export async function isGranted(userId: string, threadId: string, toolName: string): Promise<boolean> {
  const grants = await kv().smembers(K.grants(userId, threadId))
  return grants.includes(toolName)
}

export async function revokeGrants(userId: string, threadId: string): Promise<void> {
  await kv().del(K.grants(userId, threadId))
}
