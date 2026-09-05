import type { AttachmentRef, Session } from '../model/types'
import type { Repo } from '../store/repo'
import { ConflictError } from '../store/repo'
import { computeTotals } from '../crdt/doc'
import { K, kv } from '../redis'
import { shortId } from '../util/ids'
import { AiNotConfiguredError, streamChat, type Msg, type ToolCall } from './ollama'
import { ALWAYS_TOOLS, TOOL_MAP, toolSpecs, type ToolCtx, type ToolDef, type ToolPlan } from './tools'
import { analystTool, buildSystemPrompt, extractTool } from './agents'
import { allowedTools, selectSkills, toolBudget, type Skill } from './skills'
import { appendMessage, getSummary, isGranted, grantTool, recallFacts, recentMessages } from './memory'
import { rateLimit } from '../store/locks'

/** Specialist tools are registered here so the loop and the skill router agree. */
TOOL_MAP.set(extractTool.name, extractTool)
TOOL_MAP.set(analystTool.name, analystTool)

export type PendingAction = {
  actionId: string
  toolName: string
  risk: ToolDef['risk']
  summary: string
  preview: string[]
  diff?: Array<{ label: string; before: string; after: string }>
  plan: ToolPlan
  /** Revision the plan was built against - re-checked at apply time. */
  baseRev: number
  createdAt: number
}

export type RunState = {
  runId: string
  threadId: string
  userId: string
  fileId: string | null
  folderId: string | null
  messages: Msg[]
  inbox: AttachmentRef[]
  skillNames: string[]
  toolCallsUsed: number
  budget: number
  pending?: PendingAction
  assistantText: string
}

export type AgentEvent =
  | { type: 'run'; runId: string; skills: string[] }
  | { type: 'text'; delta: string }
  /** Reasoning models emit a separate channel before the answer. Shown as a status, never as the reply. */
  | { type: 'thinking' }
  | { type: 'tool_start'; name: string; label: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'permission'; action: PendingAction }
  | { type: 'ask'; question: string; options: string[] }
  | { type: 'applied'; fileId: string; rev: number; total: number; rowCount: number; summary: string }
  | { type: 'conflict'; message: string; fileId: string }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; reason: 'complete' | 'awaiting_permission' | 'awaiting_answer' | 'budget' | 'error' }

const RUN_TTL = 60 * 30

export async function saveRun(state: RunState): Promise<void> {
  await kv().set(`run:${state.userId}:${state.runId}`, state, { ex: RUN_TTL })
}
export async function loadRun(userId: string, runId: string): Promise<RunState | null> {
  return kv().get<RunState>(`run:${userId}:${runId}`)
}
export async function dropRun(userId: string, runId: string): Promise<void> {
  await kv().del(`run:${userId}:${runId}`)
}

/** Friendly label for the "working…" line in the transcript. */
const TOOL_LABELS: Record<string, string> = {
  get_file: 'Reading the file',
  list_files: 'Looking through your files',
  list_folders: 'Looking through your folders',
  query_rows: 'Searching rows',
  compute_stats: 'Adding up the numbers',
  read_attachment: 'Opening the attachment',
  extract_from_document: 'Reading the document',
  deep_analysis: 'Analysing',
  build_export: 'Formatting the export',
  add_rows: 'Preparing new rows',
  update_rows: 'Preparing edits',
  delete_rows: 'Preparing deletions',
  add_column: 'Preparing a new column',
  set_period: 'Setting the period',
}

// -------------------------------------------------------------------- start

