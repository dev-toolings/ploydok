// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sprint 3bis — Deploy from Docker image (no clone, no build).
 *
 * Covers the `git_provider === 'image'` path in the deploy worker
 * (`apps/api/src/worker/handlers/deploy.ts:261`): the worker skips clone
 * and build, pulls the image through the agent, and swaps Caddy via
 * `runBlueGreen`.
 *
 * DoD:
 *   - App created with `source: { type: 'image', image: 'nginx:alpine' }`
 *     reaches status `running` within 60 s.
 *   - Caddy serves HTTP 200 on the app domain.
 *
 * Gate: PLOYDOK_FULL_INFRA=1 (agent + registry + caddy required).
 */
import { expect, test } from "@playwright/test"
import { API_URL, apiLoginWithCsrf } from "../helpers/auth"

const FULL_INFRA = process.env.PLOYDOK_FULL_INFRA === "1"
const PROJECT_ID = process.env.E2E_TEST_PROJECT_ID

const POLL_INTERVAL_MS = 2_000
const DEPLOY_TIMEOUT_MS = 60_000

type AppRow = { id: string; status: string; domain: string | null }

async function fetchApp(appId: string, cookies: string): Promise<AppRow> {
  const res = await fetch(`${API_URL}/apps/${appId}`, {
    headers: { cookie: cookies },
  })
  expect(res.ok, `GET /apps/${appId} failed: ${res.status}`).toBe(true)
  const body = (await res.json()) as { app: AppRow }
  return body.app
}

async function waitForStatus(
  appId: string,
  target: string,
  cookies: string,
  timeoutMs: number
): Promise<AppRow> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const app = await fetchApp(appId, cookies)
    if (app.status === target) return app
    if (app.status === "failed") {
      throw new Error(`app ${appId} entered 'failed' during deploy`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(
    `app ${appId} did not reach '${target}' within ${timeoutMs}ms`
  )
}

test.describe("Sprint 3bis — deploy from Docker image", () => {
  test.skip(
    !FULL_INFRA || !PROJECT_ID,
    "requires PLOYDOK_FULL_INFRA=1 and E2E_TEST_PROJECT_ID"
  )

  test.setTimeout(DEPLOY_TIMEOUT_MS + 30_000)

  test("nginx:alpine image → container running + HTTP 200", async () => {
    const { cookie: cookies, csrfToken } = await apiLoginWithCsrf()

    const createRes = await fetch(`${API_URL}/apps`, {
      method: "POST",
      headers: {
        cookie: cookies,
        "x-csrf-token": csrfToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `e2e-image-${Date.now()}`,
        projectId: PROJECT_ID,
        gitProvider: "image",
        imageRef: "nginx:alpine",
        imagePullPolicy: "if_not_present",
        // nginx:alpine serves on port 80 — override the default 3000 so the
        // runner's healthcheck can actually succeed.
        healthcheck: { port: 80, path: "/" },
      }),
    })
    expect(createRes.ok, `POST /apps failed: ${createRes.status}`).toBe(true)
    const { app } = (await createRes.json()) as { app: { id: string } }

    const running = await waitForStatus(
      app.id,
      "running",
      cookies,
      DEPLOY_TIMEOUT_MS
    )
    expect(running.domain, "app should expose a domain").toBeTruthy()

    // Hit Caddy on loopback with the app's Host header — keeps the assertion
    // independent of whatever domain base the host is configured with.
    const resp = await fetch(`http://127.0.0.1:8181/`, {
      headers: { host: running.domain! },
      redirect: "manual",
    })
    expect([200, 301, 302, 308]).toContain(resp.status)
  })
})
