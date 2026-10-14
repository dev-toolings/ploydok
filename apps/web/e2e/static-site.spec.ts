// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Gate: `PLOYDOK_E2E_REAL=1`.
 *
 * Scope:
 * - validates the local static-site path end-to-end against already running
 *   web/api/caddy services
 * - does not validate Caddy module rebuild/release concerns; those remain
 *   operator-run checks documented in Sprint 7
 */
import { spawn } from "node:child_process"
import { createHmac } from "node:crypto"
import { cp, mkdir, readFile, rm, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { expect, test } from "@playwright/test"

const REAL_E2E = process.env["PLOYDOK_E2E_REAL"] === "1"
const WEB_URL = process.env["E2E_WEB_URL"] ?? "http://localhost:5173"
const CADDY_ADMIN_URL =
  process.env["CADDY_ADMIN_URL"] ?? "http://127.0.0.1:2020"
const CADDY_HTTP_PORT = 8181
const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url))
)
const API_ENV_PATH = path.join(REPO_ROOT, "apps/api/.env.local")
const FIXTURE_DIR = path.join(
  REPO_ROOT,
  "apps/web/e2e/fixtures/repos/static-vite"
)
const HOST_STATIC_ROOT = path.join(REPO_ROOT, "infra/caddy/data/static")
const CADDY_STATIC_ROOT = "/data/static"

type EnvMap = Partial<Record<string, string>>

async function loadApiEnv(): Promise<EnvMap> {
  const out: EnvMap = {}
  const raw = await readFile(API_ENV_PATH, "utf8")
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq)
    const value = trimmed.slice(eq + 1).replace(/^['"]|['"]$/g, "")
    out[key] = value
  }
  return out
}

