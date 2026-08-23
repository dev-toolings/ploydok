// SPDX-License-Identifier: AGPL-3.0-only
import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import { createRedis } from "@ploydok/db"
import { env } from "../env"
import { acquireGate } from "./build-cleanup-gate"

const dockerCleanupGate = createRedis(env.REDIS_URL)

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_HEARTBEAT_MS = 10_000

export class DeployLeaseLostError extends Error {
  constructor(message = "deployment lease lost") {
    super(message)
    this.name = "DeployLeaseLostError"
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

export async function withAppDeployLease<T>(
  db: Db,
  appId: string,
  buildId: string,
  task: () => Promise<T>,
  opts: { leaseMs?: number; heartbeatMs?: number; token?: string } = {}
): Promise<T> {
  // Cleanup takes this gate before its build snapshot. A deployment cannot
  // enter the lifecycle while that destructive cache/image sweep owns it.
  const gate = await acquireGate(dockerCleanupGate, "reader")
  if (!gate) throw new DeployLeaseLostError("Docker cleanup owns the build lifecycle gate")
  try {
    const token = opts.token ?? crypto.randomUUID()
    const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS
    const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    if (!(await acquire(db, appId, buildId, token, leaseMs))) {
      throw new DeployLeaseLostError(
        "another worker owns the app deployment lease"
      )
    }

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
    await gate.release()
    throw error
  }
}
