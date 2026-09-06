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
  /** JSON schema for a constrained response - used by the extraction agents. */
  format?: Record<string, unknown> | 'json'
  temperature?: number
  numCtx?: number
  maxTokens?: number
  signal?: AbortSignal
}

export type ChatChunk =
  | { kind: 'text'; text: string }
  /** Reasoning models stream a separate `thinking` channel; it is never shown as the answer. */
  | { kind: 'thinking'; text: string }
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
      // Reasoning models spend tokens on `thinking` before writing a single
      // token of answer. A budget sized only for the answer returns an empty
      // string, so the floor here is deliberately generous.
      num_predict: opts.maxTokens ?? 4096,
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
        message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] }
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

      if (evt.message?.thinking) yield { kind: 'thinking', text: evt.message.thinking }
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
export async function chat(opts: ChatOptions): Promise<{ content: string; thinking: string; toolCalls: ToolCall[] }> {
  if (!env.ollama.enabled) throw new AiNotConfiguredError()
  const res = await fetch(`${env.ollama.host}/api/chat`, {
    method: 'POST',
    headers: headers(),
    body: body(opts, false),
    signal: opts.signal,
  })
  if (!res.ok) throw new AiError(await describeFailure(res), res.status)
  const data = (await res.json()) as { message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] }; error?: string }
  if (data.error) throw new AiError(data.error)
  return {
    content: data.message?.content ?? '',
    thinking: data.message?.thinking ?? '',
    toolCalls: (data.message?.tool_calls ?? []).map(normalizeCall),
  }
}

/**
 * Structured output, via a tool call.
 *
 * Measured behaviour on this endpoint, not a guess: the `format` parameter -
 * both a JSON Schema and plain `"json"` - is accepted and then ignored. Models
 * answer with markdown-fenced JSON whose field names are their own invention.
 * Tool-call arguments, by contrast, come back as real objects that respect the
 * top-level schema.
 *
 * So structured extraction is a tool call the model is told to make exactly
 * once. Nested item keys still drift between models (`description` where the
 * schema said `title`), so every caller runs the result through a coercion
 * step rather than trusting the shape.
 */
export async function chatStructured<T>(opts: ChatOptions & {
  toolName: string
  schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  description?: string
}): Promise<T | null> {
  const tool: ToolSpec = {
    type: 'function',
    function: {
      name: opts.toolName,
      description: opts.description ?? 'Report the result in structured form. Call this exactly once.',
      parameters: opts.schema,
    },
  }
  const { toolCalls, content } = await chat({ ...opts, tools: [tool], temperature: opts.temperature ?? 0 })

  const call = toolCalls.find((c) => c.function.name === opts.toolName) ?? toolCalls[0]
  if (call?.function?.arguments && typeof call.function.arguments === 'object') {
    return call.function.arguments as T
  }
  // Some models answer in prose instead of calling the tool. Salvage what we can.
  const salvaged = extractJson(content)
  return (salvaged as T) ?? null
}

/**
 * Pull a JSON value out of a model response.
 * Handles fenced blocks, leading prose, and trailing commentary - all of which
 * this endpoint produces even when asked not to.
 */
export function extractJson(text: string): unknown | null {
  if (!text) return null
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = [fenced?.[1], text].filter(Boolean) as string[]

  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    try {
      return JSON.parse(trimmed)
    } catch {
      /* try to locate a balanced value inside it */
    }
    const start = trimmed.search(/[{[]/)
    if (start < 0) continue
    const open = trimmed[start]
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1))
          } catch {
            break
          }
        }
      }
    }
  }
  return null
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

