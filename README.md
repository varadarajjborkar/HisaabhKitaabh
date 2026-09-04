# Khata

An expense ledger built around folders, files and rows — with an assistant that
can edit your data, but never without asking first.

```
Folder  →  File  →  Rows
"October trip"  →  "Trip expenses"  →  ₹4,820 · Train tickets · Return, sleeper class
```

---

## What it does

- **Folders and files.** A folder groups files; a file is a table of rows. Every
  new account gets a worked sample so the model is obvious without a tour.
- **Three columns to start** — INR, Title, Extra Captions — and a `+` to add your
  own: quantity, category, payment method, a receipt slot. Attachments accept
  images, PDFs, CSVs, spreadsheets and documents. Video is refused.
- **Amounts are totals.** A quantity column is a note, not a multiplier.
  "3 coffees, ₹240" is a ₹240 row. Nothing is computed across columns.
- **A live total and gauge** that update as you type, an optional period
  (dates or months), undo/redo, and a refresh that re-reads from the server.
- **Save, discard, PDF, CSV, copy, mail** — all client-side and instant.
- **An assistant** in the folder view and beside the sheet. It reads freely;
  every write becomes an approval card you Allow, Deny, or redirect.
- **Analytics** on the home screen, off until you turn it on, scoped to the
  folders and files you choose.
- **Works on a phone.** The mobile layout is its own design, not a squeezed
  desktop — rows become cards, the assistant becomes a sheet.

## Running it

```bash
npm install
cp .env.example .env.local     # then add OLLAMA_API_KEY
npm run dev                    # http://localhost:3000
```

Sign in with the developer account from `.env.local` (`varad` / `varad[123]` by
default) — no OAuth round-trip, and it lands you in an admin session.

Nothing but `SESSION_SECRET` is strictly required. Without Redis the app uses a
per-process store (fine for a first look, gone on restart). Without Google
credentials, data lives in Redis instead of Drive. Without an Ollama key the
assistant is switched off and everything else works.

## Tests

```bash
npx next dev -p 3111 &         # everything but the engine suite needs this
npm test                       # all four suites
npm run test:engine            # or one at a time
```

111 tests in four layers:

| Suite | Tests | What it exercises |
|---|---|---|
| `test:engine` | 40 | The document engine in-process — ordering, merge, idempotency, the revision gate, undo, totals |
| `test:e2e` | 30 | The HTTP surface with a real session — parallel writers, conflicts, attachment refusal |
| `test:chat` | 16 | The assistant against the live model and the live write path |
| `test:ui` | 25 | A real browser — editing, saving, undo/redo, the approval card, the phone layout |

Each layer exists because it caught something the one below it structurally
could not. See [tests/README.md](tests/README.md).

---

## How the data is kept correct

This is the part worth reading, because it is where the design earns its keep.

### Nothing sends a whole document

Every change travels as an **operation** — `cell.set`, `row.insert`,
`column.delete` — and every field carries its own version stamp of
`(lamport clock, actor id)`. Two people editing different cells of the same row
both succeed. Two writes to the *same* cell resolve deterministically, and every
replica agrees on the winner.

### The write path is one path

The UI, the assistant, imports and undo all go through the same funnel:

```
acquire lock → read fresh → revision check → apply → persist → verify → log
```

One code path means one set of guarantees. The lock serialises writers; the
revision check is what actually refuses a stale write, so correctness survives
Redis being unavailable.

### Retries collapse instead of duplicating

Row ids are minted by whoever originates the row — your browser, or the agent —
so a retried "add row" carries the same id and folds into the existing row.
Operation ids are remembered for a window, and mutation requests carry an
idempotency key. A double-tap, a flaky network, an agent retry: all no-ops.

### Conflicts surface; they never resolve themselves silently

A batch built against an older revision is allowed through **only** if it
touches no field that has changed since. Otherwise you get a 409 carrying the
current document, and the UI asks which version wins. Your unsaved edits stay
queued either way.

### The assistant cannot write

Read tools execute immediately. Write tools **never execute** — they return an
operation plan, and the runtime turns it into an approval card showing what
changes, across how many rows, with before/after values. There is no path from
the model to a document that skips that gate.

