/**
 * A tool call the model wrote as prose.
 *
 * Models that support tool calling still, sometimes, type the call out instead
 * of making it: the JSON arrives on the text channel and the user watches
 *
 *     { "question": "What should the comparison chart show?",
 *       "options": ["Total spend per file", "Spend by category"] }
 *
 * scroll past in the transcript, followed by the model saying the same thing
 * again in words. Nothing is called, nothing is drawn, and the machinery is on
 * screen. It happens most on the turns that matter - a chart, a question -
 * because those are the calls with the biggest argument objects.
 *
 * The fix is not to filter the JSON out and drop it. The model meant to make
 * that call, and it named the tool and filled in the arguments correctly. So
 * this gate holds text back the moment it could be a call, and if it turns out
 * to be one, hands it to the caller as a real call instead of printing it.
 *
 * Two rules keep it from eating anything real:
 *
 *   - It only starts holding at a `{` that opens a line, and never inside a
 *     fenced code block, so an answer that discusses JSON is untouched.
 *   - Anything it holds that does not parse, or parses to something no tool
 *     would accept, is released as text. The cost of a false positive is a
 *     pause of a few hundred milliseconds, not a missing answer.
 */

/** What one tool will accept, which is all this file needs to know about it. */
export type ToolShape = { name: string; properties: string[]; required: string[] }

/** Structurally a ToolCall, without importing the client and its env. */
export type SalvagedCall = { function: { name: string; arguments: Record<string, unknown> } }

/**
 * How much unclosed text to hold before giving up and printing it.
 *
 * Sized well above the largest argument object a tool here takes (a make_chart
 * call with every field filled in is under 600 bytes) and well below a long
 * answer, so a genuine paragraph that happens to open with a brace is on
 * screen before anyone notices it was late.
 */
const MAX_HELD = 8000

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function_name', 'recipient_name']
const ARG_KEYS = ['arguments', 'args', 'parameters', 'params', 'input']

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Tool names travel in a few casings; the model's intent is the same. */
function canonical(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function named(name: unknown, args: Record<string, unknown>, shapes: ToolShape[]): SalvagedCall | null {
  if (typeof name !== 'string' || !name.trim()) return null
  const wanted = canonical(name)
  const shape = shapes.find((s) => s.name === wanted)
  if (!shape) return null
  return { function: { name: shape.name, arguments: args } }
}

/** The arguments out of an envelope, under whichever key it used. */
function envelopeArgs(obj: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ARG_KEYS) {
    const found = asObject(obj[key])
    if (found) return found
  }
  return null
}

/** Everything except the keys that named the tool: `{tool, question}` -> `{question}`. */
function without(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v
  return out
}

/**
 * A bare argument object, with no tool named anywhere: `{question, options}`.
 *
 * Matched by shape. A tool is a candidate when the object supplies everything
 * it requires and nothing it does not recognise, and the match has to be
 * unique - `{fileId}` fits half the read tools, and guessing between them is
 * worse than printing the line.
 */
function byShape(obj: Record<string, unknown>, shapes: ToolShape[]): SalvagedCall | null {
  const keys = Object.keys(obj)
  if (keys.length === 0) return null

  let best: ToolShape | null = null
  let bestScore = -1
  let tied = false

  for (const shape of shapes) {
    if (!keys.every((k) => shape.properties.includes(k))) continue
    if (!shape.required.every((r) => keys.includes(r))) continue
    // A tool that requires nothing matches almost anything optional; it needs
    // to earn the match by having been given every field it declares.
    const score = shape.required.length > 0 ? keys.length + shape.required.length : keys.length
    if (score > bestScore) {
      best = shape
      bestScore = score
      tied = false
    } else if (score === bestScore) {
      tied = true
    }
  }

  return best && !tied ? { function: { name: best.name, arguments: obj } } : null
}

/** The call this value was meant to be, or null if it was only ever text. */
export function salvage(value: unknown, shapes: ToolShape[]): SalvagedCall | null {
  const obj = asObject(value)
  if (!obj) return null

  // { "function": { "name": ..., "arguments": {...} } }
  const fn = asObject(obj.function)
  if (fn) {
    const call = named(fn.name, envelopeArgs(fn) ?? without(fn, NAME_KEYS), shapes)
    if (call) return call
  }

  // { "name": "make_chart", "arguments": {...} } and its several spellings,
  // including the flat one where the arguments sit beside the name.
  for (const key of NAME_KEYS) {
    const call = named(obj[key], envelopeArgs(obj) ?? without(obj, [...NAME_KEYS, ...ARG_KEYS]), shapes)
    if (call) return call
  }

  return byShape(obj, shapes)
}

