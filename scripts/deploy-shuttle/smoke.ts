// SPDX-License-Identifier: AGPL-3.0-only
// Post-deploy smoke test: redeploy the reference app on the staging instance
// through the public API, wait for the build, then require its public URL to
// answer. Configuration lives on the operator machine only, in
// ~/.config/ploydok/smoke.env (mode 0600) or the environment, which wins:
//   PLOYDOK_SMOKE_URL      instance origin, e.g. http://192-168-1-235.sslip.io
//   PLOYDOK_SMOKE_APP_ID   id of the app deployed from scripts/deploy-shuttle/smoke-app
//   PLOYDOK_SMOKE_TOKEN    API token with apps:read and apps:deploy
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface SmokeBuild {
  id: string
  status: string
  createdAt: number | null
  errorMessage: string | null
}

export type BuildOutcome = "pending" | "succeeded" | "failed"

const SUCCEEDED = new Set(["succeeded", "succeeded_with_warning"])
const FAILED = new Set(["failed", "cancelled"])

/** Newest build created at or after the deploy request. */
export function pickBuild(
  builds: readonly SmokeBuild[],
  requestedAt: number
): SmokeBuild | undefined {
  return builds
    .filter((build) => (build.createdAt ?? 0) >= requestedAt)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
}

export function buildOutcome(status: string): BuildOutcome {
  if (SUCCEEDED.has(status)) return "succeeded"
  if (FAILED.has(status)) return "failed"
  return "pending"
}

export interface SmokeConfig {
  origin: string
  appId: string
  token: string
}

/** KEY=VALUE lines; blank lines and # comments are ignored. */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) values[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, "$2")
  }
  return values
}

export function readConfig(
  env: Record<string, string | undefined>
): SmokeConfig | null {
  const file =
    env.PLOYDOK_SMOKE_ENV_FILE ??
    join(homedir(), ".config", "ploydok", "smoke.env")
  const values = {
    ...(existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {}),
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key, value]) => key.startsWith("PLOYDOK_SMOKE_") && value
      )
    ),
  }
  const origin = values.PLOYDOK_SMOKE_URL?.replace(/\/+$/, "")
  const appId = values.PLOYDOK_SMOKE_APP_ID
  const token = values.PLOYDOK_SMOKE_TOKEN
  if (!origin || !appId || !token) return null
  return { origin, appId, token }
}

async function api<T>(
  config: SmokeConfig,
  method: "GET" | "POST",
  path: string
): Promise<T> {
  // A non-browser client satisfies the double-submit CSRF check itself.
  const csrf = crypto.randomUUID()
  const response = await fetch(`${config.origin}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.token}`,
      cookie: `csrf=${csrf}`,
      "x-csrf-token": csrf,
    },
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} -> HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

async function main(): Promise<number> {
  const config = readConfig(process.env)
  if (!config) {
    console.warn(
      "[smoke] skipped: set PLOYDOK_SMOKE_URL, PLOYDOK_SMOKE_APP_ID and an API token (see deploy/README.md)"
    )
    return 0
  }
  const timeoutMs = Number(process.env.PLOYDOK_SMOKE_TIMEOUT_MS ?? 600_000)
  const requestedAt = Date.now() - 5_000
  await api(config, "POST", `/apps/${config.appId}/deploy`)
  console.log(`[smoke] deploy requested for app ${config.appId}`)

  const deadline = Date.now() + timeoutMs
  let build: SmokeBuild | undefined
  while (Date.now() < deadline) {
    const { builds } = await api<{ builds: SmokeBuild[] }>(
      config,
      "GET",
      `/apps/${config.appId}/builds?limit=10`
    )
    build = pickBuild(builds, requestedAt)
    const outcome = build ? buildOutcome(build.status) : "pending"
    if (outcome === "failed") {
      console.error(
        `[smoke] FAILED build ${build!.id}: ${build!.errorMessage ?? build!.status}`
      )
      return 1
    }
    if (outcome === "succeeded") break
    await Bun.sleep(5_000)
  }
  if (!build || buildOutcome(build.status) !== "succeeded") {
    console.error(`[smoke] FAILED: no successful build within ${timeoutMs} ms`)
    return 1
  }

  const { app } = await api<{ app: { publicUrl?: string } }>(
    config,
    "GET",
    `/apps/${config.appId}`
  )
  if (!app.publicUrl) {
    console.error("[smoke] FAILED: the smoke app has no public URL")
    return 1
  }
  const page = await fetch(app.publicUrl, { redirect: "manual" })
  const body = await page.text()
  if (page.status !== 200 || !body.startsWith("ploydok-smoke ")) {
    console.error(
      `[smoke] FAILED: ${app.publicUrl} answered HTTP ${page.status}`
    )
    return 1
  }
  console.log(`[smoke] OK: build ${build.id} serves ${app.publicUrl}`)
  return 0
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(
        `[smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`
      )
      process.exit(1)
    }
  )
}
