# How HisaabhKitaabh is built

The design notes, kept out of the README so that one can stay a page long.
Written for someone deciding whether to trust the thing with a year of
records, or to work on it.

For running and hosting it, see [DEPLOYMENT.md](DEPLOYMENT.md).

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
the lock store being unavailable.

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

### Graph mode

A switch on the composer, not something inferred from a sentence, and it says
what it is doing while it is on - a mode you cannot see is a mode you forget you
left on.

`make_chart` takes a *question about the data*, never the numbers: which files,
which words select the rows that count as travel, what the bars stand for. The
figures are computed from the rows. Asking a model for the bars themselves gets
bars it half remembers from a tool result three steps ago, and nobody - the
model included - can say afterwards which rows they came from. Every chart
carries a line naming the files it read, the terms that selected the rows and
how many matched, because a chart of travel spend is only worth something if you
can see what it decided travel was.

The mismatch runs both ways. With the switch on, a request to *change* something
is unaffected: the approval card is already where that gets checked, and a
question about charts first would be one too many. A question that wants prose is
the case where the switch was probably left on by mistake, so it asks once, with
the choice in it. With the switch off, "chart it" is an instruction and gets a
chart; only an *implied* chart earns a one-line offer after the written answer.

The mode is a flag on the message, read once while the prompt is built and never
stored - so there is no thread state to keep in sync, and turning it off takes
effect on the very next message rather than whenever the history is next read.

