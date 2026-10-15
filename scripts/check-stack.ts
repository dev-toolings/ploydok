// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, stat } from "node:fs/promises"
import postgres from "postgres"

// `make check` — chaque contrôle est un appel réel : connexion TCP, requête
// HTTP, socket unix. Un `make install` qui retourne 0 ne prouve pas que la
// stack répond, et un container "running" ne prouve pas que le service dedans
// accepte des connexions.

const ENV_FILE = "apps/api/.env.local"
const COMPOSE_FILE = "infra/docker-compose.yml"
const JOURNAL_FILE = "packages/db/migrations/meta/_journal.json"
const AGENT_SOCKET = "/tmp/ploydok/agent.sock"
const CADDY_ADMIN_URL = "http://127.0.0.1:2020/config/"
const REGISTRY_URL = "http://127.0.0.1:5000/v2/"
const API_ORIGIN = "http://localhost:3335"
const DEFAULT_WEB_ORIGIN = "http://localhost:5173"

const REQUIRED_SERVICES = [
  "postgres",
  "redis",
  "caddy",
  "buildkitd",
  "registry",
  "agent",
]

const REQUIRED_ENV_KEYS = [
  "PLOYDOK_PG_PASSWORD",
  "PLOYDOK_REDIS_PASSWORD",
  "DATABASE_URL",
  "REDIS_URL",
  "MASTER_KEY",
  "SESSION_SECRET",
]

// apps/api/src/auth/setup-token.ts ignore silencieusement un
// PLOYDOK_SETUP_TOKEN plus court et retombe sur un token aléatoire de 30 min :
// la même borne doit être vérifiée ici, sinon l'URL affichée est fausse.
const MIN_SETUP_TOKEN_LENGTH = 16

const READY_TIMEOUT_MS = 30_000
const SOFT_TIMEOUT_MS = 5_000
const RETRY_DELAY_MS = 1_000
const HTTP_TIMEOUT_MS = 5_000

export type Level = "ok" | "warn" | "fail"

export interface Check {
  level: Level
  detail: string
}

export interface ComposeStatus {
  state: string
  health: string
}

// ---------------------------------------------------------------------------
// Helpers purs (testés dans check-stack.test.ts)
// ---------------------------------------------------------------------------

export function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator <= 0) continue
    entries.set(
      line.slice(0, separator),
      line.slice(separator + 1).replace(/^["']|["']$/g, "")
    )
  }
  return entries
}

// Même lecture que le schema Zod de apps/api/src/env.ts : absent ⇒ false.
export function setupTokenRequired(value: string | undefined): boolean {
  if (value === undefined) return false
  return /^(1|true|yes|on)$/i.test(value.trim())
}

export function checkSetupToken(
  required: boolean,
  value: string | undefined
): Check {
  if (!required) {
    return {
      level: "ok",
      detail: "PLOYDOK_SETUP_TOKEN_REQUIRED=0 — /setup ouvert, le premier visiteur crée l'admin",
    }
  }
  if (!value) {
    return {
      level: "fail",
      detail: `PLOYDOK_SETUP_TOKEN absent de ${ENV_FILE} — lance 'make secrets-init'`,
    }
  }
  if (value.length < MIN_SETUP_TOKEN_LENGTH) {
    return {
      level: "fail",
      detail: `PLOYDOK_SETUP_TOKEN fait ${value.length} caractères, minimum ${MIN_SETUP_TOKEN_LENGTH} — l'API l'ignorerait`,
    }
  }
  return { level: "ok", detail: "PLOYDOK_SETUP_TOKEN permanent, URL stable" }
}

export function parseComposePs(stdout: string): Map<string, ComposeStatus> {
  const statuses = new Map<string, ComposeStatus>()
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: { Service?: string; State?: string; Health?: string }
    try {
      row = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!row.Service) continue
    statuses.set(row.Service, {
      state: row.State ?? "",
      health: row.Health ?? "",
    })
  }
  return statuses
}

