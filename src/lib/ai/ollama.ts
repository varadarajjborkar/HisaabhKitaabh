import { env } from '../env'

/**
 * Ollama client (Cloud or self-hosted).
 *
 * Uses the native /api/chat endpoint rather than the OpenAI compatibility
 * shim, because native gives us `format` for schema-constrained JSON and
 * `keep_alive`, and its tool-call shape is stable across the models we use.
 *
 * Set OLLAMA_HOST=https://ollama.com with OLLAMA_API_KEY for Cloud, or
 * http://127.0.0.1:11434 with no key for a local daemon.
 */

export type ToolSpec = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  }
}

export type ToolCall = {
  id?: string
  function: { name: string; arguments: Record<string, unknown> }
}

export type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_name?: string }

export type ChatOptions = {
  model?: string
  messages: Msg[]
  tools?: ToolSpec[]
  /** JSON schema for a constrained response — used by the extraction agents. */
  format?: Record<string, unknown> | 'json'
  temperature?: number
  numCtx?: number
  maxTokens?: number
  signal?: AbortSignal
}

export type ChatChunk =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'done'; reason: string; usage?: { promptTokens: number; completionTokens: number; ms: number } }

export class AiNotConfiguredError extends Error {
  constructor() {
    super('The assistant is not configured. Add OLLAMA_API_KEY to your environment.')
    this.name = 'AiNotConfiguredError'
  }
}

export class AiError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'AiError'
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (env.ollama.apiKey) h.authorization = `Bearer ${env.ollama.apiKey}`
  return h
}

function body(opts: ChatOptions, stream: boolean) {
  return JSON.stringify({
    model: opts.model ?? env.ollama.chatModel,
    messages: opts.messages,
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    ...(opts.format ? { format: opts.format } : {}),
    stream,
    keep_alive: '10m',
    options: {
      temperature: opts.temperature ?? 0.2,
      num_ctx: opts.numCtx ?? 16384,
      ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
    },
  })
}

/** Streaming chat. Yields text deltas and tool calls as they arrive. */
export async function* streamChat(opts: ChatOptions): AsyncGenerator<ChatChunk> {
  if (!env.ollama.enabled) throw new AiNotConfiguredError()
  const started = Date.now()

  const res = await fetch(`${env.ollama.host}/api/chat`, {
    method: 'POST',
    headers: headers(),
    body: body(opts, true),
    signal: opts.signal,
  })
  if (!res.ok || !res.body) {
    throw new AiError(await describeFailure(res), res.status)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let usage: { promptTokens: number; completionTokens: number; ms: number } | undefined

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // NDJSON: one JSON object per line.
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue

      let evt: {
        message?: { content?: string; tool_calls?: ToolCall[] }
        done?: boolean
        done_reason?: string
        error?: string
        prompt_eval_count?: number
        eval_count?: number
      }
      try {
        evt = JSON.parse(line)
      } catch {
        continue
      }
      if (evt.error) throw new AiError(evt.error)

      if (evt.message?.content) yield { kind: 'text', text: evt.message.content }
      for (const call of evt.message?.tool_calls ?? []) {
        yield { kind: 'tool_call', call: normalizeCall(call) }
      }
      if (evt.done) {
        usage = {
          promptTokens: evt.prompt_eval_count ?? 0,
          completionTokens: evt.eval_count ?? 0,
          ms: Date.now() - started,
        }
        yield { kind: 'done', reason: evt.done_reason ?? 'stop', usage }
      }
    }
  }
  if (!usage) yield { kind: 'done', reason: 'eof', usage: { promptTokens: 0, completionTokens: 0, ms: Date.now() - started } }
}

/** One-shot chat. Used by the sub-agents that don't need to stream. */
export async function chat(opts: ChatOptions): Promise<{ content: string; toolCalls: ToolCall[] }> {
  if (!env.ollama.enabled) throw new AiNotConfiguredError()
  const res = await fetch(`${env.ollama.host}/api/chat`, {
    method: 'POST',
    headers: headers(),
    body: body(opts, false),
    signal: opts.signal,
  })
  if (!res.ok) throw new AiError(await describeFailure(res), res.status)
  const data = (await res.json()) as { message?: { content?: string; tool_calls?: ToolCall[] }; error?: string }
  if (data.error) throw new AiError(data.error)
  return {
    content: data.message?.content ?? '',
    toolCalls: (data.message?.tool_calls ?? []).map(normalizeCall),
  }
}

/** Schema-constrained JSON. The reliable way to get structured data out. */
export async function chatJson<T>(opts: ChatOptions & { schema: Record<string, unknown> }): Promise<T> {
  const { content } = await chat({ ...opts, format: opts.schema, temperature: opts.temperature ?? 0 })
  try {
    return JSON.parse(content) as T
  } catch {
    // Some models wrap JSON in prose or a fence even under `format`.
    const match = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (!match) throw new AiError('The model did not return usable JSON')
    return JSON.parse(match[0]) as T
  }
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (!env.ollama.enabled) throw new AiNotConfiguredError()
  const res = await fetch(`${env.ollama.host}/api/embed`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ model: env.ollama.embedModel, input: texts }),
  })
  if (!res.ok) throw new AiError(await describeFailure(res), res.status)
  const data = (await res.json()) as { embeddings: number[][] }
  return data.embeddings
}

/** Arguments sometimes arrive as a JSON string rather than an object. */
function normalizeCall(call: ToolCall): ToolCall {
  const args = call.function?.arguments
  if (typeof args === 'string') {
    try {
      return { ...call, function: { ...call.function, arguments: JSON.parse(args) } }
    } catch {
      return { ...call, function: { ...call.function, arguments: { _raw: args } } }
    }
  }
  return call
}

async function describeFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (res.status === 401 || res.status === 403) return 'Ollama rejected the API key. Check OLLAMA_API_KEY.'
  if (res.status === 404) return `Model not found on the Ollama host. Check OLLAMA_CHAT_MODEL.`
  if (res.status === 429) return 'Ollama is rate-limiting this key right now. Try again shortly.'
  return `Ollama request failed (${res.status})${text ? `: ${text.slice(0, 300)}` : ''}`
}

export async function listModels(): Promise<string[]> {
  if (!env.ollama.enabled) return []
  try {
    const res = await fetch(`${env.ollama.host}/api/tags`, { headers: headers() })
    if (!res.ok) return []
    const data = (await res.json()) as { models?: Array<{ name: string }> }
    return (data.models ?? []).map((m) => m.name)
  } catch {
    return []
  }
}
