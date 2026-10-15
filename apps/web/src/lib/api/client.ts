// SPDX-License-Identifier: AGPL-3.0-only

import { createIsomorphicFn } from "@tanstack/react-start"
import {
  ApiError,
  BackendUnavailableError,
  SecondFactorRequiredError,
  SessionExpiredError,
  apiErrorMessage,
} from "./errors"
import { apiBaseUrl } from "./base"
import type { RefreshResult } from "./errors"

// ---------------------------------------------------------------------------
// Module-scope state: shared in both runtimes:
//   - On the client (single user, single process): correct.
//   - On the SSR server: csrfToken/refreshPromise/getCache are not user-secret;
//     refresh is rarely contended because each beforeLoad makes ~1 /me call.
//     Per-request cookie isolation is handled by _ssrCookieOverrides below.
// ---------------------------------------------------------------------------

let _clientAccessExpiresAt: number | null = null

interface RuntimeState {
  csrfToken: string | null
  csrfPromise: Promise<string> | null
  refreshPromise: Promise<RefreshResult> | null
  getCache: Map<string, Promise<unknown>>
}

function createRuntimeState(): RuntimeState {
  return {
    csrfToken: null,
    csrfPromise: null,
    refreshPromise: null,
    getCache: new Map(),
  }
}

const _clientState = createRuntimeState()

interface AuthCallbacks {
  onTokenRefreshed?: () => void
  onLoggedOut?: () => void
  onAccessExpiryUpdate?: (expiresAt: number | null) => void
}

let _authCallbacks: AuthCallbacks = {}

export function setAuthCallbacks(cb: AuthCallbacks): void {
  _authCallbacks = cb
}

export function invalidateGetCache(path?: string): void {
  if (path) _clientState.getCache.delete(path)
  else _clientState.getCache.clear()
}

export function resetCsrfToken(): void {
  _clientState.csrfToken = null
}

export function updateAccessExpiry(expiresAt: number | null): void {
  if (typeof window === "undefined") return
  _clientAccessExpiresAt = expiresAt
  _authCallbacks.onAccessExpiryUpdate?.(expiresAt)
}

export function getAccessExpiry(): number | null {
  return _clientAccessExpiresAt
}

// ---------------------------------------------------------------------------
// SSR cookie helpers
//
// The helpers below are intentionally isomorphic. TanStack Start replaces each
// `createIsomorphicFn()` chain with the environment-specific implementation at
// build time, so the client bundle never resolves `@tanstack/react-start/server`.
// ---------------------------------------------------------------------------

const DEBUG_AUTH =
  typeof process !== "undefined" && !!process.env["PLOYDOK_DEBUG_AUTH"]

// Per-request cookie rotation: when /auth/refresh sets new cookies during the
// SSR cycle, the in-flight retry must use them. The incoming Cookie header is
// immutable, so we attach rotated values to the per-request Request object via
// a WeakMap. TanStack's getRequest() is per-request via H3's AsyncLocalStorage,
// so the key is stable and unique.
const _ssrOverrides: WeakMap<Request, Map<string, string>> = new WeakMap()
const _ssrState: WeakMap<Request, RuntimeState> = new WeakMap()

const getSsrRequest = createIsomorphicFn()
  .client(() => null)
  .server(async (): Promise<Request | null> => {
    try {
      const { getRequest } = await import("@tanstack/react-start/server")
      return getRequest()
    } catch (e) {
      if (DEBUG_AUTH) console.log("[ssr-auth] getRequest unavailable:", e)
      return null
    }
  })

const getSsrCookies = createIsomorphicFn()
  .client(() => ({}))
  .server(async (): Promise<Record<string, string>> => {
    try {
      const { getCookies } = await import("@tanstack/react-start/server")
      return getCookies()
    } catch (e) {
      if (DEBUG_AUTH) console.log("[ssr-auth] getCookies threw:", e)
      return {}
    }
  })

const setSsrSetCookieHeader = createIsomorphicFn()
  .client((_setCookies: Array<string>) => {})
  .server(async (setCookies: Array<string>): Promise<void> => {
    try {
      const { setResponseHeader } = await import("@tanstack/react-start/server")
      setResponseHeader("set-cookie", setCookies)
      if (DEBUG_AUTH) {
        console.log(
          "[ssr-auth] forwarded",
          setCookies.length,
          "Set-Cookie headers to browser"
        )
      }
    } catch (e) {
      if (DEBUG_AUTH) console.log("[ssr-auth] setResponseHeader threw:", e)
    }
  })

async function getExistingSsrOverrides(): Promise<
  Map<string, string> | undefined
> {
  const req = await getSsrRequest()
  if (!req) return undefined
  return _ssrOverrides.get(req)
}

async function getMutableSsrOverrides(): Promise<
  Map<string, string> | undefined
> {
  const req = await getSsrRequest()
  if (!req) return undefined
  let overrides = _ssrOverrides.get(req)
  if (!overrides) {
    overrides = new Map()
    _ssrOverrides.set(req, overrides)
  }
  return overrides
}

