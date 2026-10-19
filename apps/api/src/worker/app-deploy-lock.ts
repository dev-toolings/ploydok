// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import { createRedis } from "@ploydok/db"
import { env } from "../env"
import { acquireGate, type GateRedis } from "./build-cleanup-gate"

const dockerCleanupGate = createRedis(env.REDIS_URL)

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 10_000

export class DeployLeaseLostError extends Error {
  constructor(message = "deployment lease lost") {
    super(message)
    this.name = "DeployLeaseLostError"
  }
}

export class DeployDeferredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeployDeferredError"
  }
}

export class DeployCancelledError extends Error {
  constructor(message = "deployment cancelled") {
    super(message)
    this.name = "DeployCancelledError"
  }
}

type LeaseContext = {
  db: Db
  appId: string
  buildId: string
  token: string
  leaseMs: number
  signal: AbortSignal
}

const leaseContext = new AsyncLocalStorage<LeaseContext>()

function rowsOf<T>(result: unknown): T[] {
  return result as T[]
}

async function acquire(
  db: Db,
  appId: string,
  buildId: string,
  token: string,
  leaseMs: number
): Promise<boolean> {
  const rows = rowsOf<{ lease_token: string }>(
    await db.execute(sql`
      INSERT INTO app_deploy_leases
        (app_id, build_id, lease_token, heartbeat_at, lease_until)
      VALUES
        (${appId}, ${buildId}, ${token}, now(), now() + (${leaseMs} * interval '1 millisecond'))
      ON CONFLICT (app_id) DO UPDATE SET
        build_id = EXCLUDED.build_id,
        lease_token = EXCLUDED.lease_token,
        heartbeat_at = now(),
        lease_until = EXCLUDED.lease_until,
        created_at = now()
      WHERE app_deploy_leases.lease_until <= now()
      RETURNING lease_token
    `)
  )
  return rows[0]?.lease_token === token
}

/**
 * Atomic ownership/cancellation fence. Every externally visible deployment
 * side effect calls this immediately before acting.
 */
export async function fenceDeploySideEffect(): Promise<void> {
  const ctx = leaseContext.getStore()
  if (!ctx) return
  if (ctx.signal.aborted) {
    throw ctx.signal.reason instanceof Error
      ? ctx.signal.reason
      : new DeployLeaseLostError()
  }
  const rows = rowsOf<{ lease_token: string; cancelled: boolean }>(
    await ctx.db.execute(sql`
      UPDATE app_deploy_leases AS lease
      SET heartbeat_at = now(),
          lease_until = now() + (${ctx.leaseMs} * interval '1 millisecond')
      FROM builds AS build
      WHERE lease.app_id = ${ctx.appId}
        AND lease.build_id = ${ctx.buildId}
        AND lease.lease_token = ${ctx.token}
        AND lease.lease_until > now()
        AND build.id = lease.build_id
      RETURNING lease.lease_token,
        (build.cancel_requested_at IS NOT NULL OR build.status = 'cancelled') AS cancelled
    `)
  )
  const row = rows[0]
  if (!row) throw new DeployLeaseLostError()
  if (row.cancelled) throw new DeployCancelledError()
}

export function currentDeployAbortSignal(): AbortSignal | undefined {
  return leaseContext.getStore()?.signal
}

export function currentDeployLease():
  { appId: string; buildId: string; token: string } | undefined {
  const ctx = leaseContext.getStore()
  return ctx
    ? { appId: ctx.appId, buildId: ctx.buildId, token: ctx.token }
    : undefined
}

/** SQL ownership predicate for app/build writes that must be stale-safe. */
export function currentDeployLeaseCondition() {
  const lease = currentDeployLease()
  if (!lease) return undefined
  return sql`EXISTS (
    SELECT 1 FROM app_deploy_leases deploy_lease
    WHERE deploy_lease.app_id = ${lease.appId}
      AND deploy_lease.build_id = ${lease.buildId}
      AND deploy_lease.lease_token = ${lease.token}
      AND deploy_lease.lease_until > now()
  )`
}

