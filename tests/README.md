# Tests

Eight suites, from fastest and most isolated to slowest and most realistic.
The later ones exist because each caught a class of bug the earlier ones
structurally could not.

| Suite | Needs | What it covers |
|---|---|---|
| `test:engine` | nothing | The document engine, in-process. Ordering, merge, idempotency, the revision gate, undo inversion, totals, and how a file renders into a mail draft or the clipboard. |
| `test:charts` | nothing | Chart geometry as data. That marks are proportional to their values, that nothing lands outside the canvas across every kind, shape of data and width, that no input produces NaN or an unparseable document. |
| `test:leak` | nothing | The gate over the model's text channel. Mostly ordinary prose fed through one character at a time and required to come out identical, plus every envelope a model reaches for when it types a tool call instead of making it. |
| `test:db` | `DATABASE_URL` | The Postgres store against a real database. Expiry, atomic claims, concurrent appends, per-account isolation and attribution, receipts through `bytea`. Skips itself when unset. |
| `test:e2e` | a running server | The HTTP surface with a real session. Auth, seeding, parallel writers, conflicts, attachment refusal, storage backends, analytics. |
| `test:reset` | a running server | Forgetting a password. Mostly what it refuses: naming an account, spending a code twice, replaying a ticket, guessing without limit, and the old password still working afterwards. Reads codes from `.mail-outbox.log`. |
| `test:chat` | server + `OLLAMA_API_KEY` | The assistant against the live model and the live write path, including that instructions planted in the data are read as data. ~40s. |
| `test:ui` | server + Chromium | A real browser. Editing, saving, undo/redo, the approval card, popover dismissal, drag-to-reorder, file drops, the theme switch, the mail dialog, the storage chooser, and the phone layout down to its tap targets. |

```bash
npx next dev -p 3111 &     # the last four need this
BASE=http://localhost:3111 npm test
```

## Why each layer exists

The engine suite is pure and fast, so it can afford to be exhaustive. It caught
the ordering scheme degenerating at row 283.

The database suite is the only place the storage claims can be checked at all.
Whether an expired lease still blocks a new holder, whether twenty writers
appending to one list lose each other, whether a key belongs to the account the
key name says it does - none of that is visible from above, and all of it is the
difference between a store and a hope.

The E2E suite constructs its own HTTP requests. That is its strength - it can
fire twenty parallel writers - and its blind spot: it never runs the client, so
it happily passed while the browser was sending an unusable `baseRev` on every
save.

The UI suite runs the actual client. It caught that bug, plus a closed `<dialog>`
silently swallowing every click on the page, plus Enter appending a phantom row
that made undo reverse the wrong thing.

It is also the only place the *chrome* can be checked: which element owns a
scroll, whether opening one menu closes another, whether a pointer drag actually
reorders anything, whether the theme choice reaches the document, whether a
control is big enough to hit with a thumb. None of that has an HTTP surface to
assert against. It caught three copies of the same element id, too, which is the
sort of thing that only shows up once a selector resolves to the wrong one.

The chat suite is non-deterministic by nature - a model is in the loop - so it
asserts on behaviour that must hold regardless of phrasing: reads never prompt,
writes always stop at an approval, denial changes nothing, approval changes
exactly what the card described, and a human edit made during review becomes a
conflict rather than an overwrite.

## Notes

- The UI and chat suites create their own folders and files. An early version
  edited whichever sample file came first, and a second run inherited the
  first run's rows until the assertions contradicted each other.
- The UI suite treats any console error or 4xx/5xx API call as a failure. That
  is how the duplicate-React-key bug surfaced.
- Screenshots land in `/tmp/hisaabhkitaabh-shots` (override with `SHOTS`).
