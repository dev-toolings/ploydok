// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sprint-3 E2E — "100% real" deploy flow
 *
 * Verifies the full pipeline end-to-end:
 *   create app → auto-deploy (clone → BuildKit → registry push → agent
 *   spawn → Caddy route) → HTTP 200 → zero-downtime redeploy.
 *
 * Gate: PLOYDOK_E2E_REAL=1 (skipped by default so CI stays green).
 *
 * Required env vars:
 *   PLOYDOK_E2E_REAL        – must be "1" to run (gate)
 *   E2E_TEST_EMAIL          – backup-code login email
 *   E2E_TEST_BACKUP_CODE    – backup code (format: XXXX-XXXX-XXXX)
 *   E2E_API_URL             – defaults to http://localhost:3335
 *   PLOYDOK_DOMAIN_BASE     – defaults to demo.localhost
 *
 * Prerequisites (run in separate shells before launching this spec):
 *   Shell 1: make infra-up       (caddy + buildkitd + registry)
 *   Shell 2: make dev-agent      (Rust agent on /tmp/ploydok/agent.sock)
 *   Shell 3: make dev            (API :3335 + Web :5173)
 *   GitHub:  Ploydok GitHub App installed on the fixture repo's owner,
 *            with access granted to ploydok/fixture-hello. deploy.ts resolves
 *            the installation token automatically (no PAT seed required).
 */
import { expect, test } from "@playwright/test"
import { API_URL, apiLogin } from "./helpers/auth"

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

const REAL_E2E = process.env.PLOYDOK_E2E_REAL === "1"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API = API_URL
const DOMAIN_BASE = process.env.PLOYDOK_DOMAIN_BASE ?? "demo.localhost"
const CADDY_PORT = 8181
const POLL_INTERVAL_MS = 2_000
const BUILD_TIMEOUT_MS = 180_000

// Fixture repo details — must match the public ploydok/fixture-hello repo.
const FIXTURE_REPO = "ploydok/fixture-hello"
const FIXTURE_BRANCH = "main"
const FIXTURE_RESPONSE_TEXT = "hello from ploydok"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BuildSummary {
  id: string
  status: string
  errorMessage?: string | null
}

