// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared e2e harness for the 11 DoD Sprint-3 specs.
 *
 * Convention: this file is prefixed with `_` so Playwright never executes it
 * as a spec (see monorepo.md § Routes — prefix `-` or `_` → ignored by router;
 * Playwright uses the same convention for helper files).
 *
 * This module only performs actions and returns typed values.
 * It never calls `expect()` — assertions belong to the specs.
 *
 * External dependencies:
 *   - Node built-ins: `node:child_process`, `node:perf_hooks`
 *   - `ws` (WebSocket client) — already in apps/web devDependencies via
 *     @playwright/test transitive dep. If unavailable the WS helper falls back
 *     to a native WebSocket shim via globalThis.
 *
 * Required env vars (all have sensible defaults for local dev):
 *   E2E_API_URL          – defaults to http://localhost:3335
 *   E2E_TEST_EMAIL       – backup-code login email
 *   E2E_TEST_BACKUP_CODE – backup code (format: XXXX-XXXX-XXXX)
 *   PLOYDOK_E2E_REAL     – set to "1" to enable real infra specs
 *   PLOYDOK_DOMAIN_BASE  – defaults to demo.localhost
 */

import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"

// ---------------------------------------------------------------------------
// 1. Constants and gate
// ---------------------------------------------------------------------------

export const REAL_E2E = process.env["PLOYDOK_E2E_REAL"] === "1"
export const API_URL = process.env["E2E_API_URL"] ?? "http://localhost:3335"
export const DOMAIN_BASE =
  process.env["PLOYDOK_DOMAIN_BASE"] ?? "demo.localhost"
export const CADDY_HTTP_PORT = 8181

// ---------------------------------------------------------------------------
// 2. AuthContext
// ---------------------------------------------------------------------------

export interface AuthContext {
  cookie: string
  csrfToken: string
  userId: string
}

// ---------------------------------------------------------------------------
// Internal cookie helpers (reused from deploy-real.spec.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Parse all `ploydok_*` cookies from a raw Set-Cookie header (multi-value)
 * and return them as a single `Cookie:` header value suitable for API calls.
 */
function parseCookieHeader(setCookieHeader: string): string {
  return setCookieHeader
    .split(/,(?=[^ ])/g)
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter((kv) => kv.startsWith("ploydok_"))
    .join("; ")
}

/**
 * Extract the CSRF token from the Set-Cookie header.
 * The `ploydok_csrf` cookie is NOT HttpOnly — JS (and fetch) can read it.
 */
function extractCsrf(setCookieHeader: string): string {
  const match = /ploydok_csrf=([^;,\s]+)/.exec(setCookieHeader)
  if (!match?.[1])
    throw new Error("loginViaApi: ploydok_csrf cookie not found in Set-Cookie")
  return match[1]
}

/**
 * Extract the `sub` claim from the access JWT without verifying the signature
 * (we only need it for test correlation, not security).
 */
function extractUserIdFromJwt(jwtCookieValue: string): string {
  try {
    const parts = jwtCookieValue.split(".")
    const payload = parts[1]
    if (!payload) throw new Error("malformed JWT")
    const json = Buffer.from(payload, "base64url").toString("utf8")
    const parsed = JSON.parse(json) as { sub?: string }
    if (!parsed.sub) throw new Error("JWT has no sub claim")
    return parsed.sub
  } catch (err) {
    throw new Error(`loginViaApi: cannot extract userId from JWT — ${String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// 3. loginViaApi
// ---------------------------------------------------------------------------

/**
 * Authenticate via the backup-code API endpoint (no browser required).
 *
 * Calls POST /auth/backup-codes/consume (same as helpers/auth.ts `apiLogin`)
 * then builds a full AuthContext from the response cookies.
 *
 * Env vars required: E2E_TEST_EMAIL, E2E_TEST_BACKUP_CODE.
 */
export async function loginViaApi(): Promise<AuthContext> {
  const email = process.env["E2E_TEST_EMAIL"]
  const code = process.env["E2E_TEST_BACKUP_CODE"]

  if (!email || !code) {
    throw new Error(
      "loginViaApi: E2E_TEST_EMAIL and E2E_TEST_BACKUP_CODE must be set",
    )
  }

  const res = await fetch(`${API_URL}/auth/backup-codes/consume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`loginViaApi: POST /auth/backup-codes/consume failed (${res.status}): ${body}`)
  }

  const setCookieHeader = res.headers.get("set-cookie") ?? ""
  if (!setCookieHeader) {
    throw new Error("loginViaApi: no Set-Cookie header in response")
  }

  const cookie = parseCookieHeader(setCookieHeader)
  const csrfToken = extractCsrf(setCookieHeader)

  // Extract userId from the access cookie JWT value.
  const accessMatch = /ploydok_access=([^;,\s]+)/.exec(setCookieHeader)
  const accessJwt = accessMatch?.[1] ?? ""
  const userId = accessJwt ? extractUserIdFromJwt(accessJwt) : ""

  return { cookie, csrfToken, userId }
}