/**
 * Reconciliation fence that deliberately ignores cancellation intent but
 * still requires the exact, unexpired token. It prevents a stale worker from
 * undoing resources already adopted by a successor.
 */
export async function currentDeployLeaseIsOwner(): Promise<boolean> {
  const ctx = leaseContext.getStore()
  if (!ctx) return true
  const rows = rowsOf<{ owned: boolean }>(
    await ctx.db.execute(sql`
      UPDATE app_deploy_leases
      SET heartbeat_at = now(),
          lease_until = now() + (${ctx.leaseMs} * interval '1 millisecond')
      WHERE app_id = ${ctx.appId}
        AND build_id = ${ctx.buildId}
        AND lease_token = ${ctx.token}
        AND lease_until > now()
      RETURNING true AS owned
    `)
  )
  return rows[0]?.owned === true
}

export async function runOwnedDeployReconciliation(
  action: () => Promise<void>
): Promise<boolean> {
  if (!(await currentDeployLeaseIsOwner())) return false
  await action()
  return true
}

export type DeployLeaseOptions = {
  leaseMs?: number
  heartbeatMs?: number
  token?: string
  gateRedis?: GateRedis
  retryFailed?: boolean
  // "deploy" runs a queued build and may coalesce the waiting queue.
  // "routing" only fences a build that already serves traffic (rollback,
  // route switch, Caddy reconciliation). Every caller must choose.
  purpose: "deploy" | "routing"
}

/**
 * Fence a routing operation on the build that already serves the app.
 * Returns null when the lease cannot be taken right now: another deployment
 * owns the app, cleanup holds the gate, the lease was lost mid-task, or the
 * build is no longer successful. Callers map null to their conflict path.
 */
export async function withRoutingDeployLease<T>(
  db: Db,
  appId: string,
  buildId: string,
  task: () => Promise<T>
): Promise<T | null> {
  try {
    return await withAppDeployLease(db, appId, buildId, task, { purpose: "routing" })
  } catch (error) {
    if (
      error instanceof DeployLeaseLostError ||
      error instanceof DeployDeferredError ||
      error instanceof DeployCancelledError
    ) {
      return null
    }
    throw error
  }
}

