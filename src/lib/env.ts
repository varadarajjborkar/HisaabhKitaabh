/**
 * Central env access. Everything is optional at import-time so the app boots in
 * degraded mode (memory store, no AI) instead of crashing - important on Vercel
 * where a missing var otherwise takes the whole deployment down.
 *
 * Two things are deliberately *not* forgiving in production, because being
 * forgiving about them is how a deployment ends up wide open: the session
 * secret, and the developer login. Both are checked in `deploymentProblems()`
 * and reported by /api/health.
 */
function opt(k: string): string | undefined {
  const v = process.env[k]
  return v && v.length > 0 ? v : undefined
}

export const isProd = process.env.NODE_ENV === 'production'

const DEFAULT_SESSION_SECRET = 'dev-only-insecure-secret-change-me-32byte'
const DEFAULT_DEV_PASSWORD = 'varad[123]'

export const env = {
  appUrl: opt('APP_URL') ?? opt('NEXT_PUBLIC_APP_URL') ?? vercelUrl() ?? 'http://localhost:3000',
  sessionSecret: opt('SESSION_SECRET') ?? DEFAULT_SESSION_SECRET,
  get sessionSecretIsDefault() {
    return (opt('SESSION_SECRET') ?? DEFAULT_SESSION_SECRET) === DEFAULT_SESSION_SECRET
  },

  google: {
    clientId: opt('GOOGLE_CLIENT_ID'),
    clientSecret: opt('GOOGLE_CLIENT_SECRET'),
    get enabled() {
      return Boolean(opt('GOOGLE_CLIENT_ID') && opt('GOOGLE_CLIENT_SECRET'))
    },
  },

  /**
   * The account database.
   *
   * `DATABASE_URL` is what most providers call it; Vercel's own Postgres
   * integration injects `POSTGRES_URL` instead, and its pooled variant is the
   * one you want from a serverless function.
   */
  database: {
    url: opt('DATABASE_URL') ?? opt('POSTGRES_URL') ?? opt('POSTGRES_PRISMA_URL'),
    get enabled() {
      return Boolean(opt('DATABASE_URL') ?? opt('POSTGRES_URL') ?? opt('POSTGRES_PRISMA_URL'))
    },
  },

  redis: {
    url: opt('UPSTASH_REDIS_REST_URL') ?? opt('KV_REST_API_URL'),
    token: opt('UPSTASH_REDIS_REST_TOKEN') ?? opt('KV_REST_API_TOKEN'),
    get enabled() {
      return Boolean(
        (opt('UPSTASH_REDIS_REST_URL') ?? opt('KV_REST_API_URL')) &&
          (opt('UPSTASH_REDIS_REST_TOKEN') ?? opt('KV_REST_API_TOKEN')),
      )
    },
  },

  /**
   * Outbound email, for the one thing that cannot be done in the browser:
   * proving that whoever is resetting a password can read that mailbox.
   *
   * Two providers, both over plain HTTPS rather than SMTP, because a
   * serverless function cannot reliably hold an SMTP connection open and
   * several hosts block the port outright. Either one's free tier is far
   * more than a password reset needs. Set one:
   *
   *   RESEND_API_KEY  - resend.com, 3,000 a month free
   *   BREVO_API_KEY   - brevo.com, 300 a day free
   *
   * MAIL_FROM has to be an address the provider will send as: a verified
   * domain, or Resend's shared onboarding sender, which only delivers to the
   * address that owns the Resend account.
   */
  mail: {
    resendKey: opt('RESEND_API_KEY'),
    brevoKey: opt('BREVO_API_KEY'),
    from: opt('MAIL_FROM') ?? 'HisaabhKitaabh <onboarding@resend.dev>',
    get provider(): 'resend' | 'brevo' | null {
      if (opt('RESEND_API_KEY')) return 'resend'
      if (opt('BREVO_API_KEY')) return 'brevo'
      return null
    },
    get enabled() {
      return Boolean(opt('RESEND_API_KEY') ?? opt('BREVO_API_KEY'))
    },
  },

  ollama: {
    /** Ollama Cloud: https://ollama.com  - self-hosted: http://127.0.0.1:11434 */
    host: (opt('OLLAMA_HOST') ?? 'https://ollama.com').replace(/\/+$/, ''),
    apiKey: opt('OLLAMA_API_KEY'),
    /**
     * Model tiers, verified reachable on a free Ollama Cloud key.
     * `gemma4` is the only image-capable model in that set, and in testing it
     * also followed nested tool-call schemas most faithfully - so it does
     * double duty as the vision model and the extraction model.
     */
    chatModel: opt('OLLAMA_CHAT_MODEL') ?? 'gpt-oss:120b',
    fastModel: opt('OLLAMA_FAST_MODEL') ?? 'gpt-oss:20b',
    visionModel: opt('OLLAMA_VISION_MODEL') ?? 'gemma4:31b',
    extractModel: opt('OLLAMA_EXTRACT_MODEL') ?? 'gemma4:31b',
    get enabled() {
      return Boolean(opt('OLLAMA_API_KEY') || (opt('OLLAMA_HOST') ?? '').includes('localhost') || (opt('OLLAMA_HOST') ?? '').includes('127.0.0.1'))
    },
  },

  dev: {
    /** A fixed username and password that skips OAuth, for local experimentation. */
    username: opt('DEV_USERNAME') ?? 'varad',
    password: opt('DEV_PASSWORD') ?? DEFAULT_DEV_PASSWORD,
    /**
     * Off in production unless someone deliberately turns it on.
     *
     * This grants the admin role with one fixed password, and the default
     * password is published in .env.example. Defaulting it to on and relying on
     * whoever deploys to remember to switch it off is not a defensible way to
     * ship a public URL, so the default flips with the environment.
     */
    get enabled() {
      const flag = opt('DEV_LOGIN_ENABLED')
      if (isProd) return flag === 'true' && opt('DEV_PASSWORD') !== undefined && opt('DEV_PASSWORD') !== DEFAULT_DEV_PASSWORD
      return flag !== 'false'
    },
  },

  limits: {
    maxRowsPerFile: Number(opt('MAX_ROWS_PER_FILE') ?? 5000),
    maxColumnsPerFile: Number(opt('MAX_COLUMNS_PER_FILE') ?? 32),
    maxAttachmentBytes: Number(opt('MAX_ATTACHMENT_BYTES') ?? 15 * 1024 * 1024),
    maxAttachmentsPerUser: Number(opt('MAX_ATTACHMENTS_PER_USER') ?? 2000),
    /** Total attachment bytes one account may hold. Keeps one user off the disk. */
    maxStorageBytesPerUser: Number(opt('MAX_STORAGE_BYTES_PER_USER') ?? 512 * 1024 * 1024),
  },
}