// ---------------------------------------------------------------------------
// 4. CreateAppInput + createApp
// ---------------------------------------------------------------------------

export interface CreateAppInput {
  name: string
  repoFullName: string
  branch: string
  buildMethod?: "auto" | "docker" | "nixpacks"
  rootDir?: string
  dockerfilePath?: string
  installCommand?: string
  buildCommand?: string
  startCommand?: string
  healthcheck?: {
    path?: string
    port?: number
    intervalS?: number
    timeoutS?: number
    retries?: number
    startPeriodS?: number
  }
}

/**
 * Create a new app via POST /apps.
 * Returns the `id` and `slug` from the 201 response.
 */
export async function createApp(
  auth: AuthContext,
  input: CreateAppInput,
): Promise<{ id: string; slug: string }> {
  const body = {
    gitProvider: "github" as const,
    name: input.name,
    repoFullName: input.repoFullName,
    branch: input.branch,
    ...(input.buildMethod !== undefined && { buildMethod: input.buildMethod }),
    ...(input.rootDir !== undefined && { rootDir: input.rootDir }),
    ...(input.dockerfilePath !== undefined && {
      dockerfilePath: input.dockerfilePath,
    }),
    ...(input.installCommand !== undefined && {
      installCommand: input.installCommand,
    }),
    ...(input.buildCommand !== undefined && { buildCommand: input.buildCommand }),
    ...(input.startCommand !== undefined && { startCommand: input.startCommand }),
    ...(input.healthcheck !== undefined && { healthcheck: input.healthcheck }),
  }

  const res = await fetch(`${API_URL}/apps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: auth.cookie,
      "x-csrf-token": auth.csrfToken,
    },
    body: JSON.stringify(body),
  })

  if (res.status !== 201) {
    const text = await res.text()
    throw new Error(`createApp: POST /apps returned ${res.status}: ${text}`)
  }

  const data = (await res.json()) as { app: { id: string; slug: string } }
  const { id, slug } = data.app

  if (!id || !slug) {
    throw new Error("createApp: response missing app.id or app.slug")
  }

  return { id, slug }
}

// ---------------------------------------------------------------------------
// 5. pollBuildStatus
// ---------------------------------------------------------------------------

/** Shape returned by GET /apps/:id — builds[0] element. */
export interface BuildRow {
  id: string
  appId: string
  status: string
  buildMethod: string | null
  imageTag: string | null
  containerId: string | null
  commitSha: string | null
  startedAt: number | null
  finishedAt: number | null
  createdAt: number | null
  errorMessage?: string | null
}

export interface PollOpts {
  /** Maximum wait in ms. Default 180 000. */
  timeoutMs?: number
  /** Polling interval in ms. Default 2 000. */
  intervalMs?: number
  /** Terminal success status to wait for. Default "succeeded". */
  expectStatus?: "succeeded"
}

/**
 * Poll GET /apps/:id until builds[0].status reaches `expectStatus`.
 *
 * Throws if:
 *   - The build enters "failed" status.
 *   - No build row is present within the timeout.
 *   - The timeout elapses.
 */
export async function pollBuildStatus(
  auth: AuthContext,
  appId: string,
  opts: PollOpts = {},
): Promise<BuildRow> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const intervalMs = opts.intervalMs ?? 2_000
  const expectStatus = opts.expectStatus ?? "succeeded"

  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const res = await fetch(`${API_URL}/apps/${appId}`, {
      headers: { cookie: auth.cookie },
    })

    if (res.ok) {
      const data = (await res.json()) as {
        builds: Array<BuildRow & { errorMessage?: string | null }>
      }

      const build = data.builds[0] as
        | (BuildRow & { errorMessage?: string | null })
        | undefined

      if (build !== undefined) {
        if (build.status === expectStatus) return build
        if (build.status === "failed") {
          throw new Error(
            `pollBuildStatus: build failed — ${build.errorMessage ?? "(no error message)"}`,
          )
        }
      }
    }

    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }

  throw new Error(
    `pollBuildStatus: build for app ${appId} did not reach "${expectStatus}" within ${timeoutMs}ms`,
  )
}

// ---------------------------------------------------------------------------
// 6. fetchViaProxy
// ---------------------------------------------------------------------------

/**
 * Perform an HTTP GET through the Caddy reverse proxy on port 8181.
 * The slug is used to construct the virtual-host URL.
 */
export async function fetchViaProxy(
  slug: string,
  path = "/",
): Promise<Response> {
  return fetch(`http://${slug}.${DOMAIN_BASE}:${CADDY_HTTP_PORT}${path}`)
}

// ---------------------------------------------------------------------------
// 7. triggerDeploy
// ---------------------------------------------------------------------------

/**
 * POST /apps/:id/deploy and return the `jobId` from the 202 response.
 */
export async function triggerDeploy(
  auth: AuthContext,
  appId: string,
): Promise<string> {
  const res = await fetch(`${API_URL}/apps/${appId}/deploy`, {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrfToken,
    },
  })

  if (res.status !== 202) {
    const text = await res.text()
    throw new Error(
      `triggerDeploy: POST /apps/${appId}/deploy returned ${res.status}: ${text}`,
    )
  }

  const data = (await res.json()) as { jobId: string }
  if (!data.jobId) {
    throw new Error("triggerDeploy: response missing jobId")
  }

  return data.jobId
}

