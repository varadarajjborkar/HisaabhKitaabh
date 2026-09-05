import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/**
 * Skills are YAML, not Markdown.
 *
 * The reason is mechanical: a skill has structure the runtime needs to act on -
 * which tools it may call, which model tier it wants, how many tool calls it
 * gets - and parsing that out of prose headings is guesswork. YAML gives the
 * router typed fields to match on and hands the model only the `instructions`
 * block, so selection is cheap and deterministic while the guidance stays
 * free-form.
 */

export type Skill = {
  name: string
  title: string
  description: string
  when: string[]
  model: 'chat' | 'fast' | 'vision'
  tools: string[]
  budget: { max_tool_calls: number }
  instructions: string
  quality_bar?: string
  examples?: Array<{ user: string; do: string }>
}

let cache: Skill[] | null = null

export function loadSkills(): Skill[] {
  if (cache) return cache
  const dir = join(process.cwd(), 'src', 'skills')
  const skills: Skill[] = []
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue
      try {
        const raw = parse(readFileSync(join(dir, entry), 'utf8')) as Partial<Skill>
        if (!raw?.name || !raw.instructions) continue
        skills.push({
          name: raw.name,
          title: raw.title ?? raw.name,
          description: (raw.description ?? '').trim(),
          when: raw.when ?? [],
          model: raw.model ?? 'chat',
          tools: raw.tools ?? [],
          budget: { max_tool_calls: raw.budget?.max_tool_calls ?? 8 },
          instructions: raw.instructions.trim(),
          quality_bar: raw.quality_bar?.trim(),
          examples: raw.examples,
        })
      } catch (err) {
        console.warn(`[hisaabkitaab] skill ${entry} failed to parse:`, err)
      }
    }
  } catch (err) {
    console.warn('[hisaabkitaab] no skills directory found:', err)
  }
  cache = skills.sort((a, b) => a.name.localeCompare(b.name))
  return cache
}

export function getSkill(name: string): Skill | undefined {
  return loadSkills().find((s) => s.name === name)
}

/**
 * Route a request to skills without a model call.
 *
 * Scoring is keyword overlap against `when` and `description`, which is fast,
 * free, and predictable. The model still gets the shortlist and decides; this
 * only keeps us from stuffing every skill's instructions into every prompt.
 */
export function selectSkills(userMessage: string, context: { hasAttachment?: boolean; inFile?: boolean } = {}): Skill[] {
  const text = userMessage.toLowerCase()
  const words = new Set(text.split(/[^a-z0-9₹]+/).filter((w) => w.length > 2))

  const scored = loadSkills().map((skill) => {
    let score = 0
    for (const clause of skill.when) {
      const clauseWords = clause.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
      const hits = clauseWords.filter((w) => words.has(w) || text.includes(w)).length
      if (hits > 0) score += hits / Math.max(3, clauseWords.length) + 0.5
    }
    for (const w of skill.description.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length > 3 && words.has(w)) score += 0.15
    }
    if (context.hasAttachment && skill.name === 'receipt-extract') score += 3
    if (!context.inFile && skill.name === 'organize-files') score += 0.5
    if (/\d/.test(text) && skill.name === 'expense-entry') score += 0.6
    return { skill, score }
  })

  const top = scored.filter((s) => s.score > 0.45).sort((a, b) => b.score - a.score).slice(0, 3)
  // Always give the model something to work from, even on an unusual phrasing.
  if (top.length === 0) {
    const fallback = loadSkills().find((s) => s.name === (context.inFile ? 'expense-entry' : 'organize-files'))
    return fallback ? [fallback] : []
  }
  return top.map((t) => t.skill)
}

/** The prompt fragment for the selected skills. */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return ''
  return skills
    .map((s) => {
      const parts = [`## Skill: ${s.title} (${s.name})`, s.description, '', s.instructions]
      if (s.quality_bar) parts.push('', `Quality bar: ${s.quality_bar}`)
      if (s.examples?.length) {
        parts.push('', 'Examples:')
        for (const ex of s.examples) parts.push(`  user: ${ex.user}\n  -> ${ex.do}`)
      }
      return parts.join('\n')
    })
    .join('\n\n---\n\n')
}

/** Union of tools the selected skills are allowed to use, plus the always-on set. */
export function allowedTools(skills: Skill[], always: string[]): string[] {
  const set = new Set(always)
  for (const s of skills) for (const t of s.tools) set.add(t)
  return [...set]
}

export function toolBudget(skills: Skill[]): number {
  if (skills.length === 0) return 8
  return Math.min(16, Math.max(...skills.map((s) => s.budget.max_tool_calls)))
}
