/**
 * Notes written into a conversation for the model, and kept out of the user's.
 *
 * Some things the model has to know cannot be said in a system prompt because
 * they happen *at a point in the conversation*: a chart was drawn here, the
 * user moved to another file here. Those are stored as messages so they keep
 * their place in the order.
 *
 * Which means there is exactly one way for them to go wrong, and it is worth
 * naming: they are messages, so anything that renders messages can render
 * them. A marker on the screen is machinery showing through - the user sees
 * "[the user is now in ...]" written as if the assistant said it.
 *
 * So the test lives here, once, and everything that displays or titles a
 * conversation asks it. Guarding at each call site instead would mean
 * remembering to guard the next one.
 */

const PREFIXES = ['[chart drawn]', '[the user is now in ']

export function isMarker(content: string): boolean {
  const text = content.trimStart()
  return PREFIXES.some((p) => text.startsWith(p))
}

/**
 * The same text with a marker the model echoed taken off the front.
 *
 * Models do sometimes repeat a bracketed note back, having read it as a line
 * to continue rather than as context. Stripping it is cheap; explaining a
 * stray "[chart drawn]" to a user is not.
 */
export function stripMarkers(text: string): string {
  let out = text
  for (;;) {
    const trimmed = out.trimStart()
    if (!isMarker(trimmed)) break
    const end = trimmed.indexOf('\n')
    if (end === -1) return ''
    out = trimmed.slice(end + 1)
  }
  return out
}
