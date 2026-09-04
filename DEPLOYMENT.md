# Deploying Khata

Written for someone who has not done this before. Follow it top to bottom and
you will have a working production deployment in about half an hour, most of it
waiting for other people's dashboards.

---

## 1. The short version

| Piece | Use | Free tier | When you outgrow it |
|---|---|---|---|
| Hosting + compute | **Vercel** | Hobby: plenty | Pro, $20/mo |
| Cache, sessions, chat | **Upstash Redis** | 10k commands/day, 256MB | Pay-per-request, ~$0.20/100k |
| Primary data | **The user's Google Drive** | Free — it's their quota | Never; it doesn't scale to you |
| Data for password accounts | Upstash Redis | Same as above | Move to **Neon** Postgres |
| The model | **Ollama Cloud** | Limited free | Their paid tier, or self-host |

Total to run this for a few hundred users: **£0**. That is the point of the
Drive-first design — the storage bill scales with *each user's* free 15 GB, not
with your bank account.

---

## 2. Deploy to Vercel

```bash
npm i -g vercel
vercel          # first run: links the project
vercel --prod
```

Or push to GitHub and import at [vercel.com/new](https://vercel.com/new) — every
push to `main` then deploys itself, and every pull request gets its own preview
URL. That *is* your CI/CD; you do not need to configure anything else.

Next.js on Vercel needs no build settings. It detects the framework, builds, and
routes each API handler to its own serverless function.

### Environment variables

Add these under **Project → Settings → Environment Variables**. Set them for
Production, Preview and Development unless noted.

| Variable | Required | Notes |
|---|---|---|
| `SESSION_SECRET` | **yes** | `openssl rand -base64 32`. Different per environment. |
| `APP_URL` | **yes** | `https://your-app.vercel.app`. Must match the OAuth redirect exactly. |
| `OLLAMA_API_KEY` | for the assistant | From [ollama.com/settings/keys](https://ollama.com/settings/keys) |
| `UPSTASH_REDIS_REST_URL` | strongly | Without it, state is per-instance and vanishes |
| `UPSTASH_REDIS_REST_TOKEN` | strongly | |
| `GOOGLE_CLIENT_ID` | for Drive | |
| `GOOGLE_CLIENT_SECRET` | for Drive | |
| `DEV_LOGIN_ENABLED` | — | **Set to `false` in production** unless you want the dev account reachable |

> **The developer login.** `varad` / `varad[123]` is a real credential that
> grants an admin session. On a public deployment either set
> `DEV_LOGIN_ENABLED=false`, or change `DEV_USERNAME`/`DEV_PASSWORD` to
> something only you know. The defaults are for your laptop.

---

## 3. Upstash Redis

1. [console.upstash.com](https://console.upstash.com) → **Create Database**
2. Region: **the same one as your Vercel functions.** This matters more than
   anything else on this page — a database in Virginia and functions in Mumbai
   means every Redis call pays 200ms of round trip, several times per request.
3. Enable **Eviction** (`allkeys-lru`). Caches and locks should be evictable;
   without it a full database starts refusing writes.
4. Copy the **REST** URL and token (not the `redis://` one — the REST API is
   what works from serverless with no connection pool).

Vercel's own **KV** is Upstash underneath; `KV_REST_API_URL` / `KV_REST_API_TOKEN`
are read as fallbacks, so the marketplace integration works with no code change.

### What lives in Redis

| Kind | TTL | Notes |
|---|---|---|
| Document cache | 120s | Rebuilt from Drive on miss |
| Locks | 10–25s | Self-expiring; a crashed writer never wedges a file |
| Idempotency keys | 24h | What makes a retried save a no-op |
| Operation log | 7d | Powers merge-instead-of-conflict |
| Chat + memory | 60d | Threads, summaries, durable facts |
| User records | ∞ | And the sheets themselves, for password accounts |

At 10k commands/day the free tier covers roughly 30–60 active users. The paid
tier is per-request and stays inside a few pounds a month well past that.

---

## 4. Google OAuth (optional but recommended)

1. [console.cloud.google.com](https://console.cloud.google.com) → new project
2. **APIs & Services → Library** → enable **Google Drive API**
3. **OAuth consent screen** → External → fill in app name and support email
4. Add the scope `.../auth/drive.file` — this is a **non-sensitive** scope, so
   you do *not* need Google's security assessment. Do not ask for full `drive`.
5. **Credentials → Create → OAuth client ID → Web application**
   - Authorised redirect URI: `https://your-app.vercel.app/api/auth/callback`
   - Add `http://localhost:3000/api/auth/callback` for local work
6. Copy the client ID and secret into Vercel

While the consent screen is in "Testing", only accounts you list can sign in.
Publishing it is a form, not a review, for non-sensitive scopes.

---

## 5. When Drive is not enough

Drive is excellent for personal use and costs you nothing. It is the wrong
answer when you need to query *across* users — leaderboards, admin dashboards,
"how many rows exist" — because there is no such thing as a query across other
people's Drives.

At that point add Postgres for the index and keep Drive as the document store:

| Provider | Free tier | Why |
|---|---|---|
| **[Neon](https://neon.tech)** | 0.5 GB, scales to zero | Best fit. Serverless driver over HTTP, branches per preview deploy. |
| [Supabase](https://supabase.com) | 500 MB | If you also want auth, storage and realtime in one box |
| [Turso](https://turso.tech) | 9 GB | SQLite at the edge. Lowest latency; weakest for complex queries. |

The migration is contained: `src/lib/store/repo.ts` is the only file that
touches persistence. Add a `pg` backend beside the `drive` and `kv` ones and
nothing above it changes.

---

## 6. Latency, caching and cost

Things that actually matter, in order:

**1. Put everything in one region.** Vercel functions, Upstash, Postgres. This
dominates every other optimisation. Set Vercel's function region to the one
nearest your users (`bom1` for India) under Settings → Functions.

**2. The document cache already does the heavy lifting.** Reads hit Redis for
120 seconds before touching Drive; a Drive round trip is 200–500ms and a Redis
one is 1–5ms. Writes refresh the cache in place, so the next reader never sees
stale data.

**3. Conditional GETs.** `GET /api/files/[id]` returns an ETag and answers 304
when nothing changed, so polling costs a header exchange rather than a document.

**4. Batch operations.** The client debounces edits into batches. Twenty
keystrokes become one write. Keep it that way — the debounce is in
`useSheet.ts` (`FLUSH_DELAY`).

**5. Watch the assistant, not the app.** A chat turn costs 3–10 seconds and
real tokens; a page load costs milliseconds and nothing. If a bill surprises
you, it is the model. `rateLimit(userId, 'chat', 40, 60)` in `loop.ts` is the
throttle, and each skill's `max_tool_calls` caps a runaway loop.

### Function limits

`maxDuration` is set per route: 300s for chat, 60s for uploads. Hobby plans cap
at 60s — either upgrade or lower the chat cap. The design already survives this:
an approval **ends the stream** and resumes on a second request, so a user
thinking for five minutes never holds a function open.

---

## 7. Operations

**Health check.** `GET /api/health` returns Redis, AI and Google status plus a
latency number. Point [UptimeRobot](https://uptimerobot.com) or Better Stack at
it on a 5-minute interval — free, and you hear about an outage before your users
do.

**Logs.** Vercel → Deployments → Logs. Everything the app logs is prefixed
`[khata]`. For retention beyond a day, Vercel's Log Drains send to
Better Stack or Axiom.

**Drive integrity.** `POST /api/maintenance/drive` sweeps a user's Drive for
objects sharing an identity key, keeps the highest-revision copy and trashes the
rest. Safe to run any time; nothing is hard-deleted.

**Backups.** Drive keeps its own version history and a 30-day trash, so Google
accounts are covered. For password accounts, Redis is the only copy — Upstash
paid plans include daily backups, and that is a real reason to move those users
to Postgres.

**Rotating a secret.** Changing `SESSION_SECRET` signs everyone out; that is the
correct response to a leak. Changing the Google client secret requires everyone
to reconnect Drive.

---

## 8. Before you make it public

- [ ] `DEV_LOGIN_ENABLED=false`, or credentials changed from the defaults
- [ ] `SESSION_SECRET` is 32+ random bytes and not the one in `.env.example`
- [ ] `APP_URL` matches the deployed domain exactly
- [ ] Upstash configured — otherwise every serverless instance has its own
      memory and users see data appear and vanish depending on which one answers
- [ ] Redis in the same region as the functions
- [ ] Google consent screen published, if you want anyone but yourself
- [ ] `/api/health` returns `"redis": "ok"` (not `"memory"`)
- [ ] Uptime monitor pointed at `/api/health`
- [ ] A real sign-up, folder, file, row and assistant edit, on a phone

---

## 9. Things that will bite you

**"It worked locally and breaks deployed."** Almost always Redis. Locally the
in-memory fallback is one process, so everything is consistent. Deployed, each
serverless instance has its own — writes land on one and reads on another.
`/api/health` tells you which mode you are in.

**"Google says redirect_uri_mismatch."** The URI in the console must match
`APP_URL` + `/api/auth/callback` character for character. `https` vs `http`, a
trailing slash, and `www` all count as different.

**"The assistant says it is not configured."** `OLLAMA_API_KEY` is missing in
that environment. Vercel scopes variables per environment — setting it for
Production does not set it for Preview.

**"A model returns 404 or asks for a subscription."** Ollama Cloud gates models
per plan. `gpt-oss:120b`, `gpt-oss:20b` and `gemma4:31b` are reachable on a free
key; most of the larger ones are not. `GET /api/health` reports whether AI is
configured; the model list is at `https://ollama.com/api/tags`.

**Preview deployments share production data.** Vercel gives previews the
Production variables unless you set them separately. Create a second Upstash
database for Preview, or you will be testing against real users' data.
