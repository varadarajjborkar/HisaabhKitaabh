import type { AttachmentRef, Session } from '../model/types'
import type { Repo } from '../store/repo'
import { ConflictError } from '../store/repo'
import { computeTotals } from '../crdt/doc'
import { K, kv } from '../store/kv'
import { shortId } from '../util/ids'
import { AiNotConfiguredError, streamChat, type Msg, type ToolCall } from './ollama'
import { ALWAYS_TOOLS, TOOL_MAP, toolSpecs, type ToolCtx, type ToolDef, type ToolPlan } from './tools'
import { analystTool, buildSystemPrompt, extractTool } from './agents'
import { allowedTools, selectSkills, toolBudget, type Skill } from './skills'
import { appendMessage, getSummary, isGranted, grantTool, recallFacts, recentMessages } from './memory'
import { rateLimit } from '../store/locks'
import { chartRecord, type ChartSpec } from './chart'
import { TextGate, type ToolShape } from './leak'

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
  /**
   * Every tool call already made this run, keyed by name plus arguments, with
   * a one-line record of how it went. Repeats are answered from here instead
   * of being run again.
   */
  callLog?: Record<string, string>
  /** Consecutive failures, reset by any success. */
  failures?: number
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
  /** A chart the assistant drew from the rows. Nothing is written, so nothing is approved. */
  | { type: 'chart'; spec: ChartSpec }
  | { type: 'applied'; fileId: string; rev: number; total: number; rowCount: number; summary: string; currency?: string }
  | { type: 'conflict'; message: string; fileId: string }
  | { type: 'location'; label: string }
  | { type: 'settings'; format: string }
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
  list_columns: 'Checking the columns',
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
  rename_column: 'Preparing a rename',
  delete_column: 'Preparing to remove a column',
  rename_file: 'Preparing to rename the file',
  create_file: 'Preparing a new file',
  create_folder: 'Preparing a new folder',
  ask_user: 'Asking you',
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
  /** The user has asked for answers as charts. A per-message flag, not a memory. */
  graphMode?: boolean
}): Promise<AsyncGenerator<AgentEvent>> {
  const { session, repo, threadId, fileId, folderId, message, inbox } = params
  const graphMode = params.graphMode ?? false

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
    graphMode,
  })

  const messages: Msg[] = [{ role: 'system', content: system }]
  for (const m of history) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant' && m.content) messages.push({ role: 'assistant', content: m.content })
  }

  /*
   * Where the conversation is standing, written into the conversation.
   *
   * One thread follows the user around rather than a separate thread per file,
   * because the questions worth asking are not file-shaped: comparing two
   * trips, charting across a folder, "what did I call that column in the other
   * one". A thread per file has nowhere to put any of those, and nowhere at
   * all to put a conversation started from the home screen.
   *
   * But the thread moving silently is what went wrong before. The scope was
   * sent with every message and the system prompt described the current file,
   * so the model was told it was in Bangalore while reading a conversation
   * about Goa, with nothing between the two saying a move had happened. "Add a
   * column" then means one thing to the user and something else in the history.
   *
   * So a move is an event in the transcript, in order, visible to both sides.
   * After the marker "add a column" can only mean the file named in it, and
   * the file before it is still named for anything that refers back.
   */
  const here = locationLabel(scope)
  const before = lastLocation(history)
  const moved = before != null && before !== here
  if (moved) {
    const marker = `[the user is now in ${here}, having been in ${before}. Later requests mean this one unless they name another.]`
    messages.push({ role: 'assistant', content: marker })
    await appendMessage(session.userId, threadId, { role: 'assistant', content: marker, meta: { location: here } })
  }

  const userContent = inbox.length
    ? `${message}\n\n[Attached: ${inbox.map((a) => `${a.name} (${a.mime})`).join(', ')}]`
    : message
  messages.push({ role: 'user', content: userContent })

  await appendMessage(session.userId, threadId, {
    role: 'user',
    content: message,
    meta: { fileId, folderId, at: here, attachments: inbox.map((a) => a.name) },
  })

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
    callLog: {},
    failures: 0,
    assistantText: '',
  }

  const run = runLoop(state, { session, repo, skills, first: true })
  if (!moved) return run
  return (async function* () {
    yield { type: 'location', label: here } as AgentEvent
    yield* run
  })()
}