export function checkServices(
  statuses: Map<string, ComposeStatus>,
  required: Array<string> = REQUIRED_SERVICES
): Check {
  const down: Array<string> = []
  const crashed: Array<string> = []
  const starting: Array<string> = []

  for (const service of required) {
    const status = statuses.get(service)
    if (!status) {
      down.push(`${service} (absent)`)
      continue
    }
    if (status.state !== "running") {
      crashed.push(`${service} (${status.state})`)
      continue
    }
    if (status.health === "starting") starting.push(service)
    else if (status.health && status.health !== "healthy") {
      crashed.push(`${service} (${status.health})`)
    }
  }

  // Un container jamais créé et un container sorti en erreur n'ont pas le même
  // remède : le premier attend 'make infra-up', le second veut ses logs.
  if (crashed.length > 0) {
    const names = crashed.map((entry) => entry.split(" ")[0]).join(" ")
    return {
      level: "fail",
      detail: `${crashed.join(", ")} — docker compose -f ${COMPOSE_FILE} logs ${names}`,
    }
  }
  if (down.length > 0) {
    return {
      level: "fail",
      detail: `${down.join(", ")} — lance 'make infra-up'`,
    }
  }
  if (starting.length > 0) {
    return {
      level: "warn",
      detail: `healthcheck en cours : ${starting.join(", ")}`,
    }
  }
  return { level: "ok", detail: `${required.join(", ")} — running` }
}

// Quand l'API accorde des sessions de setup (hors prod), /setup nu suffit :
// elle dépose le token dans un cookie. La query string ne sert que si ce
// mécanisme est coupé, ou si l'API n'a pas pu être interrogée.
export function buildSetupUrl(
  webOrigin: string,
  required: boolean,
  token: string | undefined,
  grantAllowed: boolean
): string {
  if (!required || grantAllowed || !token) return `${webOrigin}/setup`
  return `${webOrigin}/setup?token=${token}`
}

export function summarize(checks: Array<Check>): {
  failed: number
  warned: number
} {
  return {
    failed: checks.filter((check) => check.level === "fail").length,
    warned: checks.filter((check) => check.level === "warn").length,
  }
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

const tty = process.stdout.isTTY === true
const dim = (text: string): string => (tty ? `\u001b[2m${text}\u001b[0m` : text)
const bold = (text: string): string =>
  tty ? `\u001b[1m${text}\u001b[0m` : text

const MARK: Record<Level, string> = {
  ok: tty ? "\u001b[32m✓\u001b[0m" : "✓",
  warn: tty ? "\u001b[33m!\u001b[0m" : "!",
  fail: tty ? "\u001b[31m✗\u001b[0m" : "✗",
}

const checks: Array<Check> = []

function report(label: string, check: Check): Check {
  checks.push(check)
  console.log(`  ${MARK[check.level]} ${label.padEnd(12)} ${check.detail}`)
  return check
}

function fatal(label: string, detail: string): never {
  report(label, { level: "fail", detail })
  console.log("")
  console.log(
    bold(
      "Stack incomplète — corrige le point ci-dessus, puis relance 'make check'."
    )
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Sondes
// ---------------------------------------------------------------------------

async function waitFor<T>(
  probe: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      return await probe()
    } catch (error) {
      lastError = error
      if (Date.now() >= deadline) break
      await Bun.sleep(RETRY_DELAY_MS)
    }
  }
  throw lastError
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function run(
  command: Array<string>
): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" })
  const stdout = await new Response(proc.stdout).text()
  return { code: await proc.exited, stdout }
}

async function httpOk(url: string): Promise<void> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  await response.arrayBuffer()
}

