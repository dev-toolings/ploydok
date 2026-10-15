// SPDX-License-Identifier: AGPL-3.0-only
//
// Single-pass ingress reconcile: pulls the canonical state from Postgres
// (running apps + services + public DB proxies), pushes it into Caddy, and
// attaches Caddy to project networks via the agent.
//
// Used at boot (via reconcileIngressWithRetry, which loops on this) AND
// periodically by the caddy-reconcile cron (which calls it once every tick).
//
// The function is idempotent: when Caddy already has every expected route,
// reconcileCaddyRoutes returns synced=0 and the call is essentially a few
// GETs against Caddy's admin API. When Caddy lost state (e.g. someone ran
// `docker compose up -d --force-recreate caddy` without restarting the API),
// the missing routes are detected and re-pushed → self-heal.

import type { Db } from "@ploydok/db"
import type { Logger } from "pino"
import type { CaddyClient } from "../caddy/client.js"
import type { Agent } from "../agent"
import {
  fetchPublicDatabaseProxiesForCaddy,
  fetchRunningAppsForCaddy,
  fetchRunningServicesForCaddy,
  reconcileCaddyRoutes,
  reconcileDatabaseTcpProxies,
  reconcileServiceRoutes,
  type ReconcileResult,
} from "../caddy/reconciler.js"
import { reconcileCaddyAttachments } from "../caddy/attachment.js"

export interface IngressReconcilePassResult {
  appRoutes: ReconcileResult
  serviceRoutes: ReconcileResult
  databaseProxies: ReconcileResult
  attachments: { attached: number; skipped: number; failed: number }
  /** total non-zero `synced` across all categories — when > 0, we just self-healed drift */
  totalSynced: number
  /** total `failed` across all categories — when > 0, retry next tick */
  totalFailed: number
  /** all categories reached `bootstrapped: true` and no failures */
  ok: boolean
}

export async function reconcileIngressOnce(opts: {
  db: Db
  caddy: CaddyClient
  agent: Agent
  logger: Logger
}): Promise<IngressReconcilePassResult> {
  const { db, caddy, agent, logger } = opts

  const [apps, services, databases] = await Promise.all([
    fetchRunningAppsForCaddy(db),
    fetchRunningServicesForCaddy(db),
    fetchPublicDatabaseProxiesForCaddy(db),
  ])
  const [appRoutes, serviceRoutes, databaseProxies, attachments] =
    await Promise.all([
      reconcileCaddyRoutes({
        caddy,
        logger,
        apps,
        db,
        agent,
        enableDeployLease: true,
      }),
      reconcileServiceRoutes({ caddy, logger, services }),
      reconcileDatabaseTcpProxies({ caddy, logger, databases }),
      reconcileCaddyAttachments(agent, db),
    ])

  const totalSynced =
    appRoutes.synced + serviceRoutes.synced + databaseProxies.synced
  const totalFailed =
    appRoutes.failed +
    serviceRoutes.failed +
    databaseProxies.failed +
    attachments.failed
  const ok =
    appRoutes.bootstrapped &&
    serviceRoutes.bootstrapped &&
    databaseProxies.bootstrapped &&
    totalFailed === 0

  return {
    appRoutes,
    serviceRoutes,
    databaseProxies,
    attachments,
    totalSynced,
    totalFailed,
    ok,
  }
}