function run(cmd: string, args: Array<string>, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "pipe" })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr}`))
    })
  })
}

function signAccessCookie(params: {
  secret: string
  userId: string
  email: string
  sessionId: string
}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "HS256" }
  const payload = {
    email: params.email,
    session_id: params.sessionId,
    sub: params.userId,
    iat: now,
    exp: now + 10 * 60,
    iss: "ploydok",
  }
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url")
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url"
  )
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = createHmac("sha256", params.secret)
    .update(signingInput)
    .digest("base64url")
  return `${signingInput}.${signature}`
}

async function upsertStaticRoute(params: {
  appId: string
  host: string
  root: string
}): Promise<void> {
  const routeId = `ploydok-${params.appId}`
  const route = {
    "@id": routeId,
    match: [{ host: [params.host] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [
              {
                file: {
                  root: params.root,
                  try_files: ["{http.request.uri.path}", "/index.html"],
                },
              },
            ],
            handle: [
              {
                handler: "rewrite",
                uri: "{http.matchers.file.relative}",
              },
            ],
          },
          {
            handle: [{ handler: "file_server", root: params.root }],
          },
        ],
      },
    ],
    terminal: true,
  }

  const patch = await fetch(`${CADDY_ADMIN_URL}/id/${routeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(route),
  })
  if (patch.ok) return
  if (patch.status !== 404) {
    throw new Error(`Caddy PATCH ${routeId} failed: ${patch.status}`)
  }

  const post = await fetch(
    `${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route),
    }
  )
  if (!post.ok) {
    throw new Error(`Caddy POST ${routeId} failed: ${post.status}`)
  }
}

async function removeStaticRoute(appId: string): Promise<void> {
  await fetch(`${CADDY_ADMIN_URL}/id/ploydok-${appId}`, { method: "DELETE" })
}

test.describe("static-site live", () => {
  test.describe.configure({ timeout: 90_000 })
  test.skip(
    !REAL_E2E,
    "requires PLOYDOK_E2E_REAL=1 + already running web/api/caddy"
  )

  let sql: postgres.Sql | null = null
  let appId = ""
  let appName = ""
  let appDomain = ""
  let appStaticDir = ""

  test.afterAll(async () => {
    if (appId) {
      await removeStaticRoute(appId).catch(() => undefined)
      if (sql) {
        await sql`delete from apps where id = ${appId}`.catch(() => undefined)
      }
    }
    if (appStaticDir) {
      await rm(appStaticDir, { recursive: true, force: true })
    }
    await rm(path.join(FIXTURE_DIR, "dist"), { recursive: true, force: true })
    await sql?.end()
  })

  test("publishes a built static fixture and shows it in /orgs/kevin/apps", async ({
    context,
    page,
  }) => {
    const env = await loadApiEnv()
    const databaseUrl = process.env["DATABASE_URL"] ?? env["DATABASE_URL"]
    const sessionSecret = process.env["SESSION_SECRET"] ?? env["SESSION_SECRET"]
    if (!databaseUrl) throw new Error("DATABASE_URL is required")
    if (!sessionSecret) throw new Error("SESSION_SECRET is required")

    sql = postgres(databaseUrl, { max: 1 })
    const projects = await sql<
      Array<{ id: string; owner_id: string; slug: string }>
    >`select id, owner_id, slug from projects where slug = 'kevin' limit 1`
    const project = projects.at(0)
    if (!project) throw new Error("organization kevin not found")

    const users = await sql<Array<{ id: string; email: string }>>`
      select id, email from users where id = ${project.owner_id} limit 1
    `
    const user = users.at(0)
    if (!user) throw new Error("owner user not found")

    const suffix = `${Date.now()}`
    appId = `static-live-${suffix}`
    appName = `static-vite-live-${suffix}`
    const slug = appName
    appDomain = `${slug}.localtest.me`
    const sha = `sha-${suffix}`
    appStaticDir = path.join(HOST_STATIC_ROOT, appId)

    await run("bun", ["run", "build"], FIXTURE_DIR)
    const distDir = path.join(FIXTURE_DIR, "dist")
    const targetDir = path.join(appStaticDir, sha)
    await mkdir(appStaticDir, { recursive: true })
    await cp(distDir, targetDir, { recursive: true })
    const currentLink = path.join(appStaticDir, "current")
    if (existsSync(currentLink)) await rm(currentLink, { force: true })
    await symlink(sha, currentLink)

    await sql`
      insert into apps (
        id,
        project_id,
        name,
        slug,
        status,
        git_provider,
        repo_full_name,
        branch,
        build_method,
        static_output_dir,
        static_spa_fallback,
        domain,
        created_at,
        updated_at
      ) values (
        ${appId},
        ${project.id},
        ${appName},
        ${slug},
        'serving',
        'github',
        'local/static-vite',
        'main',
        'static',
        'dist',
        true,
        ${appDomain},
        now(),
        now()
      )
    `
    await sql`
      insert into builds (
        id,
        app_id,
        status,
        build_method,
        commit_sha,
        started_at,
        finished_at,
        queued_at,
        claimed_at,
        created_at
      ) values (
        ${`build-${suffix}`},
        ${appId},
        'succeeded',
        'static',
        ${sha},
        now(),
        now(),
        now(),
        now(),
        now()
      )
    `

    await upsertStaticRoute({
      appId,
      host: appDomain,
      root: path.posix.join(CADDY_STATIC_ROOT, appId, "current"),
    })

    const liveRes = await fetch(`http://${appDomain}:${CADDY_HTTP_PORT}/`)
    expect(liveRes.status).toBe(200)
    expect(await liveRes.text()).toContain("static-fixture-ok")

    const fallbackRes = await fetch(
      `http://${appDomain}:${CADDY_HTTP_PORT}/client/side/route`
    )
    expect(fallbackRes.status).toBe(200)
    expect(await fallbackRes.text()).toContain("static-fixture-ok")

    const token = signAccessCookie({
      secret: sessionSecret,
      userId: user.id,
      email: user.email,
      sessionId: `e2e-static-${suffix}`,
    })
    await context.addCookies([
      {
        name: "ploydok_access",
        value: token,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ])

    await page.goto(`${WEB_URL}/orgs/kevin/apps`)
    await expect(page).toHaveURL(/\/orgs\/kevin\/apps/)
    await expect(page.getByText(appName, { exact: true })).toBeVisible()
    await expect(page.getByText(appDomain, { exact: true })).toBeVisible()
    await expect(page.getByText("Serving", { exact: true })).toBeVisible()
  })
})