The plan records the revision it was built against. If you edit the file while
the card is on screen, approving produces a conflict, not an overwrite — the
agent re-reads and re-plans. That case is covered by a test.

### Row order

Rows carry a fractional index string, so inserting between two rows is one key
write and never renumbers siblings. Appends increment an integer part, so a
thousand appends produce three-character keys. (The first implementation here
was a naive midpoint that degenerated to 69-character keys and broke ordering
outright at row 283 — caught by a test, replaced with the standard scheme.)

---

## The assistant

### Skills are YAML

`src/skills/*.yaml`. Not Markdown, because a skill has structure the runtime
acts on — which tools it may call, which model tier it wants, how many tool
calls it gets — and parsing that out of prose headings is guesswork. The router
matches on typed fields with no model call; the model only ever sees the
`instructions` block.

```yaml
name: expense-entry
model: chat
tools: [get_file, add_rows, add_column, list_columns]
budget: { max_tool_calls: 6 }
instructions: |
  ...
```

Add a file, restart, and it is live.

### Memory is four tiers

| Tier | What | Where |
|---|---|---|
| L0 | The open document | Derived per request — a stale ledger is worse than none |
| L1 | Recent turns, verbatim | Redis list, capped |
| L2 | Rolling thread summary | Written on compaction, *after* the reply is streamed |
| L3 | Durable preferences and corrections | Redis hash, keyword-scored on recall |

Recall is keyword + recency rather than vector search: for a few hundred facts
it is more accurate, costs one Redis read, and never returns a confidently wrong
neighbour.

### Agents

A generalist main loop with the full tool set, plus two specialists behind
tools, each because it needs something the generalist cannot have in the same
call:

- **Document reader** — a vision-capable model, for receipts and screenshots.
  Returns rows with per-row confidence and checks its own sum against the
  printed total.
- **Analyst** — read-only, with the arithmetic done in code. The model gets
  pre-computed aggregates and writes the prose; it never adds numbers up itself.

There is deliberately no generic "spawn an agent" tool. Every specialist has a
defined input, a defined output, and a bounded cost.

### What the model actually does on this endpoint

Verified against Ollama Cloud, not assumed:

- **`format` is ignored** — both a JSON Schema and plain `"json"`. Models answer
  with fenced JSON under field names of their own invention. Structured
  extraction therefore goes through a **tool call**, whose arguments do respect
  the top-level schema.
- **Nested keys still drift** (`description` where the schema said `title`), so
  every extracted row is coerced through a tolerant mapper. An unreadable amount
  becomes `null` at low confidence — never a silent zero in your total.
- **`gpt-oss` streams a separate `thinking` channel.** A token budget sized only
  for the answer returns an empty string. Thinking is shown as a status, never
  as the reply.

Model defaults are pinned to what a free Ollama Cloud key can reach:
`gpt-oss:120b` (chat), `gpt-oss:20b` (fast), `gemma4:31b` (vision + extraction —
the only image-capable model available, and the most faithful to nested
schemas).

---

## Storage

Two backends behind one repository interface:

- **Google Drive** for Google sign-ins. Files live in a `Khata/` folder you own;
  the app requests `drive.file`, so it can only ever see files it created
  itself. Zero storage cost, and the data is yours outright.
- **Redis** for password accounts, and as the cache tier for Drive accounts.

Drive has no compare-and-swap, so every object is identified by an
`appProperties` key rather than its name or path, created under a per-key lock,
and verified by reading back the revision after each write. If duplicates ever
appear — a hand edit, an interrupted write — the highest-revision copy wins and
the rest are moved to Drive's trash, never hard-deleted. `POST /api/maintenance/drive`
runs that sweep on demand.

## Layout

```
src/
  app/            routes and API handlers
  components/     UI — sheet/, chat/, charts/, ui/
  lib/
    crdt/         operations, merge, revision gate
    store/        repository, locks, idempotency, seeding
    drive/        Drive REST client and document store
    ai/           Ollama client, tools, agent loop, memory, skills
    client/       hooks — useSheet, useChat, exports
  skills/         *.yaml
tests/            engine, e2e, chat
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting, scaling and cost.