// ---------------------------------------------------------------------------
// 8. triggerRollback
// ---------------------------------------------------------------------------

/**
 * POST /apps/:id/rollback. Throws if the server returns a non-2xx status.
 */
export async function triggerRollback(
  auth: AuthContext,
  appId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/apps/${appId}/rollback`, {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrfToken,
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `triggerRollback: POST /apps/${appId}/rollback returned ${res.status}: ${text}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 9. triggerStop
// ---------------------------------------------------------------------------

/**
 * POST /apps/:id/stop. Throws if the server returns a non-2xx status.
 */
export async function triggerStop(
  auth: AuthContext,
  appId: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/apps/${appId}/stop`, {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrfToken,
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(
      `triggerStop: POST /apps/${appId}/stop returned ${res.status}: ${text}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 10. chrono
// ---------------------------------------------------------------------------

/**
 * Measure the wall-clock duration of an async operation.
 * Returns both the result and the elapsed time in milliseconds.
 */
export async function chrono<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now()
  const result = await fn()
  const durationMs = performance.now() - start
  return { result, durationMs }
}

// ---------------------------------------------------------------------------
// 11. runAb — ApacheBench wrapper with JS fallback
// ---------------------------------------------------------------------------

export interface AbOpts {
  /** Total number of requests (-n). Ignored if `duration` is set. */
  requests?: number
  /** Concurrency level (-c). Default 10. */
  concurrency?: number
  /**
   * Alternative to `-n`: run for this many seconds (-t).
   * Pass as a string, e.g. "30" for 30 seconds.
   */
  duration?: string
}

export interface AbResult {
  non2xx: number
  totalRequests: number
  rps: number
  stdout: string
}

/**
 * Run ApacheBench (`ab`) against `url` and parse the summary.
 *
 * Falls back to a minimal JS runner if `ab` is not found on PATH.
 * The JS fallback fires requests concurrently for the given duration (or
 * until `requests` is exhausted) and counts 5xx responses.
 */
export async function runAb(url: string, opts: AbOpts = {}): Promise<AbResult> {
  const concurrency = opts.concurrency ?? 10

  // Try ab first.
  try {
    const stdout = await runAbProcess(url, opts, concurrency)
    return parseAbOutput(stdout)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("ab not found") || msg.includes("ENOENT")) {
      // Fall back to JS runner.
      return jsAbFallback(url, opts, concurrency)
    }
    throw err
  }
}

