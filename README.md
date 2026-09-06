# HisaabhKitaabh

An expense ledger that stays out of your way.

```
Folder             File                Rows
"October trip"  →  "Trip expenses"  →  ₹4,820 · Train tickets · Return, sleeper
```

Folders hold files. A file is a table of rows. That is the whole model, and
you have it now.

---

## What you get

**A ledger that behaves like a ledger.** Three columns to start - amount,
title, a note - and a `+` for whatever else you keep track of: quantity,
category, who paid, a slot for the receipt. Amounts are totals, never
multiplied by anything: "3 coffees, ₹240" is a ₹240 row. The total updates as
you type.

**Search that reaches the rows.** One box. It looks past file names into
captions, payment methods, dates and amounts, and gives you one list ranked by
what actually matched. Type `insurance` and the row called Insurance competes
fairly with the folder called Insurance stuff.

**An assistant that asks first.** It reads your files freely and answers
questions about them. When it wants to change something you get a card showing
exactly what changes, in how many rows, before and after. Allow it, deny it, or
tell it what to do differently. There is no path from the assistant to your
data that skips that card.

**Charts from your own numbers.** Flip on graph mode and answers come back
drawn: sixteen kinds, switchable after the fact, downloadable as a picture. Ask
it to compare travel between two trips and it works out which rows count as
travel, adds them up from the ledger, and tells you underneath which files it
read and what it counted.

**Receipts, and what they turn into.** Drop a photo or a PDF on a file and the
assistant proposes rows from it, for your approval. Drop one on an attachment
cell and it just attaches.

**Everything out, whenever you want.** One file as a PDF, a CSV, a copy for the
clipboard or an email draft you edit before sending. Or the whole account, as a
zip that keeps your folders and files exactly as you arranged them, with each
file as a spreadsheet or a CSV.

**Yours to look at how you like.** Light, dark, or follow the system, with a
brightness dimmer for light mode. Dates written the way you write them. A
calculator you can drag anywhere. And a phone layout that is its own design
rather than a squeezed desktop.

**Yours to leave.** Empty the account and keep it, or delete it outright. Keep
your files here or in your own Google Drive, and switch either way without
losing anything.

---

## Try it

```bash
npm install
cp .env.example .env.local
npm run dev                    # http://localhost:3000
```

Sign in with the developer account from `.env.local` and you land in a
working account with a worked sample already in it.

Nothing is strictly required to start. Without a database it keeps everything
in memory, which is fine for a look around and gone on restart. Without an
Ollama key the assistant is switched off and the rest works. Without an email
key the "forgot password" code goes to the server log instead of a mailbox.
`/api/health` will tell you which of those you are missing.

---

## A little of what is underneath

Not a tour. Just the four things that decide whether it can be trusted.

**Nothing sends a whole document.** Every change travels as one operation with
its own version stamp, so two people editing different cells of the same row
both succeed, and two edits to the same cell resolve the same way on every
device. When a real conflict happens you are asked which version wins. It is
never decided quietly.

**Charts are drawn, not generated.** An image model asked for two bars will
cheerfully return five, with labels in no language and heights in no
proportion to anything, because it has no arithmetic - only a sense of what
charts look like. So the geometry is computed here, from your rows, which also
means the numbers never leave the machine to become a picture.

**The assistant cannot write.** Its read tools run immediately; its write tools
do not run at all. They return a plan, and the plan becomes the approval card.
That is the whole safety model, and it is a property of the code rather than a
promise about behaviour.

**Text in your data is data.** A row title, a file name, the text inside a
receipt: anyone who can get a row into a ledger can get words in front of the
model. Instructions come from the person in the chat box and nowhere else, so
`<admin>` in the middle of a caption is a word somebody typed.

Around 750 assertions across eight suites cover this, from the merge rules in
process to a real browser clicking through the real thing.

```bash
npx next dev -p 3111 &
npm test
```

---

[How it is built](ARCHITECTURE.md) goes properly into the above and a good deal
more. [DEPLOYMENT.md](DEPLOYMENT.md) covers hosting, scaling and what it costs
to run, which on the free tiers it is built for is nothing.