function maskUrl(url: string): string {
  return url.replace(/:\/\/([^:/@]+):[^@]*@/, "://$1:***@")
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("")
  console.log(bold("Ploydok — vérification de l'environnement de dev"))
  console.log("")

  if (!(await Bun.file(COMPOSE_FILE).exists())) {
    fatal(
      "repo",
      `${COMPOSE_FILE} introuvable — lance 'make check' à la racine du repo`
    )
  }

  const docker = await run(["docker", "info"])
  if (docker.code !== 0) {
    fatal("docker", "daemon injoignable — démarre Docker puis relance")
  }
  report("docker", { level: "ok", detail: "daemon joignable" })

  let envContent: string
  try {
    envContent = await readFile(ENV_FILE, "utf8")
  } catch {
    fatal("secrets", `${ENV_FILE} absent — lance 'make secrets-init'`)
  }

  const env = parseEnvFile(envContent)
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env.get(key))
  if (missing.length > 0) {
    fatal(
      "secrets",
      `${missing.join(", ")} manquant(s) dans ${ENV_FILE} — lance 'make secrets-init'`
    )
  }
  report("secrets", {
    level: "ok",
    detail: `${REQUIRED_ENV_KEYS.length}/${REQUIRED_ENV_KEYS.length} clés requises dans ${ENV_FILE}`,
  })

  const tokenRequired = setupTokenRequired(
    env.get("PLOYDOK_SETUP_TOKEN_REQUIRED")
  )
  const setupToken = env.get("PLOYDOK_SETUP_TOKEN")
  report("setup-token", checkSetupToken(tokenRequired, setupToken))

  const composeArgs = [
    "docker",
    "compose",
    "--env-file",
    ENV_FILE,
    "-f",
    COMPOSE_FILE,
  ]
  try {
    const services = await waitFor(async () => {
      // `-a` : un container sorti en erreur doit être rapporté comme "exited",
      // pas comme "absent" — les deux ne se debuggent pas pareil.
      const ps = await run([...composeArgs, "ps", "-a", "--format", "json"])
      const check = checkServices(parseComposePs(ps.stdout))
      if (check.level === "fail") throw new Error(check.detail)
      return check
    }, READY_TIMEOUT_MS)
    report("compose", services)
  } catch (error) {
    report("compose", { level: "fail", detail: describe(error) })
  }

  const databaseUrl = env.get("DATABASE_URL")!
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  })

  let dbReachable = false
  try {
    await waitFor(async () => {
      await sql`select 1`
    }, READY_TIMEOUT_MS)
    dbReachable = true
    report("postgres", {
      level: "ok",
      detail: `auth ok — ${maskUrl(databaseUrl)}`,
    })
  } catch (error) {
    report("postgres", {
      level: "fail",
      detail: `${describe(error)} — lance 'make db-ensure-auth'`,
    })
  }

  let userCount: number | null = null
  if (dbReachable) {
    const journal = JSON.parse(await readFile(JOURNAL_FILE, "utf8")) as {
      entries: Array<{ tag: string }>
    }
    const expected = journal.entries.length
    try {
      const rows = await sql<Array<{ count: number }>>`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `
      const applied = rows[0]?.count ?? 0
      report("migrations", {
        level: applied >= expected ? "ok" : "fail",
        detail:
          applied >= expected
            ? `${applied}/${expected} appliquées`
            : `${applied}/${expected} appliquées — lance 'make db-migrate'`,
      })
    } catch {
      report("migrations", {
        level: "fail",
        detail: `0/${expected} appliquées — lance 'make db-migrate'`,
      })
    }

    try {
      const rows = await sql<Array<{ count: number }>>`
        select count(*)::int as count from users
      `
      userCount = rows[0]?.count ?? 0
    } catch {
      userCount = null
    }
  }
  await sql.end({ timeout: 1 }).catch(() => {})

  try {
    await waitFor(async () => {
      const client = new Bun.RedisClient(env.get("REDIS_URL")!)
      try {
        const pong = await client.send("PING", [])
        if (pong !== "PONG") throw new Error(`réponse inattendue : ${pong}`)
      } finally {
        client.close()
      }
    }, READY_TIMEOUT_MS)
    report("redis", { level: "ok", detail: "PONG sur 127.0.0.1:6381" })
  } catch (error) {
    report("redis", { level: "fail", detail: describe(error) })
  }

  try {
    await waitFor(() => httpOk(CADDY_ADMIN_URL), READY_TIMEOUT_MS)
    report("caddy", { level: "ok", detail: `admin API — ${CADDY_ADMIN_URL}` })
  } catch (error) {
    report("caddy", { level: "fail", detail: describe(error) })
  }

  try {
    await waitFor(() => httpOk(REGISTRY_URL), READY_TIMEOUT_MS)
    report("registry", { level: "ok", detail: `v2 API — ${REGISTRY_URL}` })
  } catch (error) {
    report("registry", { level: "fail", detail: describe(error) })
  }

  // L'agent compile en release au premier boot (start_period: 120s côté compose).
  // Socket absent ≠ install cassée : on avertit au lieu de bloquer.
  try {
    await waitFor(async () => {
      const info = await stat(AGENT_SOCKET)
      if (!info.isSocket())
        throw new Error(`${AGENT_SOCKET} n'est pas un socket`)
    }, SOFT_TIMEOUT_MS)
    report("agent", { level: "ok", detail: `socket ${AGENT_SOCKET}` })
  } catch {
    report("agent", {
      level: "warn",
      detail: `${AGENT_SOCKET} absent — l'agent compile encore ? 'make agent-logs'`,
    })
  }

  interface ReadyResponse {
    components?: Record<string, { status?: string }>
  }
  interface InstanceState {
    bootstrapped: boolean
    setup_token_required: boolean
    setup_token_source: "env" | "generated" | null
    setup_session_grant_allowed: boolean
  }

  let instanceState: InstanceState | null = null
  try {
    const response = await fetch(`${API_ORIGIN}/health/ready`, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const body = (await response.json()) as ReadyResponse
    const components = Object.entries(body.components ?? {})
    const degraded = components.filter(([, value]) => value.status !== "ok")
    report("api", {
      level: degraded.length === 0 ? "ok" : "fail",
      detail:
        degraded.length === 0
          ? `/health/ready — ${components.map(([name]) => name).join(", ")} ok`
          : `/health/ready dégradé : ${degraded.map(([name, value]) => `${name}=${value.status}`).join(", ")}`,
    })

    instanceState = (await (
      await fetch(`${API_ORIGIN}/auth/instance-state`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      })
    ).json()) as InstanceState
  } catch {
    report("api", {
      level: "warn",
      detail: `${API_ORIGIN} injoignable — 'make dev' n'est pas démarré`,
    })
  }

  const webOrigin = env.get("WEB_ORIGIN") ?? DEFAULT_WEB_ORIGIN
  try {
    await httpOk(webOrigin)
    report("web", { level: "ok", detail: `${webOrigin} répond` })
  } catch {
    report("web", {
      level: "warn",
      detail: `${webOrigin} injoignable — 'make dev' n'est pas démarré`,
    })
  }

  // L'API lit PLOYDOK_SETUP_TOKEN une seule fois, au boot. Si elle tournait déjà
  // quand secrets-init a écrit la clé, elle sert encore un token aléatoire et
  // l'URL ci-dessous serait rejetée en 403.
  if (
    tokenRequired &&
    instanceState &&
    !instanceState.bootstrapped &&
    !instanceState.setup_session_grant_allowed &&
    instanceState.setup_token_source === "generated"
  ) {
    report("setup-token", {
      level: "warn",
      detail:
        "l'API tourne avec un token éphémère écrit avant PLOYDOK_SETUP_TOKEN — relance 'make dev'",
    })
  }

  const { failed, warned } = summarize(checks)

  console.log("")
  if (userCount === 0 || instanceState?.bootstrapped === false) {
    console.log(
      bold("Prochaine étape — aucun admin en base, ouvre le wizard :")
    )
    console.log(
      `  ${buildSetupUrl(
        webOrigin,
        tokenRequired,
        setupToken,
        instanceState?.setup_session_grant_allowed ?? false
      )}`
    )
  } else if (userCount !== null && userCount > 0) {
    console.log(bold(`Instance déjà bootstrappée (${userCount} compte(s)) :`))
    console.log(`  ${webOrigin}/login`)
  }

  console.log("")
  if (failed > 0) {
    console.log(
      bold(`${failed} contrôle(s) en échec, ${warned} avertissement(s).`)
    )
    process.exit(1)
  }
  console.log(
    warned > 0
      ? dim(`Tout est opérationnel (${warned} avertissement(s)).`)
      : dim("Tout est opérationnel.")
  )
}

if (import.meta.main) await main()