export async function startRun(params: {
  session: Session
  repo: Repo
  threadId: string
  fileId: string | null
  folderId: string | null
  message: string
  inbox: AttachmentRef[]
}): Promise<AsyncGenerator<AgentEvent>> {
  const { session, repo, threadId, fileId, folderId, message, inbox } = params

  const gate = await rateLimit(session.userId, 'chat', 40, 60)
  if (!gate.ok) {
    return (async function* () {
      yield { type: 'error', message: 'You are sending messages faster than the assistant can keep up. Give it a minute.', fatal: true }
      yield { type: 'done', reason: 'error' }
    })()
  }

  const skills = selectSkills(message, { hasAttachment: inbox.length > 0, inFile: Boolean(fileId) })

  const [facts, summary, history, storage] = await Promise.all([
    recallFacts(session.userId, message, { fileId: fileId ?? undefined, folderId: folderId ?? undefined }),
    getSummary(session.userId, threadId),
    recentMessages(session.userId, threadId, 16),
    repo.storageInfo(),
  ])

  const scope = await describeScope(repo, fileId, folderId)
  const system = buildSystemPrompt({
    userName: session.name,
    skills,
    facts,
    summary,
    scope,
    storage: storage.backend,
  })

  const messages: Msg[] = [{ role: 'system', content: system }]
  for (const m of history) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant' && m.content) messages.push({ role: 'assistant', content: m.content })
  }
  const userContent = inbox.length
    ? `${message}\n\n[Attached: ${inbox.map((a) => `${a.name} (${a.mime})`).join(', ')}]`
    : message
  messages.push({ role: 'user', content: userContent })

  await appendMessage(session.userId, threadId, { role: 'user', content: message, meta: { fileId, attachments: inbox.map((a) => a.name) } })

  const state: RunState = {
    runId: shortId(14),
    threadId,
    userId: session.userId,
    fileId,
    folderId,
    messages,
    inbox,
    skillNames: skills.map((s) => s.name),
    toolCallsUsed: 0,
    budget: toolBudget(skills),
    assistantText: '',
  }

  return runLoop(state, { session, repo, skills, first: true })
}

// ------------------------------------------------------------------- resume

export type Decision = 'allow' | 'allow_always' | 'deny' | 'guide'

export async function resumeRun(params: {
  session: Session
  repo: Repo
  state: RunState
  decision: Decision
  guidance?: string
}): Promise<AsyncGenerator<AgentEvent>> {
  const { session, repo, state, decision, guidance } = params
  const pending = state.pending
  if (!pending) {
    return (async function* () {
      yield { type: 'error', message: 'That request has already been answered.', fatal: false }
      yield { type: 'done', reason: 'complete' }
    })()
  }
  delete state.pending

  const events: AgentEvent[] = []

  if (decision === 'deny' || decision === 'guide') {
    const note =
      decision === 'guide' && guidance
        ? `The user declined this change and said: "${guidance}". Follow that instead. Do not retry the same edit.`
        : 'The user declined this change. Do not retry it. Ask what they would prefer, or move on.'
    state.messages.push({ role: 'tool', content: note, tool_name: pending.toolName })
    if (decision === 'guide' && guidance) {
      state.messages.push({ role: 'user', content: guidance })
      await appendMessage(session.userId, state.threadId, { role: 'user', content: guidance })
    }
  } else {
    if (decision === 'allow_always') await grantTool(session.userId, state.threadId, pending.toolName)
    const outcome = await applyPlan(repo, session, pending)
    events.push(...outcome.events)
    state.messages.push({ role: 'tool', content: outcome.toolMessage, tool_name: pending.toolName })
  }

  return runLoop(state, { session, repo, skills: [], first: false, replay: events })
}

// ---------------------------------------------------------------- apply plan

async function applyPlan(
  repo: Repo,
  session: Session,
  pending: PendingAction,
): Promise<{ events: AgentEvent[]; toolMessage: string }> {
  const { plan } = pending
  const events: AgentEvent[] = []

  try {
    // Structural creates carry an encoded intent rather than document ops.
    if (plan.fileId.startsWith('create:folder:')) {
      const name = plan.fileId.slice('create:folder:'.length)
      const folder = await repo.createFolder({ name })
      events.push({ type: 'applied', fileId: folder.id, rev: 0, total: 0, rowCount: 0, summary: `Created folder "${folder.name}"` })
      return { events, toolMessage: `Created folder "${folder.name}" (folderId ${folder.id}).` }
    }
    if (plan.fileId.startsWith('create:file:')) {
      const [, , folderId, ...rest] = plan.fileId.split(':')
      const doc = await repo.createFile({ folderId, name: rest.join(':') })
      events.push({ type: 'applied', fileId: doc.id, rev: doc.rev, total: 0, rowCount: 0, summary: `Created file "${doc.name}"` })
      return { events, toolMessage: `Created file "${doc.name}" (fileId ${doc.id}) in folder ${folderId}.` }
    }

    const result = await repo.mutate(plan.fileId, {
      // The revision the plan was built against. If the user edited the file
      // while the approval card was on screen, this is what catches it.
      baseRev: pending.baseRev,
      // A distinct actor id, so document stamps record who wrote what.
      actor: `ai:${session.userId}`,
      ops: plan.ops,
      label: pending.summary,
    })

    const totals = computeTotals(result.doc)
    events.push({
      type: 'applied',
      fileId: result.doc.id,
      rev: result.doc.rev,
      total: totals.total,
      rowCount: totals.count,
      summary: pending.summary,
    })

    const notes: string[] = [`Applied. The file is now at revision ${result.doc.rev} with ${totals.count} rows totalling ${totals.total}.`]
    if (result.superseded.length) notes.push(`${result.superseded.length} operation(s) were skipped because a newer edit already covered them.`)
    if (result.rejected.length) notes.push(`Rejected: ${result.rejected.map((r) => r.reason).join('; ')}`)
    return { events, toolMessage: notes.join(' ') }
  } catch (err) {
    if (err instanceof ConflictError) {
      const message = 'The file changed while this was waiting for approval, so the edit was not applied.'
      events.push({ type: 'conflict', message, fileId: plan.fileId })
      return {
        events,
        toolMessage: `${message} Call get_file to read the current state, then propose the change again against the new data. Tell the user this happened.`,
      }
    }
    const message = err instanceof Error ? err.message : 'The change could not be applied.'
    events.push({ type: 'error', message, fatal: false })
    return { events, toolMessage: `The change failed: ${message}. Tell the user plainly; do not retry silently.` }
  }
}

