// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { app } from "./app"
import { env } from "./env"
import { wsHandler } from "./routes/ws"
import { getSharedCaddy, getSharedAgent } from "./debug/singletons.js"
import { isAlreadyExists } from "./agent/index.js"
import { childLogger } from "./logger"
import { startWorker } from "./worker"
import { createDb, type Db } from "@ploydok/db"
import { reconcileIngressOnce } from "./services/ingress-reconcile.js"
import { bootstrapSetupToken } from "./auth/setup-token"
import { reconcileRuntimeAppsOnBoot } from "./services/app-runtime-reconciler.js"
import { reconcileSwarmProjectNetworks } from "./services/projects.js"
import { reconcileResourceCreations } from "./services/resource-creation-reconciler.js"
import { migrateDockerAppsToSwarmOnBoot } from "./services/swarm-migration.js"
import {
  assertNoCaseInsensitiveAppDomainDuplicates,
  backfillStorageDestinations,
} from "@ploydok/db"
import {
  backfillAppDomainMetadata,
  deriveDefaultAppDomainBase,
} from "./domains/app-domain.js"

const log = childLogger("boot")

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createApp() {
  return app
}

async function runMigrationsOnBoot(): Promise<void> {
  if (Bun.env["PLOYDOK_SKIP_MIGRATIONS"] === "1") {
    log.warn("PLOYDOK_SKIP_MIGRATIONS=1 — skipping boot migrations")
    return
  }
  const here = dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = join(
    here,
    "..",
    "..",
    "..",
    "packages",
    "db",
    "migrations"
  )
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} })
  try {
    await sql`SELECT pg_advisory_lock(hashtext('ploydok:drizzle-migrations'))`
    log.info({ migrationsFolder }, "applying drizzle migrations on boot")
    await assertNoCaseInsensitiveAppDomainDuplicates(sql)
    const migratedDb = drizzle(sql)
    await migrate(migratedDb, { migrationsFolder })
    await backfillStorageDestinations(migratedDb, env.MASTER_KEY)
    log.info("drizzle migrations applied")
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('ploydok:drizzle-migrations'))`.catch(
      () => undefined
    )
    await sql.end()
  }
}

async function bootInfra(db: Db): Promise<void> {
  const caddy = getSharedCaddy()
  const agent = getSharedAgent()

  await reconcileIngressWithRetry(db, caddy, agent)

  // Legacy flat network (pre-Phase-1.C). Kept so existing apps still resolve
  // until they are redeployed under per-project networks.
  try {
    await agent.networkCreate({
      name: "ploydok-public",
      driver: "bridge",
      attachable: false,
      labels: {},
    })
    log.info("réseau ploydok-public créé")
  } catch (err) {
    if (isAlreadyExists(err)) {
      log.info("réseau ploydok-public déjà existant")
    } else {
      log.warn({ err }, "networkCreate ploydok-public failed (non-fatal)")
    }
  }

  // Phase 1.C ingress network — Caddy + every app container attach to this.
  // Per-project private networks are created lazily by ensureProjectNetwork
  // at first deploy.
  try {
    await agent.networkCreate({
      name: "ploydok-ingress",
      driver: "bridge",
      attachable: false,
      labels: { "ploydok.kind": "ingress" },
    })
    log.info("réseau ploydok-ingress créé")
  } catch (err) {
    if (isAlreadyExists(err)) {
      log.info("réseau ploydok-ingress déjà existant")
    } else {
      log.warn({ err }, "networkCreate ploydok-ingress failed (non-fatal)")
    }
  }

  try {
    const result = await reconcileSwarmProjectNetworks(db, agent)
    log.info(result, "project swarm network reconcile complete")
  } catch (err) {
    log.warn({ err }, "project swarm network reconcile failed (non-fatal)")
  }

  try {
    const result = await reconcileRuntimeAppsOnBoot(db, agent)
    log.info(result, "runtime app reconcile complete")
  } catch (err) {
    log.warn({ err }, "runtime app reconcile failed (non-fatal)")
  }

  try {
    const result = await reconcileResourceCreations(db)
    log.info(result, "resource creation reconcile complete")
  } catch (err) {
    log.warn({ err }, "resource creation reconcile failed (non-fatal)")
  }

  try {
    const result = await migrateDockerAppsToSwarmOnBoot(db)
    log.info(result, "docker apps swarm migration complete")
    scheduleDockerAppsSwarmMigrationRetry(db, result.failed)
  } catch (err) {
    log.warn({ err }, "docker apps swarm migration failed (non-fatal)")
    scheduleDockerAppsSwarmMigrationRetry(db, 1)
  }
}

function scheduleDockerAppsSwarmMigrationRetry(db: Db, failed: number): void {
  if (failed <= 0) return
  const retryMs = Number(Bun.env["PLOYDOK_SWARM_MIGRATION_RETRY_MS"] ?? 60_000)
  const maxAttempts = Number(
    Bun.env["PLOYDOK_SWARM_MIGRATION_RETRY_ATTEMPTS"] ?? 120
  )
  let attempts = 0
  let running = false
  const timer = setInterval(() => {
    if (running) return
    attempts++
    running = true
    void (async () => {
      try {
        const result = await migrateDockerAppsToSwarmOnBoot(db)
        log.info(
          { ...result, attempt: attempts },
          "docker apps swarm migration retry complete"
        )
        if (result.failed === 0) {
          clearInterval(timer)
        } else if (attempts >= maxAttempts) {
          log.warn(
            { ...result, attempts },
            "docker apps swarm migration retry exhausted"
          )
          clearInterval(timer)
        }
      } catch (err) {
        log.warn(
          { err, attempt: attempts },
          "docker apps swarm migration retry failed"
        )
        if (attempts >= maxAttempts) {
          clearInterval(timer)
        }
      } finally {
        running = false
      }
    })()
  }, retryMs)
}

async function reconcileIngressWithRetry(
  db: Db,
  caddy: ReturnType<typeof getSharedCaddy>,
  agent: ReturnType<typeof getSharedAgent>
): Promise<void> {
  const attempts = Number(Bun.env["PLOYDOK_INGRESS_RECONCILE_ATTEMPTS"] ?? 30)
  const delayMs = Number(Bun.env["PLOYDOK_INGRESS_RECONCILE_DELAY_MS"] ?? 1000)

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await reconcileIngressOnce({
        db,
        caddy,
        agent,
        logger: log,
      })
      if (result.ok) {
        log.info({ ...result, attempt }, "ingress reconcile complete")
        return
      }
      log.warn({ ...result, attempt }, "ingress reconcile incomplete")
    } catch (err) {
      log.warn({ err, attempt }, "ingress reconcile failed")
    }

    if (attempt < attempts) {
      await sleep(delayMs)
    }
  }

  log.error({ attempts }, "ingress reconcile exhausted")
}

if (import.meta.main) {
  if (env.NODE_ENV !== "test") {
    try {
      await runMigrationsOnBoot()
    } catch (err) {
      log.error({ err }, "boot migrations failed — refusing to start")
      process.exit(1)
    }
  }

  const workerDb = createDb(env.DATABASE_URL)
  if (env.NODE_ENV !== "test") {
    const backfill = await backfillAppDomainMetadata(
      workerDb,
      deriveDefaultAppDomainBase({
        explicitBase: env.PLOYDOK_DOMAIN_BASE,
        publicHost: env.PLOYDOK_PUBLIC_HOST,
      })
    )
    if (backfill.appsUpdated > 0 || backfill.buildsUpdated > 0) {
      log.info(backfill, "app domain metadata backfill complete")
    }
  }

  // M3.2: pass the BunWebSocket handler so Bun can upgrade WS connections.
  // idleTimeout: 0 disables the 10 s default so long-lived SSE streams
  // (GET /events) don't get chunk-encoded-truncated before their first
  // heartbeat. Per-request sockets are still closed on client abort.
  const server = Bun.serve({
    port: env.PORT,
    fetch: (request, server) =>
      app.fetch(request, {
        remoteAddress: server.requestIP(request)?.address,
      } as never),
    websocket: wsHandler,
    idleTimeout: 0,
  })
  log.info(
    { port: env.PORT, marker: "ci-cd-loop-test-1" },
    `api listening on :${env.PORT}`
  )

  const worker = startWorker(workerDb)
  log.info("worker started (polling jobs every 2s)")

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("worker stopping...")
    await worker.stop()
    server.stop(true)
    process.exit(0)
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)

  // bootInfra est toujours exécuté (sauf en test) : le reconciler et
  // networkCreate sont idempotents et gèrent Caddy/agent absents en warn.
  if (env.NODE_ENV !== "test") {
    bootInfra(workerDb).catch((err) => {
      log.error({ err }, "erreur inattendue au boot")
    })
    bootstrapSetupToken(workerDb).catch((err) => {
      log.error({ err }, "setup-token bootstrap failed")
    })
  }
}