function vercelUrl(): string | undefined {
  // Vercel sets this on every deployment. It is the right fallback for preview
  // URLs, which change per push and can't be hard-coded - but note that Google
  // OAuth still needs an exact registered redirect, so APP_URL wins when set.
  const host = opt('VERCEL_PROJECT_PRODUCTION_URL') ?? opt('VERCEL_URL')
  return host ? `https://${host}` : undefined
}

export type DeploymentProblem = { key: string; severity: 'blocker' | 'warning'; message: string }

/**
 * What is wrong with this deployment's configuration.
 *
 * Reported by /api/health so a misconfigured deploy says so out loud instead of
 * looking fine until the day someone forges a session cookie or the dyno
 * restarts and every account's data is gone.
 */
export function deploymentProblems(): DeploymentProblem[] {
  const problems: DeploymentProblem[] = []

  if (isProd && env.sessionSecretIsDefault) {
    problems.push({
      key: 'SESSION_SECRET',
      severity: 'blocker',
      message: 'SESSION_SECRET is unset, so sessions are signed with a public default and anyone can forge one. Generate with: openssl rand -base64 32',
    })
  }
  if (!env.database.enabled && !env.redis.enabled) {
    problems.push({
      key: 'DATABASE_URL',
      severity: isProd ? 'blocker' : 'warning',
      message: 'No database is configured, so everything is held in memory and is lost on every restart. Attach Postgres and set DATABASE_URL.',
    })
  } else if (!env.database.enabled) {
    problems.push({
      key: 'DATABASE_URL',
      severity: 'warning',
      message: 'Running on Redis alone. It works, but attachments are held in memory-priced storage; Postgres is the better home for account data.',
    })
  }
  if (isProd && opt('DEV_LOGIN_ENABLED') === 'true' && !env.dev.enabled) {
    problems.push({
      key: 'DEV_PASSWORD',
      severity: 'warning',
      message: 'Developer login was requested but stays off: DEV_PASSWORD is still the published default. Set a real one to enable it.',
    })
  }
  if (!env.mail.enabled) {
    problems.push({
      key: 'RESEND_API_KEY',
      severity: 'warning',
      message: isProd
        ? 'No email provider is configured, so "Forgot password" cannot send a code and says so instead of sending one. Set RESEND_API_KEY or BREVO_API_KEY.'
        : 'No email provider is configured. Reset codes are written to the server log rather than sent, which is fine locally and refused in production.',
    })
  }
  if (env.dev.enabled && isProd) {
    problems.push({
      key: 'DEV_LOGIN_ENABLED',
      severity: 'warning',
      message: 'Developer login is enabled on a production deployment. It grants the admin role with one fixed password.',
    })
  }
  return problems
}