/**
 * Where the conversation is standing, as one line.
 *
 * Deliberately the same phrasing the user would use for the place, so a marker
 * in the transcript reads as a sentence rather than as an id.
 */
function locationLabel(scope: { fileName?: string; folderName?: string }): string {
  if (scope.fileName) return scope.folderName ? `"${scope.fileName}" in ${scope.folderName}` : `"${scope.fileName}"`
  if (scope.folderName) return `the folder ${scope.folderName}`
  return 'the home screen'
}

/**
 * The place the last message was sent from, or null.
 *
 * Null for a thread that predates this being recorded, which is the right
 * answer: without a previous place there is no move to announce, and
 * inventing one would put a marker at the top of every old conversation.
 */
function lastLocation(history: Array<{ role: string; meta?: Record<string, unknown> }>): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const at = history[i].meta?.at
    if (history[i].role === 'user' && typeof at === 'string') return at
  }
  return null
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
      currency: result.doc.currency,
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
  const shapes: ToolShape[] = specs.map((s) => ({
    name: s.function.name,
    properties: Object.keys(s.function.parameters.properties),
    required: s.function.parameters.required ?? [],
  }))

  try {
    for (let turn = 0; turn < 8; turn++) {
      let text = ''
      let announcedThinking = false
      const calls: ToolCall[] = []
      const gate = new TextGate(shapes)

      for await (const chunk of streamChat({ messages: state.messages, tools: specs, temperature: 0.2, numCtx: 24576 })) {
        if (chunk.kind === 'text') {
          // Not every token is for the user: see leak.ts. What comes back here
          // is the text; what the gate keeps is a call the model typed out.
          const safe = gate.push(chunk.text)
          if (safe) {
            text += safe
            yield { type: 'text', delta: safe }
          }
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

      /*
       * A call the model wrote instead of making becomes the call it meant.
       *
       * Only when it made none of its own: a model that narrates a call it is
       * also making is describing itself, and running that twice would add the
       * same rows twice. Either way the JSON stays off the screen, and the
       * history below records a tool call rather than the prose, so the next
       * turn sees the shape it should have used.
       */
      const kept = gate.end()
      if (kept.calls.length > 0 && calls.length === 0) {
        for (const call of kept.calls) calls.push(call)
      } else if (kept.calls.length === 0 && kept.text) {
        text += kept.text
        yield { type: 'text', delta: kept.text }
      }

      state.assistantText += text
      state.messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) })

      if (calls.length === 0) {
        /*
         * A turn is allowed to end without calling anything. It is not allowed
         * to end without saying anything: the model occasionally stops after a
         * tool result with no closing message, and what the user sees then is a
         * spinner that quietly stopped and no reply. Whatever else happened,
         * there is always an answer in the box.
         */
        if (!state.assistantText.trim()) {
          const fallback = state.toolCallsUsed > 0
            ? 'I read what I could but did not get to an answer. Tell me which file you mean and I will try again.'
            : 'I did not follow that. Say it another way and I will have another go.'
          state.assistantText = fallback
          state.messages[state.messages.length - 1].content = fallback
          yield { type: 'text', delta: fallback }
        }
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

        const tool = TOOL_MAP.get(call.function.name)
        if (!tool) {
          state.messages.push({ role: 'tool', content: `No tool called "${call.function.name}" exists. Available: ${names.join(', ')}`, tool_name: call.function.name })
          continue
        }

        /*
         * Repeat suppression.
         *
         * A model that hits an error it cannot interpret will often try the
         * identical call again, then a neighbouring one, then the first again:
         * the transcript fills with "looking through your files" while nothing
         * changes. Read tools are pure within a turn, so an identical call has
         * an identical answer, and the honest reply is the one already given
         * plus a nudge to do something different. Write tools are excluded:
         * "add the same two rows again" is a legitimate thing to ask for.
         */
        const signature = `${tool.name}:${stableArgs(call.function.arguments)}`
        const previous = tool.mode === 'read' ? state.callLog?.[signature] : undefined
        if (previous) {
          yield { type: 'tool_start', name: tool.name, label: TOOL_LABELS[tool.name] ?? tool.name.replace(/_/g, ' ') }
          yield { type: 'tool_result', name: tool.name, ok: true, summary: 'already answered' }
          state.messages.push({
            role: 'tool',
            content: `You already called ${tool.name} with these arguments in this turn. The answer was: ${previous} Use it. Calling it again will not change anything - either act on what you have, ask the user, or say what is blocking you.`,
            tool_name: tool.name,
          })
          continue
        }

        state.toolCallsUsed++
        yield { type: 'tool_start', name: tool.name, label: TOOL_LABELS[tool.name] ?? tool.name.replace(/_/g, ' ') }

        let result
        try {
          result = await tool.run(call.function.arguments ?? {}, ctx)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          yield { type: 'tool_result', name: tool.name, ok: false, summary: message }
          state.messages.push({ role: 'tool', content: noteFailure(state, signature, `Error: ${message}`), tool_name: tool.name })
          if (tooManyFailures(state)) break
          continue
        }

        if (result.kind === 'error') {
          yield { type: 'tool_result', name: tool.name, ok: false, summary: result.message }
          state.messages.push({ role: 'tool', content: noteFailure(state, signature, `Could not do that: ${result.message}`), tool_name: tool.name })
          if (tooManyFailures(state)) break
          continue
        }

        state.failures = 0

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
          const digest = result.display ?? summarise(tool.name, result.data)
          state.callLog = { ...(state.callLog ?? {}), [signature]: digest }
          yield { type: 'tool_result', name: tool.name, ok: true, summary: digest }

          // A chart goes to the transcript as a chart. The model still gets the
          // figures as text, so it can say something about what it drew rather
          // than narrating a picture it cannot see.
          // A preference the assistant changed reaches the page it is displayed on,
    // rather than waiting for a reload to be noticed.
    const changed = result.data as { format?: string; changed?: boolean } | null
    if (changed?.changed && changed.format) yield { type: 'settings', format: changed.format }

    const drawn = (result.data as { chart?: ChartSpec } | null)?.chart
          if (drawn) {
            yield { type: 'chart', spec: drawn }
            /*
             * A chart has to outlive the turn that drew it.
             *
             * The tool result is only in front of the model until this run
             * ends; the next turn is rebuilt from the stored thread, and a
             * chart that was never stored simply did not happen. Since the
             * conversation after a chart is usually about the chart, it is
             * written down as a line of text the next prompt will read, with
             * the full spec alongside it so reopening the conversation can draw
             * it again rather than showing a gap where a picture was.
             */
            await appendMessage(session.userId, state.threadId, {
              role: 'assistant',
              content: chartRecord(drawn),
              toolName: 'make_chart',
              meta: { chart: drawn },
            })
          }
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

/**
 * A stable key for a set of arguments.
 *
 * `JSON.stringify` orders keys by insertion, so the same call arriving with its
 * fields in a different order would look like a different call and slip past
 * the repeat check. Sorting makes the signature depend on the arguments rather
 * than on how the model happened to emit them.
 */
function stableArgs(args: unknown): string {
  if (args == null || typeof args !== 'object') return String(args ?? '')
  const entries = Object.entries(args as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return JSON.stringify(entries)
}

const MAX_CONSECUTIVE_FAILURES = 3

function noteFailure(state: RunState, signature: string, message: string): string {
  state.failures = (state.failures ?? 0) + 1
  state.callLog = { ...(state.callLog ?? {}), [signature]: message }
  if ((state.failures ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    return `${message}\n\nThat is ${state.failures} tool calls in a row that failed. Stop calling tools. Tell the user what you were trying to do and what went wrong, in one or two sentences.`
  }
  return message
}

/**
 * Give up on tools after a run of failures.
 *
 * Without this, a model that has lost the thread keeps calling into the same
 * wall until the budget runs out, and the user watches a column of warning
 * triangles accumulate for twenty seconds before getting an answer. Three
 * strikes and the turn goes back to producing text.
 */
function tooManyFailures(state: RunState): boolean {
  return (state.failures ?? 0) >= MAX_CONSECUTIVE_FAILURES
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
        currency: doc.currency,
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
