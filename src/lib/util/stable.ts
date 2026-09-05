/**
 * Isomorphic hashing helpers.
 *
 * Kept free of node:crypto on purpose: the document engine imports these, and
 * the same engine runs in the browser for optimistic edits. Password hashing
 * lives in util/hash.ts and stays server-only.
 */

/** Deterministic JSON - key order can't change the result. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

/**
 * FNV-1a, 64-bit, in two 32-bit halves.
 * This is a change-detector for ETags, not a security primitive - collisions
 * only ever cost a redundant refresh, never a wrong write, because the
 * revision number is what actually gates writes.
 */
export function contentHash(value: unknown): string {
  const s = stableStringify(value)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}