interface AppDetailResponse {
  app: {
    id: string
    slug: string
    status: string
    domain: string | null
  }
  builds: Array<BuildSummary>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse all ploydok_ cookies from a Set-Cookie header (multi-value) and
 * return them as a single "Cookie:" header value.
 */
function parseCookieHeader(setCookieHeader: string): string {
  return setCookieHeader
    .split(/,(?=[^ ])/g)
    .map((part) => part.split(";")[0]?.trim() ?? "")
    .filter((kv) => kv.startsWith("ploydok_"))
    .join("; ")
}

/**
 * Extract the CSRF token value from the Set-Cookie header.
 * The CSRF cookie is named `ploydok_csrf` and is NOT HttpOnly so the
 * frontend JS can read it. Matches `ploydok_csrf=<value>`.
 */
function extractCsrf(setCookieHeader: string): string {
  const match = /ploydok_csrf=([^;,\s]+)/.exec(setCookieHeader)
  if (!match?.[1]) throw new Error("ploydok_csrf cookie not found in Set-Cookie header")
  return match[1]
}

/**
 * Poll GET /apps/:id until builds[0].status is "succeeded" or "failed".
 * Returns the final AppDetailResponse.
 * Throws on timeout or if the build enters "failed" status.
 */
async function waitForBuildSuccess(
  appId: string,
  cookie: string,
  timeoutMs: number,
): Promise<AppDetailResponse> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/apps/${appId}`, {
      headers: { cookie },
    })
    if (res.ok) {
      const data = (await res.json()) as AppDetailResponse
      const build = data.builds[0]
      if (build) {
        if (build.status === "succeeded") return data
        if (build.status === "failed") {
          throw new Error(
            `Build failed: ${build.errorMessage ?? "(no error message)"}`,
          )
        }
      }
    }
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`Build for app ${appId} did not succeed within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("deploy-real — full pipeline e2e", () => {
  // Override per-describe timeout to 180s (as per testing.md convention for
  // sprint-3 infra specs).
  test.describe.configure({ timeout: BUILD_TIMEOUT_MS })

  test.skip(
    !REAL_E2E,
    "requires PLOYDOK_E2E_REAL=1 + make infra-up + make dev-agent + make dev",
  )

  // Shared state across the two tests (login once, share cookie + appId).
  let cookie = ""
  let csrf = ""
  let appId = ""
  let appSlug = ""

  // ---------------------------------------------------------------------------
  // test.beforeAll: login via backup-code API (no browser overhead)
  // ---------------------------------------------------------------------------

  test.beforeAll(async () => {
    const setCookieHeader = await apiLogin()
    cookie = parseCookieHeader(setCookieHeader)
    csrf = extractCsrf(setCookieHeader)
  })

  // ---------------------------------------------------------------------------
  // Test 1 — Create app → auto-deploy → assert HTTP 200 on live domain
  // ---------------------------------------------------------------------------

  test("create app triggers deploy; live domain returns HTTP 200", async () => {
    // 1. Create app — POST /apps
    const createRes = await fetch(`${API}/apps`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        name: "fixture-hello",
        gitProvider: "github",
        repoFullName: FIXTURE_REPO,
        branch: FIXTURE_BRANCH,
        buildMethod: "docker",
      }),
    })

    expect(createRes.status, `POST /apps should return 201 (got ${createRes.status})`).toBe(201)

    const createBody = (await createRes.json()) as { app: { id: string; slug: string } }
    appId = createBody.app.id
    appSlug = createBody.app.slug

    expect(appId, "app.id must be present").toBeTruthy()
    expect(appSlug, "app.slug must be present").toBeTruthy()

    // 2. Poll until build[0].status === "succeeded" (the deploy is auto-enqueued
    //    by POST /apps — see apps.ts: enqueueJob after INSERT).
    const detail = await waitForBuildSuccess(appId, cookie, BUILD_TIMEOUT_MS)

    expect(detail.builds[0]?.status).toBe("succeeded")

    // 3. Assert live HTTP 200 via Caddy on port 8181.
    //    Domain is: <slug>.<DOMAIN_BASE>, routed by Caddy on :8181.
    const liveUrl = `http://${detail.app.domain ?? `${appSlug}.${DOMAIN_BASE}`}:${CADDY_PORT}/`

    const liveRes = await fetch(liveUrl, { redirect: "follow" })
    expect(
      liveRes.status,
      `Live domain ${liveUrl} should respond 200`,
    ).toBe(200)

    const liveBody = await liveRes.text()
    expect(
      liveBody,
      `Response body should contain "${FIXTURE_RESPONSE_TEXT}"`,
    ).toContain(FIXTURE_RESPONSE_TEXT)

    console.log(`[deploy-real] App ${appId} is live at ${liveUrl}`)
  })

  // ---------------------------------------------------------------------------
  // Test 2 — Redeploy with zero-downtime check
  //   Runs 20 sequential fetch probes in parallel with a POST /apps/:id/deploy.
  //   No probe should return status >= 500.
  // ---------------------------------------------------------------------------

  test("zero-downtime check during redeploy (no 5xx)", async () => {
    // This test depends on appId being set by the first test.
    expect(appId, "appId must be set (run after test 1)").toBeTruthy()

    const liveUrl = `http://${appSlug}.${DOMAIN_BASE}:${CADDY_PORT}/`

    // Launch probe loop and redeploy in parallel.
    const [probeResults] = await Promise.all([
      // 20 sequential probes — collect status codes.
      (async (): Promise<Array<number>> => {
        const statuses: Array<number> = []
        for (let i = 0; i < 20; i++) {
          try {
            const r = await fetch(liveUrl, { redirect: "follow" })
            statuses.push(r.status)
          } catch {
            // Connection refused / DNS — count as 0 (not a 5xx).
            statuses.push(0)
          }
        }
        return statuses
      })(),

      // Trigger redeploy — POST /apps/:id/deploy
      (async (): Promise<void> => {
        const redeployRes = await fetch(`${API}/apps/${appId}/deploy`, {
          method: "POST",
          headers: {
            cookie,
            "x-csrf-token": csrf,
          },
        })
        // 202 Accepted is the expected response (job enqueued).
        expect(
          redeployRes.status,
          `POST /apps/${appId}/deploy should return 202`,
        ).toBe(202)

        // Wait for the second build to succeed.
        await waitForBuildSuccess(appId, cookie, BUILD_TIMEOUT_MS)
      })(),
    ])

    const fivexxCount = probeResults.filter((s) => s >= 500 && s <= 599).length
    const totalProbes = probeResults.length

    console.log(
      `[deploy-real] Zero-downtime: ${totalProbes} probes — 5xx: ${fivexxCount}`,
      `statuses: [${probeResults.join(", ")}]`,
    )

    expect(
      fivexxCount,
      `Expected 0 responses with status >= 500 during redeploy (got ${fivexxCount}/${totalProbes})`,
    ).toBe(0)
  })
})