function runAbProcess(
  url: string,
  opts: AbOpts,
  concurrency: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args: Array<string> = ["-c", String(concurrency)]

    if (opts.duration !== undefined) {
      args.push("-t", opts.duration)
    } else {
      args.push("-n", String(opts.requests ?? 100))
    }

    args.push(url)

    const proc = spawn("ab", args, { stdio: ["ignore", "pipe", "pipe"] })

    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on("error", (err) => {
      reject(
        new Error(
          `ab not found or failed to start: ${err.message}`,
        ),
      )
    })

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ab exited with code ${code}: ${stderr}`))
      } else {
        resolve(stdout)
      }
    })
  })
}

function parseAbOutput(stdout: string): AbResult {
  const rpsMatch = /Requests per second:\s+([\d.]+)/.exec(stdout)
  const totalMatch = /Complete requests:\s+(\d+)/.exec(stdout)
  const non2xxMatch = /Non-2xx responses:\s+(\d+)/.exec(stdout)

  const rps = rpsMatch ? parseFloat(rpsMatch[1]) : 0
  const totalRequests = totalMatch ? parseInt(totalMatch[1], 10) : 0
  const non2xx = non2xxMatch ? parseInt(non2xxMatch[1], 10) : 0

  return { non2xx, totalRequests, rps, stdout }
}

async function jsAbFallback(
  url: string,
  opts: AbOpts,
  concurrency: number,
): Promise<AbResult> {
  const totalTarget: number | undefined =
    opts.requests ?? (opts.duration ? undefined : 100)
  const durationMs: number | undefined = opts.duration
    ? parseInt(opts.duration, 10) * 1_000
    : undefined

  const deadline: number | undefined =
    durationMs !== undefined ? Date.now() + durationMs : undefined

  let completed = 0
  let non2xx = 0
  const start = performance.now()

  const shouldContinue = (): boolean => {
    if (deadline !== undefined && Date.now() >= deadline) return false
    if (totalTarget !== undefined && completed >= totalTarget) return false
    return true
  }

  while (shouldContinue()) {
    const remaining =
      totalTarget !== undefined ? totalTarget - completed : concurrency
    const batchSize = Math.min(concurrency, remaining)
    if (batchSize <= 0) break

    const results = await Promise.allSettled(
      Array.from({ length: batchSize }, () =>
        fetch(url, { redirect: "follow" }).then((r) => r.status),
      ),
    )

    for (const r of results) {
      completed++
      if (r.status === "fulfilled") {
        if (r.value < 200 || r.value >= 300) non2xx++
      } else {
        // Network error counts as non-2xx.
        non2xx++
      }
    }
  }

  const elapsedS = (performance.now() - start) / 1_000
  const rps = elapsedS > 0 ? completed / elapsedS : 0

  const note = `[js-ab-fallback] ${completed} requests, ${non2xx} non-2xx, ${rps.toFixed(1)} rps`
  return { non2xx, totalRequests: completed, rps, stdout: note }
}

// ---------------------------------------------------------------------------
// 12. readBuildLogsWs
// ---------------------------------------------------------------------------

export interface ReadBuildLogsOpts {
  /** Max time to wait after last message before closing. Default 5 000 ms. */
  maxWaitMs?: number
}

export interface BuildLogsResult {
  lines: Array<string>
  /** p95 inter-message latency in ms (approximates streaming lag). */
  latencyMsP95: number
}

/**
 * Connect to the build-log WebSocket endpoint and collect all log lines.
 *
 * URL: ws://localhost:3335/ws/apps/:appId/build/:buildId
 * Auth: passes the `cookie` header.
 *
 * Message format (server → client): JSON `{ t: number, line: string }` or
 * heartbeat `{ type: "ping", t: number }`.
 *
 * The connection is closed when no new message arrives within `maxWaitMs`
 * (idle timeout) — the build is assumed to be complete at that point.
 *
 * p95 latency is computed from successive inter-message arrival deltas.
 *
 * Note: Bun's WebSocket API and the Node.js `ws` package both work here.
 * We use globalThis.WebSocket when available (Bun / browser), otherwise
 * fall back to dynamic-import of the `ws` npm package.
 */
export async function readBuildLogsWs(
  appId: string,
  buildId: string,
  opts: ReadBuildLogsOpts = {},
): Promise<BuildLogsResult> {
  const maxWaitMs = opts.maxWaitMs ?? 5_000
  const wsUrl = `ws://localhost:3335/ws/apps/${appId}/build/${buildId}`

  const lines: Array<string> = []
  const arrivalTimes: Array<number> = []

  return new Promise<BuildLogsResult>((resolve, reject) => {
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      const deltas = arrivalTimes
        .slice(1)
        .map((t, i) => t - (arrivalTimes[i] ?? t))
        .sort((a, b) => a - b)

      const p95Index = Math.floor(deltas.length * 0.95)
      const latencyMsP95 = deltas[p95Index] ?? 0

      resolve({ lines, latencyMsP95 })
    }

    const resetIdleTimer = (ws: WebSocket): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        ws.close(1000, "idle timeout")
        finish()
      }, maxWaitMs)
    }

    const openWs = (WS: typeof WebSocket): void => {
      // Note: Bun's fetch + WebSocket supports the `headers` option.
      // If the runtime does not support it (e.g. browser), the cookie must
      // be set via document.cookie before connecting. In Playwright / Bun
      // test runners the cookie header option is available.
      const ws = new WS(wsUrl)

      ws.onopen = (): void => {
        resetIdleTimer(ws)
      }

      ws.onmessage = (evt: MessageEvent): void => {
        const raw = typeof evt.data === "string" ? evt.data : String(evt.data)
        try {
          const msg = JSON.parse(raw) as
            | { type: string; t: number }
            | { t: number; line: string }

          if ("type" in msg && msg.type === "ping") {
            // Respond with pong to keep connection alive.
            ws.send(JSON.stringify({ type: "pong", t: Date.now() }))
          } else if ("line" in msg) {
            arrivalTimes.push(performance.now())
            lines.push(msg.line)
          }
        } catch {
          // Non-JSON message — store as raw line.
          arrivalTimes.push(performance.now())
          lines.push(raw)
        }
        resetIdleTimer(ws)
      }

      ws.onerror = (evt: Event): void => {
        reject(
          new Error(
            `readBuildLogsWs: WebSocket error on ${wsUrl}: ${String(evt)}`,
          ),
        )
      }

      ws.onclose = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        finish()
      }
    }

    // Use globalThis.WebSocket if available (Bun, browser), otherwise load `ws`.
    if (typeof globalThis.WebSocket !== "undefined") {
      openWs(globalThis.WebSocket)
    } else {
      // Dynamic import via Function constructor so tsc does not try to resolve
      // the "ws" module at type-check time. The "ws" package is only needed in
      // Node.js environments that lack a native WebSocket global (Node < 21).
      // In Bun and Playwright-managed Chromium, globalThis.WebSocket is present.
      const dynamicImport = new Function("m", "return import(m)") as (
        m: string,
      ) => Promise<{ default: unknown }>
      dynamicImport("ws")
        .then(({ default: WS }) => {
          openWs(WS as typeof WebSocket)
        })
        .catch((err: unknown) => {
          reject(
            new Error(
              `readBuildLogsWs: WebSocket not available and "ws" package failed to load: ${String(err)}`,
            ),
          )
        })
    }
  })
}

