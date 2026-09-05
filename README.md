# HisaabKitaab

An expense ledger built around folders, files and rows - with an assistant that
can edit your data, but never without asking first.

```
Folder  →  File  →  Rows
"October trip"  →  "Trip expenses"  →  ₹4,820 · Train tickets · Return, sleeper class
```

---

## What it does

- **Folders and files.** A folder groups files; a file is a table of rows. Every
  new account gets a worked sample so the model is obvious without a tour.
- **Three columns to start** - INR, Title, Extra Captions - and a `+` to add your
  own: quantity, category, payment method, a receipt slot. Attachments accept
  images, PDFs, CSVs, spreadsheets and documents. Video is refused.
- **Amounts are totals.** A quantity column is a note, not a multiplier.
  "3 coffees, ₹240" is a ₹240 row. Nothing is computed across columns.
- **A live total and gauge** that update as you type, an optional period
  (dates or months), undo/redo, and a refresh that re-reads from the server.
- **Drag to reorder** rows, by pointer rather than the HTML5 drag API, so the
  same grip works with a mouse and with a thumb. Drop a receipt on an
  attachment cell to upload it; drop a statement on a folder and it goes to the
  assistant, which proposes rows for your approval rather than importing
  silently.
- **Save, discard, PDF, CSV, copy, mail** - all client-side and instant. Mail
  opens a dialog: pick the columns, watch the grid redraw, then open the draft.
  Copy puts the same grid on the clipboard at a wider budget.
- **Light, dark, or follow the system**, from the account menu. The choice is
  stamped before first paint, so a dark-theme user never sees a white flash.
- **An assistant** in the folder view and beside the sheet. It reads freely;
  every write becomes an approval card you Allow, Deny, or redirect.
- **Analytics** on the home screen, off until you turn it on, scoped to the
  folders and files you choose.
- **A calculator** you can drag anywhere on screen, with AC and CE as separate
  keys. Desktop only: every phone ships one already.
- **Works on a phone**, and the phone layout is its own design rather than a
  squeezed desktop. Rows are cards with the fields that hold something shown on
  the face of them; columns are managed from a sheet, because the table header
  the "+" used to live in does not exist here; the file actions collapse into
  one menu instead of scrolling off the right edge; and the assistant takes the
  whole screen with a back arrow rather than peering out of the bottom third.

## Running it

```bash
npm install
cp .env.example .env.local     # then add OLLAMA_API_KEY
npm run dev                    # http://localhost:3000
```

Sign in with the developer account from `.env.local` (`varad` / `varad[123]` by
default) - no OAuth round-trip, and it lands you in an admin session.

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

144 tests in four layers:

| Suite | Tests | What it exercises |
|---|---|---|
| `test:engine` | 53 | The document engine in-process - ordering, merge, idempotency, the revision gate, undo, totals, and the text grid every export is laid out on |
| `test:e2e` | 30 | The HTTP surface with a real session - parallel writers, conflicts, attachment refusal |
| `test:chat` | 20 | The assistant against the live model and the live write path, including where its instructions are allowed to come from |
| `test:ui` | 41 | A real browser - editing, saving, undo/redo, the approval card, popover dismissal, drag-to-reorder, the theme switch, the mail dialog, and the phone layout down to its tap targets |

Each layer exists because it caught something the one below it structurally
could not. See [tests/README.md](tests/README.md).

---

## How the data is kept correct

This is the part worth reading, because it is where the design earns its keep.

### Nothing sends a whole document

Every change travels as an **operation** - `cell.set`, `row.insert`,
`column.delete` - and every field carries its own version stamp of
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

Row ids are minted by whoever originates the row - your browser, or the agent -
so a retried "add row" carries the same id and folds into the existing row.
Operation ids are remembered for a window, and mutation requests carry an
idempotency key. A double-tap, a flaky network, an agent retry: all no-ops.

### Conflicts surface; they never resolve themselves silently

A batch built against an older revision is allowed through **only** if it
touches no field that has changed since. Otherwise you get a 409 carrying the
current document, and the UI asks which version wins. Your unsaved edits stay
queued either way.

### The assistant cannot write

Read tools execute immediately. Write tools **never execute** - they return an
operation plan, and the runtime turns it into an approval card showing what
changes, across how many rows, with before/after values. There is no path from
the model to a document that skips that gate.

The plan records the revision it was built against. If you edit the file while
the card is on screen, approving produces a conflict, not an overwrite - the
agent re-reads and re-plans. That case is covered by a test.

### Row order

Rows carry a fractional index string, so inserting between two rows is one key
write and never renumbers siblings. Appends increment an integer part, so a
thousand appends produce three-character keys. (The first implementation here
was a naive midpoint that degenerated to 69-character keys and broke ordering
outright at row 283 - caught by a test, replaced with the standard scheme.)

---

## The assistant

### Skills are YAML

`src/skills/*.yaml`. Not Markdown, because a skill has structure the runtime
acts on - which tools it may call, which model tier it wants, how many tool
calls it gets - and parsing that out of prose headings is guesswork. The router
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
| L0 | The open document | Derived per request - a stale ledger is worse than none |
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

- **Document reader** - a vision-capable model, for receipts and screenshots.
  Returns rows with per-row confidence and checks its own sum against the
  printed total.
- **Analyst** - read-only, with the arithmetic done in code. The model gets
  pre-computed aggregates and writes the prose; it never adds numbers up itself.

There is deliberately no generic "spawn an agent" tool. Every specialist has a
defined input, a defined output, and a bounded cost.

### What the model actually does on this endpoint

Verified against Ollama Cloud, not assumed:

- **`format` is ignored** - both a JSON Schema and plain `"json"`. Models answer
  with fenced JSON under field names of their own invention. Structured
  extraction therefore goes through a **tool call**, whose arguments do respect
  the top-level schema.
- **Nested keys still drift** (`description` where the schema said `title`), so
  every extracted row is coerced through a tolerant mapper. An unreadable amount
  becomes `null` at low confidence - never a silent zero in your total.
- **`gpt-oss` streams a separate `thinking` channel.** A token budget sized only
  for the answer returns an empty string. Thinking is shown as a status, never
  as the reply.

Model defaults are pinned to what a free Ollama Cloud key can reach:
`gpt-oss:120b` (chat), `gpt-oss:20b` (fast), `gemma4:31b` (vision + extraction -
the only image-capable model available, and the most faithful to nested
schemas).

---

## The text grid

Exports are the one place a layout bug is permanent: the mail is sent, the
paste is in someone else's document. So both the mail draft and the clipboard
copy go through one layouter, and "the columns line up" is an invariant it
enforces rather than an effect it hopes for.

Three things break the naive `padEnd` version, and all three are handled:

- **Width is not length.** A CJK ideograph occupies two character cells, a
  combining accent occupies none, and an emoji with a variation selector is one
  glyph made of several code points. Padding by `.length` puts every column
  after it at a different offset on that row alone.
- **Long values have to go somewhere.** Truncating loses data; letting a cell
  run pushes its neighbours sideways for that one row. Values wrap, and the
  continuation lines are padded to sit under their own column.
- **The table has to fit.** Mail folds at around 78 characters, and a client
  folding a table at a point of its choosing destroys the grid far more
  thoroughly than anything else. Columns shrink to fit, widest first, and never
  below what their own longest word needs. Money and counts never wrap at all.

The mail dialog exists for the same reason: fewer columns is the most effective
thing a user can do to keep a table narrow, so it shows the rendered width as
they choose. The engine suite asserts the invariant directly, by walking each
rendered line and checking that the cells between columns hold nothing but
spaces.

---

## Where the assistant's instructions come from

Everything the assistant reads is text somebody could have put there: a row
title, a caption, a file name, an uploaded receipt, a tool result. Anyone who
can get a row into a ledger can get text into the model's context.

The prompt draws the line at provenance rather than at keywords. Instructions
come from the person in the chat box; everything else is content, and cannot
grant permissions or change the rules however it is dressed up. There is no
privileged channel to imitate, and no mode in which writes stop needing
approval, so `<admin>` in the middle of a caption is just a word someone typed.

Two loop-level rules keep a confused turn from becoming a spectacle:

- **Identical read calls are answered from the log.** A model that hits an error
  it cannot interpret will retry the same call, try a neighbour, then retry the
  first. Read tools are pure within a turn, so the honest reply is the answer it
  already got plus a nudge to do something else.
- **Three failures in a row end the tool phase.** The turn goes back to
  producing text and saying what went wrong, instead of filling the transcript
  with warning triangles until the budget runs out.

Errors are written to be recoverable, too. A bad `fileId` used to return "File
not found"; it now names the file that *is* open, says ids cannot be guessed,
and falls back to matching the file by name first, because passing the name
where the id belongs is the single most common thing a model does here.

---

## Three interface rules

Small, but every one of them was a bug first.

**One thing owns each scroll.** The app frame is fixed to the viewport and each
region scrolls itself. The assistant's transcript sticks to the bottom by
setting its own `scrollTop`, not by calling `scrollIntoView`, which scrolls
*every* scrollable ancestor: each streamed token used to drag the ledger and the
toolbar up behind the panel.

**Popovers dismiss from one rule.** Menus used to each carry an invisible
full-screen backdrop. Two open menus meant two stacked backdrops, so the first
click closed nothing visible and opening a second menu left the first alive
underneath. `useDismiss` listens on the document instead, so opening one popover
closes the other as a side effect of the click that opened it, and a click on
the page behind reaches its real target on the first press.

**Layout inherits from where it is mounted.** A `<dialog>` sits in the browser's
top layer but still inherits text properties from its DOM parent. The
"add a column" dialog is rendered inside a `<th>`, whose UA style is
`text-align: center`, and every line of it came out centred. The modal now
resets the inherited text properties so it looks the same wherever it is opened
from.

---

## Storage

Two backends behind one repository interface:

- **Google Drive** for Google sign-ins. Files live in a `HisaabKitaab/` folder you own;
  the app requests `drive.file`, so it can only ever see files it created
  itself. Zero storage cost, and the data is yours outright.
- **Redis** for password accounts, and as the cache tier for Drive accounts.

Drive has no compare-and-swap, so every object is identified by an
`appProperties` key rather than its name or path, created under a per-key lock,
and verified by reading back the revision after each write. If duplicates ever
appear - a hand edit, an interrupted write - the highest-revision copy wins and
the rest are moved to Drive's trash, never hard-deleted. `POST /api/maintenance/drive`
runs that sweep on demand.

## Layout

```
src/
  app/            routes and API handlers
    icon.png      the tab and taskbar icon
    manifest.ts   installable metadata
  components/     UI - sheet/, chat/, charts/, ui/
  lib/
    crdt/         operations, merge, revision gate
    store/        repository, locks, idempotency, seeding
    drive/        Drive REST client and document store
    ai/           Ollama client, tools, agent loop, memory, skills
    client/       hooks - useSheet, useChat, exports, useDismiss,
                  useDragReorder, useFileDrop, useThemeMode
  skills/         *.yaml
public/           logo at 96, 192 and 512
tests/            engine, e2e, chat, ui
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting, scaling and cost.
