/**
 * Central env access. Everything is optional at import-time so the app boots in
 * degraded mode (memory store, no AI) instead of crashing — important on Vercel
 * where a missing var otherwise takes the whole deployment down.
 */
function opt(k: string): string | undefined {
  const v = process.env[k]
  return v && v.length > 0 ? v : undefined
}

export const env = {
  appUrl: opt('APP_URL') ?? opt('NEXT_PUBLIC_APP_URL') ?? 'http://localhost:3000',
  sessionSecret: opt('SESSION_SECRET') ?? 'dev-only-insecure-secret-change-me-32byte',

  google: {
    clientId: opt('GOOGLE_CLIENT_ID'),
    clientSecret: opt('GOOGLE_CLIENT_SECRET'),
    get enabled() {
      return Boolean(opt('GOOGLE_CLIENT_ID') && opt('GOOGLE_CLIENT_SECRET'))
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

  ollama: {
    /** Ollama Cloud: https://ollama.com  — self-hosted: http://127.0.0.1:11434 */
    host: (opt('OLLAMA_HOST') ?? 'https://ollama.com').replace(/\/+$/, ''),
    apiKey: opt('OLLAMA_API_KEY'),
    /**
     * Model tiers, verified reachable on a free Ollama Cloud key.
     * `gemma4` is the only image-capable model in that set, and in testing it
     * also followed nested tool-call schemas most faithfully — so it does
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
    /** The "god login" for local experimentation. Override in prod. */
    username: opt('DEV_USERNAME') ?? 'varad',
    password: opt('DEV_PASSWORD') ?? 'varad[123]',
    enabled: opt('DEV_LOGIN_ENABLED') !== 'false',
  },

  limits: {
    maxRowsPerFile: Number(opt('MAX_ROWS_PER_FILE') ?? 5000),
    maxColumnsPerFile: Number(opt('MAX_COLUMNS_PER_FILE') ?? 32),
    maxAttachmentBytes: Number(opt('MAX_ATTACHMENT_BYTES') ?? 15 * 1024 * 1024),
    maxAttachmentsPerUser: Number(opt('MAX_ATTACHMENTS_PER_USER') ?? 2000),
  },
}

export const isProd = process.env.NODE_ENV === 'production'
