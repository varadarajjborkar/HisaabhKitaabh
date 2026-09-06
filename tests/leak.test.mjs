/**
 * The gate over the model's text channel.
 *
 * Two ways to be wrong here, and they are not symmetric. Letting a tool call
 * through as text is ugly: the user reads raw JSON and the thing the model
 * meant to do never happens. Holding back a real answer is worse: the reply
 * silently loses a paragraph and nobody can tell what is missing.
 *
 * So most of what follows is the second kind - ordinary prose, code blocks,
 * money, markdown - fed through the gate one token at a time and required to
 * come out the far side byte for byte identical.
 */

import { TextGate, salvage } from '../src/lib/ai/leak.ts'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL  ${name}${extra ? `  ${extra}` : ''}`)
}
const group = (name) => console.log(`\n${name}`)

const SHAPES = [
  { name: 'ask_user', properties: ['question', 'options'], required: ['question'] },
  { name: 'make_chart', properties: ['title', 'kind', 'files', 'match', 'groupBy', 'column', 'splitBy', 'splitColumn', 'metric'], required: ['title', 'kind', 'groupBy'] },
  { name: 'query_rows', properties: ['fileId', 'match', 'limit'], required: [] },
  { name: 'list_columns', properties: ['fileId'], required: [] },
  { name: 'add_rows', properties: ['fileId', 'rows'], required: ['rows'] },
]

/** Feed text through in awkward pieces: a real stream never splits politely. */
function run(text, chunk = 1) {
  const gate = new TextGate(SHAPES)
  let out = ''
  for (let i = 0; i < text.length; i += chunk) out += gate.push(text.slice(i, i + chunk))
  const kept = gate.end()
  return { text: out + (kept.calls.length === 0 ? kept.text : ''), calls: kept.calls, tail: kept.text }
}

/** Every split size, because the state machine spans deltas. */
function runAll(text) {
  const results = [1, 2, 3, 7, 40, text.length || 1].map((n) => run(text, n))
  const same = results.every((r) => r.text === results[0].text && JSON.stringify(r.calls) === JSON.stringify(results[0].calls))
  return { ...results[0], stable: same }
}

// ------------------------------------------------------------------ prose

group('Ordinary answers pass through untouched')
const PROSE = [
  'You spent 18,735 across 7 rows.',
  'Here is the breakdown:\n\n- Food: 4,200\n- Travel: 9,100\n- Stay: 5,435\n\nTravel is the biggest slice.',
  '## October trip\n\nThe **total** was ₹18,735. That is *higher* than September.',
  'The formula is { total } over { count }, roughly.',
  'Nothing matched "cab" in that file. Try "taxi"?',
  'A row looks like { id, cells, createdAt } internally.',
  '| Category | Total |\n| --- | --- |\n| Food | 4,200 |',
  '',
  '\n\n',
  'Line one\n{ this is not json }\nLine three',
  'I checked week 2 and october trip. Week 2 is 8,900; october trip is 9,835.',
]
for (const text of PROSE) {
  const r = runAll(text)
  ok(`prose survives: ${JSON.stringify(text.slice(0, 34))}`, r.text === text && r.calls.length === 0, JSON.stringify(r.text.slice(0, 60)))
  ok(`prose is split-stable: ${JSON.stringify(text.slice(0, 24))}`, r.stable)
}

group('A fenced code block is content, not machinery')
const FENCED = '```json\n{ "question": "what?", "options": ["a", "b"] }\n```'
{
  const r = runAll(FENCED)
  ok('fenced json is shown, not called', r.text === FENCED && r.calls.length === 0, JSON.stringify(r.text))
}
{
  const text = 'Like this:\n\n```\n{ "title": "x", "kind": "bar", "groupBy": "file" }\n```\n\nThat is the shape.'
  const r = runAll(text)
  ok('fenced example is left alone', r.text === text && r.calls.length === 0)
}

group('Text that opens with a brace but is not a call')
for (const text of ['{ not json at all }', '{}', '{"unknown_key": 1}', '{"fileId": "abc"}', '{"question": "hi", "stray": 2}']) {
  const r = runAll(text)
  ok(`released: ${text}`, r.text === text && r.calls.length === 0, JSON.stringify(r.text) + ' ' + JSON.stringify(r.calls))
}

group('An object that never closes is printed, not swallowed')
{
  const text = '{"question": "what should it show'
  const r = runAll(text)
  ok('unterminated string is released', r.text === text && r.calls.length === 0, JSON.stringify(r.text))
}

// ------------------------------------------------------------------ calls

group('The leak from the screenshot')
const LEAK = `{
  "question": "What should the comparison chart show? For example, total spend per file or spend broken down by a category column.",
  "options": ["Total spend per file", "Spend by category", "Other (specify)"]
}What should the comparison chart show? For example, total spend per file or spend broken down by a category column.`
{
  const r = runAll(LEAK)
  ok('nothing reaches the screen', r.text === '', JSON.stringify(r.text.slice(0, 80)))
  ok('it becomes one ask_user call', r.calls.length === 1 && r.calls[0].function.name === 'ask_user')
  ok('the question survives intact', r.calls[0]?.function.arguments.question.startsWith('What should the comparison chart show?'))
  ok('the three options survive', r.calls[0]?.function.arguments.options.length === 3)
  ok('the restated question is quarantined', r.tail.includes('What should the comparison chart show?'))
  ok('split-stable', r.stable)
}

group('Every envelope a model reaches for')
const CALLS = [
  ['bare arguments', '{"title": "Week 2 vs October", "kind": "bar", "groupBy": "file"}', 'make_chart'],
  ['name + arguments', '{"name": "make_chart", "arguments": {"title": "T", "kind": "bar", "groupBy": "file"}}', 'make_chart'],
  ['name + parameters', '{"name": "ask_user", "parameters": {"question": "which file?"}}', 'ask_user'],
  ['flat name beside args', '{"tool": "ask_user", "question": "which file?", "options": ["a"]}', 'ask_user'],
  ['openai function shape', '{"function": {"name": "ask_user", "arguments": {"question": "q"}}}', 'ask_user'],
  ['tool_name key', '{"tool_name": "list_columns", "arguments": {"fileId": "f1"}}', 'list_columns'],
  ['casing and spaces', '{"name": "Make Chart", "arguments": {"title": "T", "kind": "pie", "groupBy": "category"}}', 'make_chart'],
  ['nested objects', '{"name": "add_rows", "arguments": {"rows": [{"amount": 120, "title": "cab"}]}}', 'add_rows'],
  ['a brace inside a string', '{"name": "ask_user", "arguments": {"question": "what does { mean?"}}', 'ask_user'],
  ['an escaped quote', '{"name": "ask_user", "arguments": {"question": "the \\"big\\" one?"}}', 'ask_user'],
]
for (const [label, text, expected] of CALLS) {
  const r = runAll(text)
  ok(`${label} -> ${expected}`, r.calls.length === 1 && r.calls[0].function.name === expected, JSON.stringify(r.calls))
  ok(`${label} shows nothing`, r.text === '', JSON.stringify(r.text))
  ok(`${label} is split-stable`, r.stable)
}

group('Prose before a call is kept, prose after it is not')
{
  const r = runAll('Let me check that.\n{"name": "list_columns", "arguments": {"fileId": "f1"}}\nOne moment.')
  ok('the lead-in is shown', r.text === 'Let me check that.\n', JSON.stringify(r.text))
  ok('the call is salvaged', r.calls.length === 1)
  ok('the trailing narration is held back', r.tail.includes('One moment.'))
}

group('An ambiguous object is printed rather than guessed at')
{
  // Fits both query_rows and list_columns, and neither requires anything.
  const text = '{"fileId": "f1"}'
  const r = runAll(text)
  ok('a tie resolves to text', r.text === text && r.calls.length === 0, JSON.stringify(r.calls))
}

group('The salvage function on its own')
ok('an array is not a call', salvage([1, 2, 3], SHAPES) === null)
ok('a string is not a call', salvage('make_chart', SHAPES) === null)
ok('null is not a call', salvage(null, SHAPES) === null)
ok('an unknown tool name is not a call', salvage({ name: 'drop_database', arguments: {} }, SHAPES) === null)
ok('an empty object is not a call', salvage({}, SHAPES) === null)
ok('a tool absent from this turn is not a call', salvage({ question: 'q' }, SHAPES.filter((s) => s.name !== 'ask_user')) === null)

group('Nothing held forever')
{
  const long = '{' + 'a'.repeat(9000)
  const r = run(long, 500)
  ok('an unbounded object is eventually released', r.text.length === long.length, `${r.text.length} of ${long.length}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
