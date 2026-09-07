# Deploying HisaabhKitaabh

Written for someone who has not done this before. Follow it top to bottom and
you will have a working production deployment in about half an hour, most of it
waiting for other people's dashboards.

---

## 1. The short version

| Piece | Use | Free tier | When you outgrow it |
|---|---|---|---|
| Hosting + compute | **Vercel** | Hobby: plenty | Pro, $20/mo |
| Account data | **Postgres** (Neon or Supabase) | 0.5 GB | Their paid tier, from ~$19/mo |
| The model | **Ollama Cloud** | Limited free | Their paid tier, or self-host |
| Cache and locks | Upstash Redis | 10k commands/day | Optional. Skip it at first. |
| Per-user file storage | The user's own Google Drive | Free - it's their quota | Optional, and per-user |

Two things are required: `SESSION_SECRET` and `DATABASE_URL`. Everything else is
a feature you can add later without touching the code.

Total to run this for a few hundred people: **£0**.

### Where a user's files actually live

Every account gets storage in your Postgres database the moment it is created.
Nobody needs a Google account, and nothing about signing up asks for one.

Google Drive is a *choice* the user makes in **Account → Storage**, for people
who would rather own their own files. When they pick it, the app asks Google for
the `drive.file` scope at that moment, copies everything across, and leaves the
original where it was. Switching back does the same in reverse.

That means your storage bill is driven by how many people *keep* their files with
you, and anyone who moves to Drive costs you nothing at all.

---

## 2. Deploy to Vercel

```bash
npm i -g vercel
vercel          # first run: links the project
vercel --prod
```

