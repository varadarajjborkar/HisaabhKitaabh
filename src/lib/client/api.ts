'use client'

import { toast } from '@/components/ui/Toast'

/**
 * Fetch wrapper.
 *
 * Every API response shares one envelope, so error handling lives here once
 * rather than at every call site. A 401 sends the user back to sign-in; a 409
 * is handed back to the caller intact because a conflict is something the
 * caller must resolve, not something to toast and forget.
 */

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public body: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  init: RequestInit & { quiet?: boolean } = {},
): Promise<T> {
  const { quiet, ...rest } = init
  let res: Response
  try {
    res = await fetch(path, {
      ...rest,
      headers: {
        ...(rest.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...(rest.headers ?? {}),
      },
    })
  } catch {
    const err = new ApiError('offline', 'You appear to be offline. Your work is kept locally until you reconnect.', 0)
    if (!quiet) toast.error(err.message)
    throw err
  }

  if (res.status === 304) return {} as T
  if (res.status === 204) return {} as T

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>

  if (!res.ok) {
    const err = new ApiError(String(body.code ?? 'error'), String(body.message ?? `Request failed (${res.status})`), res.status, body)
    if (res.status === 401) {
      window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname)
      throw err
    }
    // Conflicts are the caller's to resolve — they carry the current document.
    if (!quiet && res.status !== 409) toast.error(err.message)
    throw err
  }

  return body as T
}

export const get = <T>(path: string, init?: RequestInit & { quiet?: boolean }) => api<T>(path, { ...init, method: 'GET' })
export const post = <T>(path: string, data?: unknown, init?: RequestInit & { quiet?: boolean }) =>
  api<T>(path, { ...init, method: 'POST', body: data instanceof FormData ? data : JSON.stringify(data ?? {}) })
export const patch = <T>(path: string, data?: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data ?? {}) })
export const del = <T>(path: string, data?: unknown) =>
  api<T>(path, { method: 'DELETE', ...(data ? { body: JSON.stringify(data) } : {}) })
