// SPDX-License-Identifier: AGPL-3.0-only
import type { AuthUser } from "../auth/middleware"
import { withMcpPrincipal } from "../auth/mcp-principal"

export const JSON_MAX_BYTES = 1024 * 1024

export type ApiRequest = {
  method?: "GET" | "POST"
  path: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  /** Keep only the last `tailBytes` of a text body (build logs). */
  tailBytes?: number
}

export type ApiError = { status: number; code: string; message: string }

export type ApiResult =
  | { ok: true; status: number; json: unknown }
  | { ok: true; status: number; text: string; omittedBytes: number }
  | { ok: false; error: ApiError }

export type ApiCaller = (req: ApiRequest) => Promise<ApiResult>

type RequestableApp = {
  request(
    input: string,
    init: RequestInit,
    env: object
  ): Response | Promise<Response>
}

/**
 * Runs an existing REST route in process, as the token that called /mcp. The
 * route keeps every check it already has (scope, ownership, second factor,
 * validation); the caller only bounds how much of the response it reads.
 */
export function createApiCaller(
  app: RequestableApp,
  env: object | undefined,
  user: AuthUser
): ApiCaller {
  const principalEnv = withMcpPrincipal(env, user)

  return async (req) => {
    const url = new URL(req.path, "http://mcp.internal")
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
    const init: RequestInit = { method: req.method ?? "GET" }
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body)
      init.headers = { "content-type": "application/json" }
    }

    const res = await app.request(
      url.pathname + url.search,
      init,
      principalEnv
    )
    const isJson = (res.headers.get("content-type") ?? "").includes(
      "application/json"
    )

    if (!res.ok) {
      const { bytes } = await readHead(res, 64 * 1024)
      return { ok: false, error: normalizeError(res.status, bytes, isJson) }
    }

    if (req.tailBytes !== undefined && !isJson) {
      const { bytes, omitted } = await readTail(res, req.tailBytes)
      return {
        ok: true,
        status: res.status,
        text: decodeTail(bytes),
        omittedBytes: omitted,
      }
    }

    const { bytes, overflow } = await readHead(res, JSON_MAX_BYTES)
    if (overflow) {
      return {
        ok: false,
        error: {
          status: 502,
          code: "RESPONSE_TOO_LARGE",
          message: "The response exceeds the MCP size limit; narrow the query",
        },
      }
    }
    const text = new TextDecoder().decode(bytes)
    if (!isJson) {
      return { ok: true, status: res.status, text, omittedBytes: 0 }
    }
    try {
      return { ok: true, status: res.status, json: JSON.parse(text) }
    } catch {
      return {
        ok: false,
        error: {
          status: 502,
          code: "MALFORMED_RESPONSE",
          message: "The API returned malformed JSON",
        },
      }
    }
  }
}

async function readHead(
  res: Response,
  max: number
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(), overflow: false }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size))
      size = max
      await reader.cancel()
      return { bytes: concat(chunks, size), overflow: true }
    }
    chunks.push(value)
    size += value.byteLength
  }
  return { bytes: concat(chunks, size), overflow: false }
}

/** Streams the body, keeping only its last `max` bytes in memory. */
async function readTail(
  res: Response,
  max: number
): Promise<{ bytes: Uint8Array; omitted: number }> {
  const reader = res.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(), omitted: 0 }
  const chunks: Uint8Array[] = []
  let kept = 0
  let omitted = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    kept += value.byteLength
    while (kept - (chunks[0]?.byteLength ?? 0) >= max) {
      const dropped = chunks.shift()!
      kept -= dropped.byteLength
      omitted += dropped.byteLength
    }
  }
  const all = concat(chunks, kept)
  if (all.byteLength <= max) return { bytes: all, omitted }
  const cut = all.byteLength - max
  return { bytes: all.subarray(cut), omitted: omitted + cut }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** Drops a partial UTF-8 sequence and partial first line left by the cut. */
function decodeTail(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes).replace(/^�+/, "")
  return text
}

function normalizeError(
  status: number,
  bytes: Uint8Array,
  isJson: boolean
): ApiError {
  const text = new TextDecoder().decode(bytes)
  const fallback = { status, code: `HTTP_${status}`, message: text.trim() }
  if (!isJson) {
    return { ...fallback, message: fallback.message || `HTTP ${status}` }
  }
  try {
    const body = JSON.parse(text) as unknown
    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>
      const nested = rec.error
      if (nested && typeof nested === "object") {
        const e = nested as Record<string, unknown>
        return {
          status,
          code: typeof e.code === "string" ? e.code : fallback.code,
          message:
            typeof e.message === "string" ? e.message : `HTTP ${status}`,
        }
      }
      if (typeof nested === "string") {
        return { status, code: nested, message: nested }
      }
      if (typeof rec.code === "string" || typeof rec.message === "string") {
        return {
          status,
          code: typeof rec.code === "string" ? rec.code : fallback.code,
          message:
            typeof rec.message === "string" ? rec.message : `HTTP ${status}`,
        }
      }
    }
  } catch {
    // fall through to the raw text
  }
  return { ...fallback, message: fallback.message || `HTTP ${status}` }
}