// ---------------------------------------------------------------- the loop

async function* runLoop(
  state: RunState,
  opts: { session: Session; repo: Repo; skills: Skill[]; first: boolean; replay?: AgentEvent[] },
): AsyncGenerator<AgentEvent> {
  const { session, repo } = opts

  if (opts.first) yield { type: 'run', runId: state.runId, skills: state.skillNames }
  for (const e of opts.replay ?? []) yield e

  const ctx: ToolCtx = {
    repo,
    userId: session.userId,
    fileId: state.fileId,
    folderId: state.folderId,
    inbox: state.inbox,
  }

  const skills = opts.skills.length ? opts.skills : selectSkills(lastUserText(state), { hasAttachment: state.inbox.length > 0, inFile: Boolean(state.fileId) })
  const names = allowedTools(skills, [...ALWAYS_TOOLS, 'extract_from_document', 'deep_analysis', ...WRITE_TOOL_NAMES])
  const specs = toolSpecs(names)

  try {
    for (let turn = 0; turn < 8; turn++) {
      let text = ''
      let announcedThinking = false
      const calls: ToolCall[] = []

      for await (const chunk of streamChat({ messages: state.messages, tools: specs, temperature: 0.2, numCtx: 24576 })) {
        if (chunk.kind === 'text') {
          text += chunk.text
          yield { type: 'text', delta: chunk.text }
        } else if (chunk.kind === 'thinking') {
          // The reasoning channel is not the answer, and showing it as one
          // would put half-formed conclusions in front of the user. It becomes
          // a single "thinking" status instead.
          if (!announcedThinking) {
            announcedThinking = true
            yield { type: 'thinking' }
          }
        } else if (chunk.kind === 'tool_call') {
          calls.push(chunk.call)
        }
      }

      state.assistantText += text
      state.messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) })

      if (calls.length === 0) {
        await finish(state, session, repo)
        yield { type: 'done', reason: 'complete' }
        return
      }

      for (const call of calls) {
        if (state.toolCallsUsed >= state.budget) {
          state.messages.push({
            role: 'tool',
            content: 'Tool budget for this request is spent. Summarise what you did and what is still outstanding, then stop.',
            tool_name: call.function.name,
          })
          break
        }
        state.toolCallsUsed++

        const tool = TOOL_MAP.get(call.function.name)
        if (!tool) {
          state.messages.push({ role: 'tool', content: `No tool called "${call.function.name}" exists. Available: ${names.join(', ')}`, tool_name: call.function.name })
          continue
        }

        yield { type: 'tool_start', name: tool.name, label: TOOL_LABELS[tool.name] ?? tool.name.replace(/_/g, ' ') }

        let result
        try {
          result = await tool.run(call.function.arguments ?? {}, ctx)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          yield { type: 'tool_result', name: tool.name, ok: false, summary: message }
          state.messages.push({ role: 'tool', content: `Error: ${message}`, tool_name: tool.name })
          continue
        }

        if (result.kind === 'error') {
          yield { type: 'tool_result', name: tool.name, ok: false, summary: result.message }
          state.messages.push({ role: 'tool', content: `Could not do that: ${result.message}`, tool_name: tool.name })
          continue
        }

        if (result.kind === 'ask') {
          state.pending = undefined
          await saveRun(state)
          yield { type: 'ask', question: result.question, options: result.options }
          await finish(state, session, repo)
          yield { type: 'done', reason: 'awaiting_answer' }
          return
        }

        if (result.kind === 'data') {
          const payload = JSON.stringify(result.data)
          yield { type: 'tool_result', name: tool.name, ok: true, summary: summarise(tool.name, result.data) }
          state.messages.push({
            role: 'tool',
            // Cap the payload: a huge tool result crowds out the conversation
            // and is the usual cause of a model losing the thread mid-task.
            content: payload.length > 24000 ? payload.slice(0, 24000) + '\n…(truncated, narrow the query)' : payload,
            tool_name: tool.name,
          })
          continue
        }

        // result.kind === 'plan' - a write. This is the gate.
        const plan = result.plan
        const baseRev = plan.fileId.startsWith('create:') ? 0 : (await repo.getDoc(plan.fileId)).rev

        const pending: PendingAction = {
          actionId: shortId(12),
          toolName: tool.name,
          risk: tool.risk,
          summary: plan.summary,
          preview: plan.preview,
          diff: plan.diff,
          plan,
          baseRev,
          createdAt: Date.now(),
        }

        if (await isGranted(session.userId, state.threadId, tool.name)) {
          const outcome = await applyPlan(repo, session, pending)
          for (const e of outcome.events) yield e
          yield { type: 'tool_result', name: tool.name, ok: true, summary: plan.summary }
          state.messages.push({ role: 'tool', content: outcome.toolMessage, tool_name: tool.name })
          continue
        }

        state.pending = pending
        await saveRun(state)
        yield { type: 'permission', action: pending }
        yield { type: 'done', reason: 'awaiting_permission' }
        return
      }
    }

    await finish(state, session, repo)
    yield { type: 'done', reason: 'budget' }
  } catch (err) {
    const fatal = err instanceof AiNotConfiguredError
    const message = err instanceof Error ? err.message : 'The assistant hit an unexpected error.'
    yield { type: 'error', message, fatal }
    yield { type: 'done', reason: 'error' }
  }
}