async function getRuntimeState(): Promise<RuntimeState> {
  if (typeof window !== "undefined") return _clientState

  const req = await getSsrRequest()
  if (!req) return createRuntimeState()
  let state = _ssrState.get(req)
  if (!state) {
    state = createRuntimeState()
    _ssrState.set(req, state)
  }
  return state
}

async function invalidateRuntimeGetCache(path?: string): Promise<void> {
  const state = await getRuntimeState()
  if (path) state.getCache.delete(path)
  else state.getCache.clear()
}

async function buildSsrCookieHeader(): Promise<string> {
  const base = await getSsrCookies()
  let overrides: Map<string, string> | undefined
  try {
    overrides = await getExistingSsrOverrides()
  } catch {
    // outside an SSR request context: proceed with base only
  }

  const merged: Record<string, string> = {
    ...base,
    ...(overrides ? Object.fromEntries(overrides) : {}),
  }
  const parts: Array<string> = []
  for (const [k, v] of Object.entries(merged)) parts.push(`${k}=${v}`)
  const header = parts.join("; ")

  if (DEBUG_AUTH) {
    console.log(
      "[ssr-auth] buildSsrCookieHeader → names:",
      Object.keys(merged).join(",") || "(none)",
      "len:",
      header.length
    )
  }
  return header
}

async function applySsrSetCookies(setCookies: Array<string>): Promise<void> {
  if (setCookies.length === 0) return

  await setSsrSetCookieHeader(setCookies)

  try {
    const overrides = await getMutableSsrOverrides()
    if (!overrides) return
    for (const raw of setCookies) {
      const semi = raw.indexOf(";")
      const pair = semi === -1 ? raw : raw.slice(0, semi)
      const eq = pair.indexOf("=")
      if (eq === -1) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (!name) continue
      if (value === "" || /\bMax-Age=0\b/i.test(raw)) overrides.delete(name)
      else overrides.set(name, value)
    }
  } catch {
    // no request context: ignore
  }
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

async function fetchCsrf(state: RuntimeState): Promise<string> {
  const res = await rawRequest("/auth/csrf", { method: "GET" })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw responseError(res, data, "/auth/csrf", "GET")
  }
  const data = (await res.json()) as { token: string }
  state.csrfToken = data.token
  return data.token
}

async function getCsrfToken(): Promise<string> {
  const state = await getRuntimeState()
  if (state.csrfToken) return state.csrfToken
  if (state.csrfPromise) return state.csrfPromise
  const promise = fetchCsrf(state)
  state.csrfPromise = promise
  try {
    return await promise
  } finally {
    if (state.csrfPromise === promise) state.csrfPromise = null
  }
}

// ---------------------------------------------------------------------------
// rawRequest: SSR forwards merged Cookie header (incoming + rotation overrides)
// ---------------------------------------------------------------------------

