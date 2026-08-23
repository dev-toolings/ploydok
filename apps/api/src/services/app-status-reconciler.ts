// SPDX-License-Identifier: AGPL-3.0-only
//
// App status reconciler — keeps `apps.status` in sync with the live container
// state reported by the agent. Called from `GET /apps` and `GET /apps/:id`
// before serializing, so the UI never lies about a container that has crashed
// since the last deploy.
//
// Only terminal statuses (`running` / `failed` / `stopped`) are reconciled.
// Transitional statuses (`building` / `restarting` / `pending` / `created`)
// are owned by the worker and left untouched.
//
import { eq } from "drizzle-orm"
import { apps } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import type { Agent } from "../agent"
import { childLogger } from "../logger"

const log = childLogger("apps.status-reconciler")

// Grace window after `apps.updated_at` during which a missing container is not
// flipped to `failed`. Covers the gap between deploy commit and the agent's
// next monitor poll cycle (~2s) plus inspect/stats latency.
const STALE_GRACE_MS = 60_000

type ReconcilableApp = {
  id: string
  status: string | null
  container_id: string | null
  updated_at: Date | null
  runtime_mode?: string | null
}

type ContainerLite = {
  id: string
  name: string
  appId: string
  status: string
  lastSeenMs: number
}

export type AppContainerIndex = {
  byContainerId: Map<string, ContainerLite>
  byContainerName: Map<string, ContainerLite>
  bestByAppId: Map<string, ContainerLite>
}

const STATUS_RANK: Record<string, number> = {
  running: 4,
  unhealthy: 3,
  starting: 2,
  stopped: 1,
  unknown: 0,
}

function rank(status: string): number {
  return STATUS_RANK[status] ?? 0
}

export async function loadAppContainerIndex(
  agent: Agent
): Promise<AppContainerIndex | null> {
  try {
    const { containers } = await agent.listContainers({ kindFilter: "app" })
    const byContainerId = new Map<string, ContainerLite>()
    const byContainerName = new Map<string, ContainerLite>()
    const bestByAppId = new Map<string, ContainerLite>()

    for (const c of containers) {
      const lite: ContainerLite = {
        id: c.id,
        name: c.name,
        appId: c.appId,
        status: c.status || "unknown",
        lastSeenMs: c.lastSeenMs > 0 ? c.lastSeenMs : 0,
      }
      byContainerId.set(c.id, lite)
      byContainerName.set(c.name, lite)
      if (lite.appId) {
        const prev = bestByAppId.get(lite.appId)
        if (
          !prev ||
          rank(lite.status) > rank(prev.status) ||
          (rank(lite.status) === rank(prev.status) &&
            lite.lastSeenMs > prev.lastSeenMs)
        ) {
          bestByAppId.set(lite.appId, lite)
        }
      }
    }

    return { byContainerId, byContainerName, bestByAppId }
  } catch (err) {
    log.warn({ err }, "failed to load container snapshots; skipping reconcile")
    return null
  }
}

export function deriveLiveStatus(
  app: ReconcilableApp,
  index: AppContainerIndex,
  now: number = Date.now()
): "running" | "failed" | null {
  // Only reconcile terminal states. Transitional states are worker-owned.
  if (
    app.status !== "running" &&
    app.status !== "stopped" &&
    app.status !== "failed"
  ) {
    return null
  }

  let snap: ContainerLite | undefined
  if (app.container_id) {
    snap =
      index.byContainerId.get(app.container_id) ??
      index.byContainerName.get(app.container_id)
  }
  if (!snap) {
    snap = index.bestByAppId.get(app.id)
  }

  if (!snap) {
    // No container seen — only mark `running` apps as failed once the deploy
    // grace window has elapsed (avoids racing the agent's poll cycle).
    if (app.status !== "running") return null
    const updatedAt = app.updated_at ? app.updated_at.getTime() : 0
    if (now - updatedAt < STALE_GRACE_MS) return null
    return "failed"
  }

  if (snap.status === "stopped" || snap.status === "unknown") {
    return app.status === "running" ? "failed" : null
  }

  // snap.status ∈ {running, starting, unhealthy} → container is alive.
  if (app.status === "stopped" || app.status === "failed") {
    return "running"
  }
  return null
}

async function persistStatus(
  db: Db,
  appId: string,
  next: "running" | "failed",
  prev: string | null
): Promise<void> {
  try {
    await db
      .update(apps)
      .set({ status: next, updated_at: new Date() })
      .where(eq(apps.id, appId))
    log.info({ appId, from: prev, to: next }, "reconciled app status")
  } catch (err) {
    log.warn({ err, appId }, "failed to persist reconciled app status")
  }
}

async function persistContainerId(
  db: Db,
  appId: string,
  next: string,
  prev: string | null
): Promise<void> {
  try {
    await db
      .update(apps)
      .set({ container_id: next, updated_at: new Date() })
      .where(eq(apps.id, appId))
    log.info({ appId, from: prev, to: next }, "reconciled apps.container_id")
  } catch (err) {
    log.warn({ err, appId }, "failed to persist reconciled container_id")
  }
}

export async function reconcileAppStatusFromIndex<T extends ReconcilableApp>(
  db: Db,
  app: T,
  index: AppContainerIndex
): Promise<T> {
  let mutated: T = app
  const live = resolveLiveContainer(app, index)
  if (
    app.runtime_mode !== "swarm" &&
    live &&
    live.name !== app.container_id &&
    live.id !== app.container_id
  ) {
    // Container was recreated (blue/green swap, restart, etc.) — refresh the
    // canonical reference so the UI strict match keeps working. Swarm apps keep
    // `swarm_service_name` as the source of truth and leave container_id null.
    await persistContainerId(db, app.id, live.name, app.container_id)
    mutated = { ...mutated, container_id: live.name }
  }

  const next = deriveLiveStatus(mutated, index)
  if (next && next !== mutated.status) {
    await persistStatus(db, mutated.id, next, mutated.status)
    mutated = { ...mutated, status: next }
  }
  return mutated
}

function resolveLiveContainer(
  app: ReconcilableApp,
  index: AppContainerIndex
): ContainerLite | null {
  if (app.container_id) {
    const direct =
      index.byContainerId.get(app.container_id) ??
      index.byContainerName.get(app.container_id)
    if (direct) return direct
  }
  return index.bestByAppId.get(app.id) ?? null
}

export async function reconcileAppStatus<T extends ReconcilableApp>(
  db: Db,
  agent: Agent,
  app: T
): Promise<T> {
  const index = await loadAppContainerIndex(agent)
  if (!index) return app
  return reconcileAppStatusFromIndex(db, app, index)
}

export async function reconcileAppStatusList<T extends ReconcilableApp>(
  db: Db,
  agent: Agent,
  rows: T[]
): Promise<T[]> {
  if (rows.length === 0) return rows
  const index = await loadAppContainerIndex(agent)
  if (!index) return rows
  return Promise.all(
    rows.map((row) => reconcileAppStatusFromIndex(db, row, index))
  )
}