export async function withAppDeployLease<T>(
  db: Db,
  appId: string,
  buildId: string,
  task: () => Promise<T>,
  opts: DeployLeaseOptions
): Promise<T> {
  // Cleanup takes this gate before its destructive snapshot. No deployment
  // lifecycle side effects may start until both the gate and app lease exist.
  const gate = await acquireGate(opts.gateRedis ?? dockerCleanupGate, "reader")
  try {
    const token = opts.token ?? crypto.randomUUID()
    const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS
    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    const entry = await db.transaction(async (tx) => {
      // Serialize selection and lease acquisition across API processes. A newer
      // request can supersede only builds that have not entered the lifecycle.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${appId}, 0))`)
      const [current] = rowsOf<{ status: string; error_message: string | null }>(
        await tx.execute(sql`SELECT status, error_message FROM builds
          WHERE id = ${buildId} AND app_id = ${appId}`)
      )
      // Routing operations lock an already deployed build without changing the queue.
      if (opts.purpose === "routing") {
        if (!current || !["succeeded", "succeeded_with_warning"].includes(current.status)) {
          return { kind: "cancelled", reason: "The deployed build is no longer successful" }
        }
        const acquired = gate && await acquire(tx as unknown as Db, appId, buildId, token, leaseMs)
        return acquired
          ? { kind: "acquired", reason: "" }
          : { kind: "deferred", reason: "Routing is waiting for the active deployment or Docker cleanup" }
      }
      if (!current || !["pending", "failed", "running"].includes(current.status)) {
        return { kind: "cancelled", reason: current?.error_message ?? "Deployment is no longer queued" }
      }
      if (current.status === "failed") {
        if (!opts.retryFailed) return { kind: "cancelled", reason: current.error_message ?? "Deployment already failed" }
        await tx.execute(sql`UPDATE builds SET status = 'pending', finished_at = NULL
          WHERE id = ${buildId} AND status = 'failed'`)
        current.status = "pending"
      }
      const [newest] = rowsOf<{ id: string }>(await tx.execute(sql`
        SELECT waiting.id FROM builds waiting
        WHERE waiting.app_id = ${appId} AND waiting.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM app_deploy_leases lease
            WHERE lease.build_id = waiting.id AND lease.lease_until > now()
          )
        ORDER BY waiting.queued_at DESC, waiting.created_at DESC, waiting.id DESC
        LIMIT 1
      `))
      if (newest) {
        await tx.execute(sql`
          UPDATE builds SET status = 'cancelled', finished_at = now(),
            error_message = ${`superseded by a newer deploy request ${newest.id}`}
          WHERE app_id = ${appId} AND status = 'pending' AND id <> ${newest.id}
            AND (builds.queued_at, builds.created_at, builds.id) < (
              SELECT newer.queued_at, newer.created_at, newer.id
              FROM builds newer WHERE newer.id = ${newest.id}
            )
            AND NOT EXISTS (
              SELECT 1 FROM app_deploy_leases lease
              WHERE lease.build_id = builds.id AND lease.lease_until > now()
            )
        `)
        if (current.status === "pending" && newest.id !== buildId) {
          // An active lease can still own a pending row before the handler's
          // claim. That duplicate delivery must defer instead of cancelling it.
          const [owned] = rowsOf<{ owned: boolean }>(await tx.execute(sql`
            SELECT true AS owned FROM app_deploy_leases
            WHERE build_id = ${buildId} AND lease_until > now()
          `))
          if (!owned) return { kind: "cancelled", reason: `superseded by a newer deploy request ${newest.id}` }
        }
      }
      const acquired = gate && await acquire(tx as unknown as Db, appId, buildId, token, leaseMs)
      if (!acquired) {
        const reason = gate
          ? "Deployment queued: waiting for the active app deployment to finish"
          : "Deployment queued: waiting for Docker cleanup to finish"
        await tx.execute(sql`UPDATE builds SET error_message = ${reason}
          WHERE id = ${buildId} AND status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM app_deploy_leases lease
              WHERE lease.build_id = builds.id AND lease.lease_until > now()
            )`)
        return { kind: "deferred", reason }
      }
      await tx.execute(sql`UPDATE builds SET error_message = NULL
        WHERE id = ${buildId} AND error_message LIKE 'Deployment queued:%'`)
      return { kind: "acquired", reason: "" }
    })
    // Throw only after committing coalescing and the durable waiting reason.
    if (entry.kind === "cancelled") throw new DeployCancelledError(entry.reason)
    if (entry.kind === "deferred" || !gate) throw new DeployDeferredError(entry.reason)

  const controller = new AbortController()
  const ctx: LeaseContext = {
    db,
    appId,
    buildId,
    token,
    leaseMs,
    signal: controller.signal,
  }
  let heartbeatRunning = false
  const heartbeat = setInterval(() => {
    if (heartbeatRunning || controller.signal.aborted) return
    heartbeatRunning = true
    leaseContext
      .run(ctx, async () => {
        if (!(await gate.renew())) throw new DeployLeaseLostError("build/cleanup gate lease lost")
        await fenceDeploySideEffect()
      })
      .catch((error) => {
        controller.abort(error)
      })
      .finally(() => {
        heartbeatRunning = false
      })
  }, heartbeatMs)

  try {
    return await leaseContext.run(ctx, async () => {
      await fenceDeploySideEffect()
      return task()
    })
  } finally {
    clearInterval(heartbeat)
    await db.execute(sql`
      DELETE FROM app_deploy_leases
      WHERE app_id = ${appId} AND lease_token = ${token}
    `)
    await gate.release()
  }
  } catch (error) {
    await gate?.release()
    throw error
  }
}