Or push to GitHub and import at [vercel.com/new](https://vercel.com/new) - every
push to `main` then deploys itself, and every pull request gets its own preview
URL. That *is* your CI/CD; you do not need to configure anything else.

Next.js on Vercel needs no build settings. It detects the framework, builds, and
routes each API handler to its own serverless function.

### Environment variables

Add these under **Project → Settings → Environment Variables**.

| Variable | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | **yes** | `openssl rand -base64 32`. Different per environment. The app refuses to serve in production without it. |
| `DATABASE_URL` | **yes** | The pooled Postgres connection string. See below. |
| `OLLAMA_API_KEY` | for the assistant | From [ollama.com/settings/keys](https://ollama.com/settings/keys) |
| `APP_URL` | for Google sign-in | `https://your-app.vercel.app`. Must match the OAuth redirect exactly. Left unset, the deployment URL is used. |
| `RESEND_API_KEY` | for "Forgot password" | From [resend.com](https://resend.com), 3,000 a month free. Or `BREVO_API_KEY`, 300 a day. Without one, the reset flow says it cannot send rather than pretending it did. |
| `MAIL_FROM` | with the above | An address the provider will send as. Resend's `onboarding@resend.dev` needs no domain but only delivers to the account owner, so verify a domain for real users. |
| `GOOGLE_CLIENT_ID` | for Drive | Optional feature |
| `GOOGLE_CLIENT_SECRET` | for Drive | |
| `UPSTASH_REDIS_REST_URL` | no | A speed-up, not a store |
| `UPSTASH_REDIS_REST_TOKEN` | no | |
| `DEV_LOGIN_ENABLED` | no | Off in production by default. See below. |
| `FEEDBACK_TO` | for the feedback door | Your own address. Users writing in - including "I have run out of space" - land there, with their registered address as the reply-to. Unset, the door is not shown at all. |
| `MAX_STORAGE_BYTES_PER_USER` | no | Default 10 MB per account, out of the pool below - not the size of the pool |

> **The developer login.** `varad` / `varad[123]` grants an admin session, and
> the password is published in `.env.example`. In production it is **off** and
> stays off unless you set `DEV_LOGIN_ENABLED=true` *and* change `DEV_PASSWORD`
> to something of your own. Both conditions, deliberately: a single forgotten
> flag should not be the only thing between a public URL and an admin account.

### Analytics

`@vercel/analytics` and `@vercel/speed-insights` are wired into the root layout.
Turn them on in **Project → Analytics** and **Speed Insights**; no keys and no
code changes. Both are inert anywhere but Vercel, so local development and any
other host load nothing.

---

## 3. Postgres

This is where accounts, folders, files, chat history and receipt bytes live.

Any Postgres works. Recommended, in order:

| Provider | Free tier | Notes |
|---|---|---|
| **[Neon](https://neon.tech)** | 0.5 GB, scales to zero | Best fit. Also what Vercel's own Postgres integration is underneath. |
| [Supabase](https://supabase.com) | 0.5 GB | If you also want their auth, storage and realtime later |
| [Railway](https://railway.app) | Trial credit | Simplest dashboard, no free tier past the credit |

### Setting it up

1. Create a project. Pick **the same region as your Vercel functions** - a
   database in Virginia and functions in Mumbai pays 200ms of round trip several
   times per request, and that dominates every other optimisation on this page.
2. Copy the **pooled** connection string, not the direct one. On Neon it is the
   one with `-pooler` in the host; on Supabase it is the "Transaction pooler" on
   port `6543`. Serverless opens a connection per instance and a traffic spike
   will exhaust a direct connection limit.
3. Paste it into Vercel as `DATABASE_URL`.
4. Deploy. The tables are created on first boot - there is no migration command
   to run and no schema file to apply.

If you use Vercel's own Postgres integration it injects `POSTGRES_URL`, which is
read as a fallback, so that path needs no configuration at all.

### What is in there

Two tables.

`hk_kv` is a key/value store with expiry, holding everything structured:
accounts, folders, documents, the operation log, chat threads and memory. Every
row carries the account that owns it, so usage per account is one query and
deleting an account provably leaves nothing behind.

`hk_attachments` holds receipt bytes as `bytea`. Not base64 inside JSON, which
would cost a third more space and a parse of the whole blob on every read.

| Kind | TTL | Notes |
|---|---|---|
| Accounts, folders, documents | ∞ | The actual data |
| Attachments | ∞ | Capped per account by `MAX_STORAGE_BYTES_PER_USER` |
| Operation log | 7d | Powers merge-instead-of-conflict |
| Chat and memory | 60d | Threads, summaries, durable facts |
| Document cache | 120s | Rebuilt on miss |
| Locks | 10-25s | Self-expiring; a crashed writer never wedges a file |
| Idempotency keys | 24h | What makes a retried save a no-op |

0.5 GB is a lot of expense rows and not a lot of receipt photos, and the two
numbers here are easy to confuse. `MAX_STORAGE_BYTES_PER_USER` is a **share** of
that half-gigabyte, not a copy of it: it used to default to the whole 512 MB,
which read as a generous allowance and was in fact a licence for the first
account to take the entire database.

Of the 512 MB, budget about **400 MB** as usable - indexes, row overhead and
write-ahead logs take the rest, and a JPEG in a `bytea` column does not
compress. At the 10 MB default that is roughly forty accounts.

Ten megabytes is about forty receipts, because the browser shrinks a photo to
1600px on the long edge and re-encodes it before uploading - a tenfold
reduction on a phone photograph, and the reason the cap can be this small
without being mean. Raise it the day the database is bigger; it is one
variable and nothing migrates.

Nobody is cut off silently. At three quarters, then nine tenths, then full, a
notice appears under the bell in the top bar carrying the three ways out: take
a copy, clear the account, or write to whoever runs the deployment and ask for
more. Accounts kept in Drive are never warned about a quota this app does not
control.

---

## 4. Upstash Redis (optional)

Skip this on your first deploy. Add it when page loads feel slow.

With Redis configured, the disposable keys - document cache, write locks,
rate-limit counters, idempotency records - move there, and account data stays in
Postgres. Losing all of Redis costs you a few slow page loads and nothing else.

1. [console.upstash.com](https://console.upstash.com) → **Create Database**
2. Same region as your Vercel functions.
3. Enable **Eviction** (`allkeys-lru`). Everything stored there is disposable by
   construction, so evicting is always safe, and without it a full database
   starts refusing writes.
4. Copy the **REST** URL and token, not the `redis://` one - the REST API is
   what works from serverless with no connection pool.

Vercel's own **KV** is Upstash underneath; `KV_REST_API_URL` /
`KV_REST_API_TOKEN` are read as fallbacks, so the marketplace integration works
with no code change.

> **If you already ran without a database and then add one**, the accounts
> created in the meantime stay where they were - Redis, or a serverless
> instance's memory. Adding `DATABASE_URL` does not move them, and they will
> look as though they vanished. Attach the database before anyone real signs up.
>
> If you configure Redis **without** `DATABASE_URL`, Redis becomes the durable
> store instead. That works, and it is how this app shipped originally, but
> Redis is priced by memory and one receipt photo is a few hundred kilobytes -
> the 256 MB free tier fills in an afternoon, and it fills by losing data.
> `/api/health` says which mode you are in.

---

## 5. Google OAuth (optional)

Only needed if you want the "sign in with Google" button, or the option for
users to keep their files in their own Drive.

1. [console.cloud.google.com](https://console.cloud.google.com) → new project
2. **APIs & Services → Library** → enable **Google Drive API**
3. **OAuth consent screen** → External → fill in app name and support email
4. Add the scope `.../auth/drive.file` - this is a **non-sensitive** scope, so
   you do *not* need Google's security assessment. Do not ask for full `drive`.
5. **Credentials → Create → OAuth client ID → Web application**
   - Authorised redirect URI: `https://your-app.vercel.app/api/auth/callback`
   - Add `http://localhost:3000/api/auth/callback` for local work
6. Copy the client ID and secret into Vercel

While the consent screen is in "Testing", only accounts you list can sign in.
Publishing it is a form, not a review, for non-sensitive scopes.

**Sign-in does not ask for Drive.** It requests identity only. The `drive.file`
scope is requested separately, the first time someone chooses Drive in
**Account → Storage**, so most people never see that half of the consent screen.

---

## 6. Latency, caching and cost

Things that actually matter, in order:

**1. Put everything in one region.** Vercel functions, Postgres, Redis. This
dominates every other optimisation. Set Vercel's function region to the one
nearest your users (`bom1` for India) under Settings → Functions.

**2. Use the pooled connection string.** A direct Postgres URL will work fine in
testing and fall over the first time you have real concurrency.

**3. The document cache does the heavy lifting.** Reads hit the cache for 120
seconds; writes refresh it in place, so the next reader never sees stale data.

**4. Conditional GETs.** `GET /api/files/[id]` returns an ETag and answers 304
when nothing changed, so polling costs a header exchange rather than a document.

**5. Batch operations.** The client debounces edits into batches. Twenty
keystrokes become one write. Keep it that way - the debounce is in
`useSheet.ts` (`FLUSH_DELAY`).

**6. Watch the assistant, not the app.** A chat turn costs 3-10 seconds and real
tokens; a page load costs milliseconds and nothing. If a bill surprises you, it
is the model. `rateLimit(userId, 'chat', 40, 60)` in `loop.ts` is the throttle,
and each skill's `max_tool_calls` caps a runaway loop.

### Function limits

`maxDuration` is set per route: 300s for chat and storage migrations, 60s for
uploads. Hobby plans cap at 60s - either upgrade or lower those. The design
already survives this: an approval **ends the stream** and resumes on a second
request, so a user thinking for five minutes never holds a function open. A
storage migration that runs out of time is safe to re-run, because it copies
rather than moves and creating something that already exists is a no-op.

---

## 7. Operations

**Health check.** `GET /api/health` returns database, store, AI and Google
status plus a latency number. Point [UptimeRobot](https://uptimerobot.com) or
Better Stack at it on a 5-minute interval - free, and you hear about an outage
before your users do. Signed in as an admin (or outside production) it also
lists what is misconfigured; it does not say that publicly, because an endpoint
that announces "sessions are signed with a default key" is an invitation.

**Logs.** Vercel → Deployments → Logs. Everything the app logs is prefixed
`[hisaabhkitaabh]`. For retention beyond a day, Vercel's Log Drains send to
Better Stack or Axiom.

**Backups.** Neon and Supabase both keep point-in-time restore on the free tier;
check it is on. This is the only copy of a password account's data, so it
matters. Accounts that chose Drive are covered by Google's own version history
and 30-day trash.

**Drive integrity.** `POST /api/maintenance/drive` sweeps a user's Drive for
objects sharing an identity key, keeps the highest-revision copy and trashes the
rest. Safe to run any time; nothing is hard-deleted.

**Rotating a secret.** Changing `SESSION_SECRET` signs everyone out; that is the
correct response to a leak. Changing the Google client secret requires everyone
who uses Drive to reconnect it.

**Deleting an account.** `purgeAccount(userId)` in `src/lib/db/sql.ts` removes
every row and every attachment for one account in two statements. Both tables
carry the owner, so nothing is left orphaned.

---

## 8. Before you make it public

- [ ] `SESSION_SECRET` is 32+ random bytes and not the one in `.env.example`
- [ ] `DATABASE_URL` is set, and is the **pooled** connection string
- [ ] `/api/health` returns `"database": "ok"` and `"healthy": true`
- [ ] Database in the same region as the functions
- [ ] Point-in-time restore enabled on the database
- [ ] `DEV_LOGIN_ENABLED` unset, or credentials changed from the defaults
- [ ] `APP_URL` matches the deployed domain exactly, if using Google
- [ ] Google consent screen published, if you want anyone but yourself
- [ ] Uptime monitor pointed at `/api/health`
- [ ] A real sign-up, folder, file, row and assistant edit, on a phone

---

## 9. Things that will bite you

**"It worked locally and breaks deployed."** Almost always the database. Locally
the in-memory fallback is one process, so everything is consistent. Deployed,
each serverless instance has its own - writes land on one and reads on another.
`/api/health` tells you which mode you are in: `"storage": "Postgres"` is what
you want, `"In-memory (not durable)"` is the problem.

**"Too many connections."** You used the direct connection string instead of the
pooled one. Swap it; nothing else needs to change.

**"Google says redirect_uri_mismatch."** The URI in the console must match
`APP_URL` + `/api/auth/callback` character for character. `https` vs `http`, a
trailing slash, and `www` all count as different.

**"The assistant says it is not configured."** `OLLAMA_API_KEY` is missing in
that environment. Vercel scopes variables per environment - setting it for
Production does not set it for Preview.

**"A model returns 404 or asks for a subscription."** Ollama Cloud gates models
per plan. `gpt-oss:120b`, `gpt-oss:20b` and `gemma4:31b` are reachable on a free
key; most of the larger ones are not. `GET /api/health` reports whether AI is
configured; the model list is at `https://ollama.com/api/tags`.

**Preview deployments share production data.** Vercel gives previews the
Production variables unless you set them separately. Create a second database
for Preview - on Neon that is a branch, and it takes a few seconds - or you will
be testing against real users' data.