**A chart outlives the turn that drew it.** The tool result is only in front of
the model until that run ends, and the next turn is rebuilt from the stored
thread - so a chart that was never written down simply did not happen. The
conversation *after* a chart is usually about the chart ("which bar was
biggest", "why is that one higher", "add flights to it"), and answering any of
that needs more than the picture: it needs which files were read, which words
selected the rows, and what the bars were grouped by. That line is stored
alongside the figures, and the full spec with it, so reopening a conversation
draws the charts again instead of showing the text that described a picture
with no picture.

### The chart engine

Charts are drawn, not generated. That distinction is the whole design, and it
is worth being blunt about why, because "let an image model make the graph"
sounds reasonable until you try it. Asked for two bars labelled Uncategorised
and UPI with values 18,735 and 450, a free text-to-image model returns five
bars, then nine, with a title in no language, axis labels that are single
broken glyphs, and heights in no proportion to anything. It has no arithmetic -
only a sense of what charts tend to look like. A ledger cannot use a picture
whose numbers are decorative, and every hosted generator has the same problem
plus a second one: the rows would have to leave the machine to reach it.

So the engine is local, and it is four layers, because the limit on what a
chart *can* be was never the drawing code:

    rows                aggregate, in src/lib/ai/chart.ts
      -> ChartSpec      buckets, an optional second breakdown, raw amounts
      -> Plot           scales and marks, pure geometry, no SVG  (charts/plot.ts)
      -> SVG            five shapes and a string                 (charts/svg.ts)
      -> PNG            rasterised in the browser            (client/chartImage.ts)

The middle layer is what earns its keep. A new chart type is a *composition of
marks* rather than a new renderer - a waterfall is rectangles plus connectors,
a pareto is rectangles plus a path - which is why there are sixteen kinds and
not three: bar, column, line, area, donut, pie, grouped, stacked, stacked 100%,
scatter, bubble, histogram, heatmap, treemap, waterfall and pareto. Deliberately
not every chart a plotting library can draw; contour plots and violin plots have
no honest reading over a table of expenses, and offering them would make the
list harder to choose from without making any question easier to answer.

Two things follow from geometry being plain data. The first is that correctness
is testable without rendering: *the bar for 18,400 is 7.67 times the bar for
2,400* is an assertion about an array, and the suite makes it, along with a
sweep confirming no mark lands outside the canvas across every kind, six shapes
of data and five widths - eleven thousand marks. That sweep found two real bugs
that no screenshot would have: a legend key long enough to leave the frame, and
`stacked100` degrading to a single series, where it kept normalising and plotted
a bar for 500 about a hundred thousand pixels above the chart.

The second is that **the picture and the file cannot drift apart**, because the
panel displays the same SVG the download writes. This app has been bitten by the
two-renderers shape of bug before, when the clipboard and the mail draft each
built their own table and disagreed about alignment; there is one grid now, and
one chart.

Text is measured before it is placed, since SVG has no layout engine and a label
too long for its column simply runs across the next one. The width table is
calibrated at 13px, which matters: a first pass measured at 200px and
under-estimated every string by up to 18%, because the system font has optical
sizes and the tight Display cut is not the wide Text cut a chart actually draws.
The estimate is then deliberately generous, fitted so it is never short by more
than a pixel - being a little wide costs an early ellipsis, being narrow
overlaps two labels.

The exported SVG carries no stylesheet, no font file and no external reference
of any kind. That is not tidiness: the browser rasterises it through an `<img>`,
where a CSS variable resolves to nothing and an external reference taints the
canvas. It is also why the font stack quotes `'Segoe UI'` with an apostrophe.
A double quote there closes the XML attribute early, the document stops parsing,
and the failure is completely silent - the image simply never fires `load`.

### A tool call the model wrote as prose

Models that support tool calling still, sometimes, type the call out instead of
making it. The JSON arrives on the text channel and the user reads

    { "question": "What should the comparison chart show?",
      "options": ["Total spend per file", "Spend by category"] }

in the transcript, followed by the model saying the same thing again in words.
Nothing was called, so no question card appeared and none of the options were
clickable. It happens most on the turns that matter - a chart, a question -
because those are the calls with the biggest argument objects.

Filtering the JSON out would fix the appearance and leave the turn broken. The
model named the right tool and filled the arguments in correctly; the only thing
wrong was the channel. So the text stream runs through a gate
(`src/lib/ai/leak.ts`) that holds a line back the moment it could be a call, and
if it turns out to be one, hands it over as a call. It reads every envelope a
model reaches for, including the bare argument object with no name in it,
matched against what each tool accepts; a bare object that fits two tools
equally is printed rather than guessed at.

Two rules keep it from eating an answer. It only starts holding at a brace that
opens a line and never inside a fenced code block, so a reply that discusses
JSON is untouched; and anything held that does not parse, or parses to something
no tool would take, is released as text. A false positive costs a few hundred
milliseconds, not a paragraph.

### Memory is four tiers

| Tier | What | Where |
|---|---|---|
| L0 | The open document | Derived per request - a stale ledger is worse than none |
| L1 | Recent turns, verbatim | A capped list in the account store |
| L2 | Rolling thread summary | Written on compaction, *after* the reply is streamed |
| L3 | Durable preferences and corrections | A hash in the account store, keyword-scored on recall |

Recall is keyword + recency rather than vector search: for a few hundred facts
it is more accurate, costs one read, and never returns a confidently wrong
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

## Search

One box, on the home screen and inside a folder, and it reaches past file names
into the rows: a caption, a payment method, a date, an amount.

**Ranked by what matched, then by where you are.** Results come back as a single
list, not folders followed by files followed by rows. Grouping by kind would
answer "what sorts of thing matched", which is a different question - if you type
`insurance` and there is a row called Insurance and a folder called Insurance
stuff, the closer of the two names should win, and one of them being further up
the tree is not what makes it the better answer. Every term has to land
somewhere, so a two-word query cannot be satisfied by one word.

Where you are standing is a tie-break on the home screen and a filter inside a
folder. In there the folder is part of the question: asked from inside Goa,
"where did that 450 go" is not asking about Bangalore.

**The narrowing happens in the database.** The row search is the expensive half,
so it is the half that is cut down first: one query returns the documents whose
stored JSON mentions every term, and only those are opened and scored. The
alternative is pulling every document across the wire to look at it, and the
documents are the largest thing an account owns. What comes back is a candidate
list rather than an answer - `v::text` sees column ids and stamps too - and the
ranker decides what actually matched.

Numbers needed two fixes. Splitting terms on commas turned `5,500` into `5` and
`500`, which every document in an account satisfies somewhere; and the narrowing
has to look for `5500`, because grouping only exists once a figure has been
formatted for a person to read.

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

Two backends behind one repository interface, and which one you get is a choice
rather than a consequence of the sign-in button you pressed:

Amounts are kept in whatever currency the file is set to, chosen from the
amount column's own header. The grouping follows the currency rather than the
reader - ₹12,34,567 in rupees, $1,234,567 in dollars - and a folder or a chart
that spans two currencies prints its figures without a symbol rather than
claiming a total that has no unit.

- **App storage**, the default. Every account gets its own space in Postgres the
  moment it is created - folders, documents, chat history, and receipt bytes as
  `bytea` rather than base64 inside JSON. Nothing to connect, and no Google
  account anywhere in the path.
- **Google Drive**, opt-in from Account → Storage. Files live in a
  `HisaabhKitaabh/` folder you own; the app requests `drive.file`, so it can only
  ever see files it created itself. Zero storage cost to the host, and the data
  is yours outright.

Signing in with Google asks for identity only. The Drive scope is requested
later, at the moment somebody actually chooses Drive, so most people never see
that consent screen. Switching between the two copies everything across and
leaves the original where it was, so an interrupted migration costs a retry
rather than a year of records.

Redis is optional and holds nothing that matters: caches, write locks,
rate-limit counters. Losing all of it costs a few slow page loads. When it is
absent those keys go to Postgres, and when Postgres is absent too, to a
process-local map that `/api/health` will tell you about.

Drive has no compare-and-swap, so every object is identified by an
`appProperties` key rather than its name or path, created under a per-key lock,
and verified by reading back the revision after each write. If duplicates ever
appear - a hand edit, an interrupted write - the highest-revision copy wins and
the rest are moved to Drive's trash, never hard-deleted. `POST /api/maintenance/drive`
runs that sweep on demand.

## Getting back in without the password

Three steps, because a link in an email is a bearer token for the account and a
code is not: ask for one, prove you received it, choose a new password. Signed
in straight after, since typing a password you chose thirty seconds ago is
ceremony rather than a check.

Six digits is enough given what surrounds it. Ten minutes to live, five wrong
guesses destroys it, five sends an hour per mailbox, and a second limit on
attempts so that asking for a fresh code every five guesses is not an unbounded
search. What is stored is a digest, not the code. Verifying spends the code and
earns a single-use ticket, which is itself spent whether or not the password it
carries is accepted.

The first step answers identically for an address with an account, an address
without one, and an address that has already asked five times this hour, and the
screen says "if that address has an account" for the same reason: a reset form
that says "no account with that email" is an account checker anyone can point at
any address. An account that signs in with Google gets a note saying which
button to press instead, which only its own mailbox ever sees.

Mail goes over HTTPS through Resend or Brevo, whichever key is set, rather than
SMTP - a serverless function cannot hold an SMTP connection open and several
hosts block the port outright. With neither key set the message is printed to
the server log and appended to `.mail-outbox.log`, which is where the test reads
codes from; in production that path throws instead, because a code that silently
goes nowhere is worse than one that never claimed to have been sent.

One thing it does not do: sessions already signed in elsewhere stay signed in
until their cookie expires. Revoking them would mean reading the account on
every request in the app to catch something that happens once.

## Figures that are short and exact at the same time

Analytics has a conflict in it that going one way or the other does not solve.
Four totals side by side are only comparable when they are short, because
"1.2L against 94.3k" is a glance and "1,20,450 against 94,310" is arithmetic.
But a rounded figure is not the figure, and this is the screen people open to
find out what something actually cost.

So the short form is on the page and the exact one is a hover, a focus or a tap
away, to the paisa. It comes up in place, over the short figure, rather than
replacing it: swapping the text would reflow the tile every time the pointer
crossed it. A figure that loses nothing by being shortened is not shortened, and
is not dressed up as something to interact with either.

The charts make the same trade with a tooltip on the axis label, which is where
one lives inside an SVG, and that buys back the gutter a five-deep column of
full amounts was spending. The table under the charts stays in full, which is
what it is for.

## Tests

```bash
npx next dev -p 3111 &         # everything but the first three needs this
npm test                       # all of it
npm run test:engine            # or one at a time
```

| Suite | Assertions | What it exercises |
|---|---|---|
| `test:engine` | 73 | The document engine in process - ordering, merge, idempotency, the revision gate, undo, totals, the text grid every export is laid out on, and how money is written in each currency it can be kept in |
| `test:charts` | 438 | Chart geometry as data - that marks are proportional to their values, that nothing lands outside the canvas across every kind and width, that no input produces NaN or an unparseable document |
| `test:leak` | 77 | The gate over the model's text channel, most of it ordinary prose fed through one character at a time and required to come out identical |
| `test:db` | 30 | The Postgres store against a real database - expiry, atomic claims, concurrent appends, per-account isolation, receipts through `bytea`. Skips itself unless `DATABASE_URL` is set |
| `test:e2e` | 38 | The HTTP surface with a real session - parallel writers, conflicts, attachment refusal, storage backends |
| `test:reset` | 17 | Forgetting a password, mostly what it refuses: naming an account, a code twice, a ticket twice, unlimited guesses, the old password still working |
| `test:storage` | 15 | The share of the database an account gets - where each warning threshold fires, when the dot on the bell lights again, that a phone photo shrinks tenfold before it is sent, and that feedback reaches the owner carrying the sender rather than asking for them |
| `test:chat` | 24 | The assistant against the live model and the live write path, including where its instructions may come from and that a foreign-currency amount is converted rather than asked about |
| `test:ui` | 48 | A real browser - editing, saving, undo/redo, the approval card, popover dismissal, drag to reorder, the theme switch and the stack it drags, the mail dialog, the storage chooser, the currency picker, the phone layout down to its tap targets, and where things actually land on the page |

Each layer exists because it caught something the one below it structurally
could not. See [tests/README.md](tests/README.md).

## Layout

```
src/
  app/            routes and API handlers
    icon.png      the tab and taskbar icon
    manifest.ts   installable metadata
  components/     UI - sheet/, chat/, charts/, ui/
  lib/
    crdt/         operations, merge, revision gate
    db/           Postgres: schema, key/value store, attachment bytes
    store/        repository, key routing, locks, idempotency, seeding, migration
    drive/        Drive REST client and document store
    search/       matching and ranking, no I/O
    ai/           Ollama client, tools, agent loop, memory, skills, aggregation
    charts/       the chart engine - spec, scales, marks, plot, svg
    mail/         one function over two HTTP mail APIs
    client/       hooks - useSheet, useChat, exports, useDismiss,
                  useDragReorder, useFileDrop, useThemeMode, brightness, pdf
  skills/         *.yaml
public/           logo at 96, 192 and 512
tests/            engine, charts, leak, db, e2e, reset, chat, ui
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting, scaling and cost.