type Mode = 'open' | 'holding' | 'quarantine'

/**
 * A filter over the model's text channel for one turn.
 *
 * Feed it deltas, show what it hands back, and ask it at the end of the turn
 * what it kept.
 */
export class TextGate {
  private mode: Mode = 'open'
  private held = ''
  private calls: SalvagedCall[] = []

  // Where we are in the text: inside a fence, at the head of a line, and how
  // many backticks in a row we have seen towards opening or closing one.
  private fenced = false
  private lineStart = true
  private ticks = 0
  private pendingSpace = ''

  // Where we are inside the object being held.
  private depth = 0
  private inString = false
  private escaped = false

  private shapes: ToolShape[]

  constructor(shapes: ToolShape[]) {
    this.shapes = shapes
  }

  /** The part of this delta that is safe to put on screen. */
  push(delta: string): string {
    let out = ''
    for (const ch of delta) {
      if (this.mode === 'quarantine') {
        this.held += ch
        continue
      }
      if (this.mode === 'holding') {
        out += this.consume(ch)
        continue
      }
      out += this.scan(ch)
    }
    return out
  }

  /**
   * The end of the turn: any calls found, and any text still in hand.
   *
   * When there are calls the text is scaffolding the model wrote around them
   * and the caller should drop it. When there are none it is real content that
   * was held on suspicion, and the caller should show it.
   */
  end(): { text: string; calls: SalvagedCall[] } {
    if (this.mode === 'holding') {
      // A stream that stopped mid-object. Closing it is not a guess about what
      // the model meant, only about where it stopped writing.
      const closed = this.held + '}'.repeat(this.depth)
      const call = this.mode === 'holding' && !this.inString ? this.read(closed) : null
      if (call) {
        this.calls.push(call)
        this.held = ''
      }
    }
    const text = this.pendingSpace + this.held
    const calls = this.calls
    this.held = ''
    this.pendingSpace = ''
    this.calls = []
    this.mode = 'open'
    return { text, calls }
  }

  /** Reading ordinary text, watching for a brace that opens a line. */
  private scan(ch: string): string {
    if (ch === '`') {
      this.ticks++
      if (this.ticks === 3) {
        this.fenced = !this.fenced
        this.ticks = 0
      }
      return this.release(ch, false)
    }
    this.ticks = 0

    if (ch === '\n') {
      const out = this.release(ch, true)
      this.lineStart = true
      return out
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      // Indentation before a brace belongs to the brace, so it waits with it.
      if (this.lineStart) {
        this.pendingSpace += ch
        return ''
      }
      return ch
    }

    if (ch === '{' && this.lineStart && !this.fenced) {
      this.mode = 'holding'
      this.held = '{'
      this.depth = 1
      this.inString = false
      this.escaped = false
      this.pendingSpace = ''
      return ''
    }

    return this.release(ch, false)
  }

  /** Emit a character along with any indentation that was waiting on it. */
  private release(ch: string, keepLineStart: boolean): string {
    const out = this.pendingSpace + ch
    this.pendingSpace = ''
    if (!keepLineStart) this.lineStart = false
    return out
  }

  /** Reading a candidate object, one character at a time, until it balances. */
  private consume(ch: string): string {
    this.held += ch

    if (this.escaped) {
      this.escaped = false
    } else if (this.inString) {
      if (ch === '\\') this.escaped = true
      else if (ch === '"') this.inString = false
    } else if (ch === '"') {
      this.inString = true
    } else if (ch === '{') {
      this.depth++
    } else if (ch === '}') {
      this.depth--
    }

    if (this.depth === 0) {
      const call = this.read(this.held)
      if (call) {
        this.calls.push(call)
        this.held = ''
        this.mode = 'quarantine'
        return ''
      }
      return this.giveUp()
    }

    if (this.held.length > MAX_HELD) return this.giveUp()
    return ''
  }

  /** Not a call after all: print what was held and go back to reading text. */
  private giveUp(): string {
    const out = this.held
    this.held = ''
    this.mode = 'open'
    this.lineStart = false
    this.ticks = 0
    return out
  }

  private read(text: string): SalvagedCall | null {
    try {
      return salvage(JSON.parse(text), this.shapes)
    } catch {
      return null
    }
  }
}
