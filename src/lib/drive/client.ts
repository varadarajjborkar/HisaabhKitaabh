import { env } from '../env'
import { K, kv } from '../redis'
import { withLock } from '../store/locks'

/**
 * Minimal Google Drive REST client.
 *
 * We deliberately do not pull in `googleapis` - it's tens of megabytes and we
 * need maybe eight endpoints. Raw fetch keeps the serverless bundle small,
 * which matters for cold starts on Vercel.
 *
 * Scope is `drive.file`: the app can only ever see files it created itself.
 * It cannot read the rest of the user's Drive, which is both the honest thing
 * to ask for and avoids Google's restricted-scope security review.
 */

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file',
].join(' ')

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

export type GoogleTokens = {
  refreshToken: string
  accessToken?: string
  expiresAt?: number
}

export class DriveAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DriveAuthError'
  }
}

export async function exchangeCode(code: string, redirectUri: string): Promise<{
  tokens: GoogleTokens
  profile: { sub: string; email: string; name: string; picture?: string }
}> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId!,
      client_secret: env.google.clientSecret!,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new DriveAuthError(`Token exchange failed: ${await res.text()}`)
  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; id_token: string }

  const profile = decodeIdToken(data.id_token)
  return {
    tokens: {
      refreshToken: data.refresh_token ?? '',
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    },
    profile,
  }
}

function decodeIdToken(idToken: string): { sub: string; email: string; name: string; picture?: string } {
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString('utf8'))
  return { sub: payload.sub, email: payload.email, name: payload.name ?? payload.email, picture: payload.picture }
}

/** Access token with refresh, cached in Redis so parallel lambdas share one. */
export async function accessTokenFor(userId: string): Promise<string> {
  const store = kv()
  const tokens = await store.get<GoogleTokens>(K.googleTokens(userId))
  if (!tokens?.refreshToken) throw new DriveAuthError('Google Drive is not connected for this account')

  if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt > Date.now() + 30_000) {
    return tokens.accessToken
  }

  // Serialise refreshes: a burst of requests should mint one token, not twenty.
  return withLock(`gtok:${userId}`, async () => {
    const fresh = await store.get<GoogleTokens>(K.googleTokens(userId))
    if (fresh?.accessToken && fresh.expiresAt && fresh.expiresAt > Date.now() + 30_000) return fresh.accessToken

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.google.clientId!,
        client_secret: env.google.clientSecret!,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      if (res.status === 400 || res.status === 401) {
        await store.del(K.googleTokens(userId))
        throw new DriveAuthError('Google access was revoked. Please sign in again')
      }
      throw new DriveAuthError(`Token refresh failed: ${body}`)
    }
    const data = (await res.json()) as { access_token: string; expires_in: number }
    const updated: GoogleTokens = {
      refreshToken: tokens.refreshToken,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    }
    await store.set(K.googleTokens(userId), updated)
    return data.access_token
  }, { ttlMs: 15_000, waitMs: 8_000 })
}

export async function saveTokens(userId: string, tokens: GoogleTokens): Promise<void> {
  const store = kv()
  if (!tokens.refreshToken) {
    // Google only returns a refresh token on first consent; keep the old one.
    const prior = await store.get<GoogleTokens>(K.googleTokens(userId))
    if (prior?.refreshToken) tokens.refreshToken = prior.refreshToken
  }
  await store.set(K.googleTokens(userId), tokens)
}

export async function hasDrive(userId: string): Promise<boolean> {
  const tokens = await kv().get<GoogleTokens>(K.googleTokens(userId))
  return Boolean(tokens?.refreshToken)
}

// ------------------------------------------------------------------ requests

type DriveFile = {
  id: string
  name: string
  mimeType: string
  modifiedTime?: string
  size?: string
  appProperties?: Record<string, string>
  trashed?: boolean
}

async function driveFetch(userId: string, url: string, init: RequestInit = {}, retries = 2): Promise<Response> {
  const token = await accessTokenFor(userId)
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  })
  // 403 rateLimitExceeded / 429 / 5xx are Drive telling us to slow down.
  if ((res.status === 429 || res.status >= 500 || res.status === 403) && retries > 0) {
    const retryable = res.status !== 403 || /rateLimit|userRateLimit|quota/i.test(await res.clone().text())
    if (retryable) {
      await new Promise((r) => setTimeout(r, (3 - retries) * 400 + Math.random() * 300))
      return driveFetch(userId, url, init, retries - 1)
    }
  }
  return res
}