const WRITE_TOOL_NAMES = [
  'add_rows', 'update_rows', 'delete_rows', 'add_column', 'rename_column',
  'delete_column', 'set_period', 'rename_file', 'create_file', 'create_folder',
]

async function finish(state: RunState, session: Session, _repo: Repo): Promise<void> {
  if (state.assistantText.trim()) {
    await appendMessage(session.userId, state.threadId, { role: 'assistant', content: state.assistantText.trim() })
  }
  await dropRun(session.userId, state.runId)
  // Compaction runs after the answer is out; never in front of it.
  void import('./memory').then((m) => m.maybeCompact(session.userId, state.threadId)).catch(() => {})
}

function lastUserText(state: RunState): string {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i]
    if (m.role === 'user') return m.content
  }
  return ''
}

function summarise(toolName: string, data: unknown): string {
  const d = data as Record<string, unknown>
  if (toolName === 'query_rows') return `${d.matchCount ?? 0} row(s) matched`
  if (toolName === 'get_file') return `${d.rowCount ?? 0} rows, total ${d.total ?? 0}`
  if (toolName === 'list_files') return `${Array.isArray(d) ? d.length : 0} file(s)`
  if (toolName === 'list_folders') return `${Array.isArray(d) ? d.length : 0} folder(s)`
  if (toolName === 'compute_stats') return `total ${d.total ?? 0} across ${d.rows ?? 0} rows`
  if (toolName === 'extract_from_document') return `${d.rowsFound ?? 0} line item(s) read from ${d.source ?? 'the document'}`
  return 'done'
}

async function describeScope(repo: Repo, fileId: string | null, folderId: string | null) {
  try {
    if (fileId) {
      const doc = await repo.getDoc(fileId)
      const totals = computeTotals(doc)
      const folder = await repo.getFolder(doc.folderId).catch(() => null)
      return {
        fileName: doc.name,
        folderName: folder?.name,
        columns: doc.columns.map((c) => `${c.name} (${c.kind})`),
        rowCount: totals.count,
        total: totals.total,
        period: doc.duration.enabled ? `${doc.duration.from ?? '?'} → ${doc.duration.to ?? '?'}` : null,
      }
    }
    if (folderId) {
      const folder = await repo.getFolder(folderId)
      return { folderName: folder.name }
    }
  } catch {
    /* scope is a nicety; a missing file shouldn't break the chat */
  }
  return {}
}

export { K }