async function rawRequest(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (typeof window === "undefined" && !headers.has("cookie")) {
    const cookieHeader = await buildSsrCookieHeader()
    if (cookieHeader) headers.set("cookie", cookieHeader)
  }
  if (typeof window === "undefined" && process.env["PLOYDOK_DEBUG_AUTH"]) {
    const ck = headers.get("cookie") ?? ""
    console.log(
      "[ssr-auth] rawRequest",
      init.method ?? "GET",
      path,
      "cookieLen:",
      ck.length,
      "hasAccess:",
      ck.includes("ploydok_access="),
      "hasRefresh:",
      ck.includes("ploydok_refresh=")
    )
  }
  const url = `${apiBaseUrl()}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      credentials: "include",
      ...init,
      headers,
    })
  } catch (cause) {
    throw new BackendUnavailableError(
      undefined,
      { method: init.method ?? "GET", url },
      cause
    )
  }
  if (typeof window === "undefined" && process.env["PLOYDOK_DEBUG_AUTH"]) {
    console.log("[ssr-auth] rawRequest", path, "→", res.status)
  }
  return res
}

function toBackendUnavailableError(error: unknown): BackendUnavailableError {
  if (error instanceof BackendUnavailableError) return error
  return new BackendUnavailableError()
}

// ---------------------------------------------------------------------------
// refreshSession: single-flight, typed result
// ---------------------------------------------------------------------------

async function doRefresh(): Promise<RefreshResult> {
  let res: Response
  try {
    res = await rawRequest("/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
  } catch {
    return { ok: false, reason: "network_error" }
  }
  if (res.status === 409) {
    const data = (await res
      .clone()
      .json()
      .catch(() => ({}))) as {
      error?: { code?: string }
    }
    if (data.error?.code === "REFRESH_CONFLICT") {
      // A concurrent browser tab won the rotation. Cookies are shared between
      // tabs, so let its Set-Cookie settle before retrying the original call.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { ok: true, accessExpiresAt: null }
    }
  }
  if (!res.ok) {
    const reason: "refresh_expired" | "server_error" =
      res.status === 401 ? "refresh_expired" : "server_error"
    if (reason === "refresh_expired" && typeof window !== "undefined") {
      _clientAccessExpiresAt = null
      _authCallbacks.onLoggedOut?.()
    }
    return { ok: false, reason }
  }
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : []
  if (typeof window === "undefined") {
    await applySsrSetCookies(setCookies)
  }
  let accessExpiresAt: number | null = null
  try {
    const data = (await res.json()) as { accessExpiresAt?: unknown }
    if (typeof data.accessExpiresAt === "number")
      accessExpiresAt = data.accessExpiresAt
  } catch {
    // ignore
  }
  if (typeof window !== "undefined") {
    _clientAccessExpiresAt = accessExpiresAt
    _authCallbacks.onAccessExpiryUpdate?.(accessExpiresAt)
    _authCallbacks.onTokenRefreshed?.()
  }
  return { ok: true, accessExpiresAt }
}

async function refreshSession(): Promise<RefreshResult> {
  const state = await getRuntimeState()
  if (state.refreshPromise) return state.refreshPromise
  const promise = doRefresh()
  state.refreshPromise = promise
  void promise.finally(() => {
    if (state.refreshPromise === promise) state.refreshPromise = null
  })
  return promise
}

export async function triggerRefresh(): Promise<RefreshResult> {
  return refreshSession()
}

function isPreSessionPath(path: string): boolean {
  return (
    path === "/auth/refresh" ||
    path === "/auth/csrf" ||
    path === "/auth/backup-codes/consume" ||
    path === "/auth/setup/password" ||
    path.startsWith("/auth/login")
  )
}

// ---------------------------------------------------------------------------
// apiFetch
// ---------------------------------------------------------------------------

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

function responseError(
  response: Response,
  data: unknown,
  path: string,
  method: string
): ApiError {
  const payload = data as {
    error?: {
      code?: string
      message?: string
      fields?: Record<string, string>
      req_id?: string
    }
  } | null
  const code = payload?.error?.code ?? "UNKNOWN"
  const request = {
    method,
    url: `${apiBaseUrl()}${path}`,
    requestId:
      payload?.error?.req_id ??
      response.headers.get("x-request-id") ??
      undefined,
  }
  const message = apiErrorMessage(
    response.status,
    code,
    payload?.error?.message ?? response.statusText,
    request
  )
  if (
    response.status === 403 &&
    (code === "SECOND_FACTOR_REQUIRED" || code === "totp_required")
  ) {
    return new SecondFactorRequiredError(message)
  }
  return new ApiError(
    response.status,
    code,
    message,
    payload?.error?.fields,
    request
  )
}

interface ApiRequestInit {
  method?: Method
  body?: unknown
  headers?: Record<string, string>
}

async function apiFetchCore<T>(
  path: string,
  method: Method,
  body: unknown,
  extraHeaders: Record<string, string>,
  retried: boolean
): Promise<T> {
  const isMutating = method !== "GET"
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  }
  if (isMutating) {
    const token = await getCsrfToken()
    headers["x-csrf-token"] = token
    await invalidateRuntimeGetCache()
  }

  let res: Response
  try {
    res = await rawRequest(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    throw toBackendUnavailableError(error)
  }

  if (res.status === 401 && !retried && !isPreSessionPath(path)) {
    await invalidateRuntimeGetCache()
    const result = await refreshSession()
    if (result.ok)
      return apiFetchCore<T>(path, method, body, extraHeaders, true)
    if (result.reason === "refresh_expired") throw new SessionExpiredError()
    if (result.reason === "network_error") throw new BackendUnavailableError()
    throw new ApiError(
      503,
      "REFRESH_FAILED",
      `Refresh failed: ${result.reason}`
    )
  }

  if (res.status === 204) return undefined as T

  const data: unknown = await res.json().catch(() => ({}))

  if (!res.ok) {
    throw responseError(res, data, path, method)
  }

  if (
    typeof window !== "undefined" &&
    data &&
    typeof data === "object" &&
    "accessExpiresAt" in data
  ) {
    const exp = (data as { accessExpiresAt?: unknown }).accessExpiresAt
    if (typeof exp === "number") {
      _clientAccessExpiresAt = exp
      _authCallbacks.onAccessExpiryUpdate?.(exp)
    }
  }

  return data as T
}

export async function apiFetch<T = unknown>(
  path: string,
  { method = "GET", body, headers: extraHeaders = {} }: ApiRequestInit = {}
): Promise<T> {
  if (method === "GET") {
    const state = await getRuntimeState()
    const cached = state.getCache.get(path)
    if (cached) return cached as Promise<T>
    const promise = apiFetchCore<T>(path, method, body, extraHeaders, false)
    state.getCache.set(path, promise)
    try {
      return await promise
    } finally {
      if (state.getCache.get(path) === promise) state.getCache.delete(path)
    }
  }
  return apiFetchCore<T>(path, method, body, extraHeaders, false)
}