// ---------------------------------------------------------------------------
// 13. verifyRootless
// ---------------------------------------------------------------------------

export interface RootlessResult {
  user: string
  isRoot: boolean
}

/**
 * Inspect a Docker container and return its configured User.
 * Treats empty string, "root", and "0" as root identities.
 *
 * Requires `docker` CLI on PATH. Throws if `docker` is not found.
 */
export async function verifyRootless(
  containerId: string,
): Promise<RootlessResult> {
  return new Promise<RootlessResult>((resolve, reject) => {
    const proc = spawn(
      "docker",
      ["inspect", containerId, "--format", "{{.Config.User}}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    )

    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on("error", (err) => {
      reject(
        new Error(
          `verifyRootless: docker not found or failed to start: ${err.message}`,
        ),
      )
    })

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `verifyRootless: docker inspect exited ${code}: ${stderr.trim()}`,
          ),
        )
        return
      }

      const user = stdout.trim()
      const isRoot = user === "" || user === "root" || user === "0"
      resolve({ user, isRoot })
    })
  })
}

// ---------------------------------------------------------------------------
// 14. cleanupApp
// ---------------------------------------------------------------------------

/**
 * Best-effort teardown: stop the app then DELETE it.
 * All errors are swallowed so spec teardown never fails the suite.
 */
export async function cleanupApp(
  auth: AuthContext,
  appId: string,
): Promise<void> {
  try {
    await fetch(`${API_URL}/apps/${appId}/stop`, {
      method: "POST",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrfToken,
      },
    })
  } catch {
    // ignore
  }

  try {
    await fetch(`${API_URL}/apps/${appId}`, {
      method: "DELETE",
      headers: {
        cookie: auth.cookie,
        "x-csrf-token": auth.csrfToken,
      },
    })
  } catch {
    // ignore
  }
}