async function driveJson<T>(userId: string, url: string, init?: RequestInit): Promise<T> {
  const res = await driveFetch(userId, url, init)
  if (!res.ok) throw new Error(`Drive ${init?.method ?? 'GET'} ${new URL(url).pathname} -> ${res.status}: ${await res.text()}`)
  return (await res.json()) as T
}

export const drive = {
  async list(userId: string, query: string, fields = 'files(id,name,mimeType,modifiedTime,size,appProperties,trashed)'): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q: query,
      fields: `nextPageToken,${fields}`,
      pageSize: '1000',
      spaces: 'drive',
      orderBy: 'createdTime',
    })
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      if (pageToken) params.set('pageToken', pageToken)
      const data = await driveJson<{ files: DriveFile[]; nextPageToken?: string }>(userId, `${DRIVE}/files?${params}`)
      out.push(...(data.files ?? []))
      pageToken = data.nextPageToken
    } while (pageToken)
    return out
  },

  async createFolder(userId: string, name: string, parentId: string | null, appProperties?: Record<string, string>): Promise<string> {
    const body = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
      ...(appProperties ? { appProperties } : {}),
    }
    const data = await driveJson<{ id: string }>(userId, `${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return data.id
  },

  async createFile(userId: string, params: { name: string; parentId: string; mime: string; content: Buffer | string; appProperties?: Record<string, string> }): Promise<string> {
    const boundary = `hisaabkitaab${Math.random().toString(36).slice(2)}`
    const metadata = JSON.stringify({
      name: params.name,
      parents: [params.parentId],
      ...(params.appProperties ? { appProperties: params.appProperties } : {}),
    })
    const body = multipart(boundary, metadata, params.mime, params.content)
    const data = await driveJson<{ id: string }>(userId, `${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: body as unknown as BodyInit,
    })
    return data.id
  },

  async updateContent(userId: string, fileId: string, mime: string, content: Buffer | string): Promise<void> {
    const res = await driveFetch(userId, `${UPLOAD}/files/${fileId}?uploadType=media&fields=id`, {
      method: 'PATCH',
      headers: { 'content-type': mime },
      body: content as unknown as BodyInit,
    })
    if (!res.ok) throw new Error(`Drive update failed ${res.status}: ${await res.text()}`)
  },

  async updateMetadata(userId: string, fileId: string, patch: Record<string, unknown>): Promise<void> {
    await driveJson(userId, `${DRIVE}/files/${fileId}?fields=id`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
  },

  async download(userId: string, fileId: string): Promise<Buffer> {
    const res = await driveFetch(userId, `${DRIVE}/files/${fileId}?alt=media`)
    if (!res.ok) throw new Error(`Drive download failed ${res.status}: ${await res.text()}`)
    return Buffer.from(await res.arrayBuffer())
  },

  async downloadText(userId: string, fileId: string): Promise<string> {
    return (await drive.download(userId, fileId)).toString('utf8')
  },

  async trash(userId: string, fileId: string): Promise<void> {
    await drive.updateMetadata(userId, fileId, { trashed: true })
  },

  async remove(userId: string, fileId: string): Promise<void> {
    const res = await driveFetch(userId, `${DRIVE}/files/${fileId}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed ${res.status}`)
  },

  async about(userId: string): Promise<{ used: number; limit: number }> {
    const data = await driveJson<{ storageQuota: { usage: string; limit?: string } }>(
      userId,
      `${DRIVE}/about?fields=storageQuota`,
    )
    return {
      used: Number(data.storageQuota.usage ?? 0),
      limit: Number(data.storageQuota.limit ?? 0),
    }
  },
}

function multipart(boundary: string, metadata: string, mime: string, content: Buffer | string): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`,
  )
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  const tail = Buffer.from(`\r\n--${boundary}--`)
  return Buffer.concat([head, body, tail])
}

export type { DriveFile }
