# Tests

Four suites, from fastest and most isolated to slowest and most realistic.
The later ones exist because each caught a class of bug the earlier ones
structurally could not.

| Suite | Needs | What it covers |
|---|---|---|
| `test:engine` | nothing | The document engine, in-process. Ordering, merge, idempotency, the revision gate, undo inversion, totals, and how a file renders into a mail draft or the clipboard. |
| `test:e2e` | a running server | The HTTP surface with a real session. Auth, seeding, parallel writers, conflicts, attachment refusal, analytics. |
| `test:chat` | server + `OLLAMA_API_KEY` | The assistant against the live model and the live write path. ~40s. |
| `test:ui` | server + Chromium | A real browser. Editing, saving, undo/redo, the approval card, popover dismissal, drag-to-reorder, file drops, the theme switch, the phone layout. |

```bash
npx next dev -p 3111 &     # the last three need this
BASE=http://localhost:3111 npm test
```

## Why each layer exists

The engine suite is pure and fast, so it can afford to be exhaustive. It caught
the ordering scheme degenerating at row 283.

The E2E suite constructs its own HTTP requests. That is its strength - it can
fire twenty parallel writers - and its blind spot: it never runs the client, so
it happily passed while the browser was sending an unusable `baseRev` on every
save.

The UI suite runs the actual client. It caught that bug, plus a closed `<dialog>`
silently swallowing every click on the page, plus Enter appending a phantom row
that made undo reverse the wrong thing.

It is also the only place the *chrome* can be checked: which element owns a
scroll, whether opening one menu closes another, whether a pointer drag actually
reorders anything, whether the theme choice reaches the document. None of that
has an HTTP surface to assert against.

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
- Screenshots land in `/tmp/hisaabkitaab-shots` (override with `SHOTS`).
