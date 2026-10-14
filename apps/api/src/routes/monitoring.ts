// SPDX-License-Identifier: AGPL-3.0-only
//
// Monitoring routes — overview snapshot + active ping + diff loop → SSE.
//
// Endpoints:
//   GET  /monitoring/overview       — snapshot courant (MonitoringOverview)
//   POST /monitoring/ping/:id       — HTTP ping actif, renvoie latency + ok
//
// Diff loop:
//   polls agent.listContainers() toutes les 5s
//   diff avec le snapshot précédent (par container.id)
//   n'émet sur eventBus (channel user:{userId}) QUE si container.status change
//   le userId est résolu via runtime ownership (app or database)

import { Hono } from "hono"
import { z } from "zod"
import { nanoid } from "nanoid"
import { eventBus } from "../worker/event-bus"
import { getSharedAgent } from "../debug/singletons"
import {
  ContainerSnapshotSchema,
  PLANS,
  type ContainerSnapshot,
  type ContainerKind,
  type ContainerStatus,
  type MonitoringOverview,
  type PlanName,
} from "@ploydok/shared"
import { apps, databases, projects, memberships } from "@ploydok/db"
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm"
import { resolveAppOwner } from "@ploydok/db/queries"
import { createDb } from "@ploydok/db"
import { env } from "../env"
import { childLogger } from "../logger"
import { AgentError } from "../agent/errors"
import type { AuthUser } from "../auth/middleware"
import type { Agent } from "../agent/wrapper"

const log = childLogger("monitoring")
const LIVE_APP_RUNTIME_STATUSES = new Set(["running", "starting", "unhealthy"])

// Erreur agent — payload stable pour /overview quand l'agent est injoignable.
function agentErrorPayload(err: unknown): { code: string; message: string } {
  if (err instanceof AgentError) {
    return {
      code: err.code === 14 ? "AGENT_UNAVAILABLE" : "AGENT_ERROR",
      message:
        err.code === 14
          ? "Agent Ploydok injoignable (démarre-le avec `make dev-agent`)"
          : err.message,
    }
  }
  return { code: "AGENT_ERROR", message: (err as Error).message ?? "unknown" }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const monitoringRouter = new Hono<{ Variables: { user?: AuthUser } }>()

// ---------------------------------------------------------------------------
// Helper — snapshot from agent
// ---------------------------------------------------------------------------

async function snapshotFromAgent(): Promise<MonitoringOverview> {
  const agent = getSharedAgent()
  const { containers: protoContainers } = await agent.listContainers({
    kindFilter: "",
  })

  const containers: ContainerSnapshot[] = []
  const now = Date.now()

  for (const c of protoContainers) {
    const raw = {
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status || "unknown",
      uptime_s: c.uptimeS,
      cpu_pct: c.cpuPct,
      mem_bytes: c.memBytes,
      mem_limit_bytes: c.memLimitBytes,
      restart_count: c.restartCount,
      kind: c.kind || undefined,
      app_id: c.appId || undefined,
      color: c.color || undefined,
      last_ping_ms: c.lastPingMs > 0 ? c.lastPingMs : undefined,
      last_ping_ok: c.lastPingMs > 0 ? c.lastPingOk : undefined,
      last_seen_ms: c.lastSeenMs > 0 ? c.lastSeenMs : now,
    }

    const parsed = ContainerSnapshotSchema.safeParse(raw)
    if (parsed.success) {
      containers.push(parsed.data)
    } else {
      log.warn(
        { containerId: c.id, issues: parsed.error.issues },
        "snapshot validation failed — skipping container"
      )
    }
  }

  return { containers, generated_at: now }
}

async function resolveContainerOwner(
  db: ReturnType<typeof createDb>,
  container: Pick<ContainerSnapshot, "kind" | "app_id">
): Promise<string | null> {
  if (!container.app_id) return null

  if (container.kind === "app" || container.kind === undefined) {
    return resolveAppOwner(db, container.app_id)
  }

  if (container.kind === "database") {
    const rows = await db
      .select({ owner_id: projects.owner_id })
      .from(databases)
      .innerJoin(projects, eq(databases.project_id, projects.id))
      .where(eq(databases.id, container.app_id))
      .limit(1)
    return rows[0]?.owner_id ?? null
  }

  return null
}

// ---------------------------------------------------------------------------
// GET /overview
// ---------------------------------------------------------------------------

monitoringRouter.get("/overview", async (c) => {
  const user = c.get("user") as AuthUser | undefined

  if (!user) {
    return c.json(
      {
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
      },
      401
    )
  }

  try {
    const overview = await snapshotFromAgent()
    const db = createDb(env.DATABASE_URL)
    // Keep only runtime containers owned by the authenticated user.
    const owned: typeof overview.containers = []
    for (const ct of overview.containers) {
      const ownerId = await resolveContainerOwner(db, ct)
      if (ownerId === user.id) owned.push(ct)
    }
    return c.json({ ...overview, containers: owned })
  } catch (err) {
    return c.json<MonitoringOverview>(
      {
        containers: [],
        generated_at: Date.now(),
        error: agentErrorPayload(err),
      },
      503
    )
  }
})

// ---------------------------------------------------------------------------
// GET /fleet/quotas — aggregate declared quota usage across the caller's apps.
//
// For each app we use the plan limits when defined (PLANS[plan]); for apps in
// `custom` plan we fall back to the explicit cpu_limit / mem_limit_bytes /
// pids_limit columns (null means "no enforcement", counted as 0).
// ---------------------------------------------------------------------------

interface FleetQuotasResponse {
  apps: number
  running: number
  cpu: { declared: number }
  mem: { declared_bytes: number }
  pids: { declared: number }
}

monitoringRouter.get("/fleet/quotas", async (c) => {
  const user = c.get("user") as AuthUser | undefined
  if (!user) {
    return c.json(
      {
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
      },
      401
    )
  }

  const db = createDb(env.DATABASE_URL)
  const rows = await db
    .select({
      status: apps.status,
      plan: apps.plan,
      cpu_limit: apps.cpu_limit,
      mem_limit_bytes: apps.mem_limit_bytes,
      pids_limit: apps.pids_limit,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, user.id),
        isNotNull(memberships.accepted_at)
      )
    )

  let cpuSum = 0
  let memSum = 0
  let pidsSum = 0
  let running = 0

  for (const r of rows) {
    if (r.status === "running") running += 1
    const plan = r.plan as PlanName
    const limits = PLANS[plan]
    if (limits) {
      cpuSum += limits.cpu
      memSum += limits.memMB * 1024 * 1024
      pidsSum += limits.pids
    } else {
      cpuSum += r.cpu_limit ?? 0
      memSum += r.mem_limit_bytes ?? 0
      pidsSum += r.pids_limit ?? 0
    }
  }

  const response: FleetQuotasResponse = {
    apps: rows.length,
    running,
    cpu: { declared: Math.round(cpuSum * 1000) / 1000 },
    mem: { declared_bytes: memSum },
    pids: { declared: pidsSum },
  }
  return c.json(response)
})

// ---------------------------------------------------------------------------
// POST /ping/:id
// ---------------------------------------------------------------------------

// Ports réservés à l'infra locale — interdits pour éviter le SSRF.
const RESERVED_PORTS = new Set([22, 5000, 2020, 8180, 8181, 8543])

const PingBodySchema = z.object({
  path: z.string().regex(/^\/[^\s?#]{0,255}$/),
  port: z.number().int().min(1024).max(65535),
  timeoutMs: z.number().int().positive().optional(),
})

monitoringRouter.post("/ping/:id", async (c) => {
  const user = c.get("user") as AuthUser | undefined

  if (!user) {
    return c.json(
      {
        error: { code: "UNAUTHENTICATED", message: "Authentication required" },
      },
      401
    )
  }

  const id = c.req.param("id")

  // Parse + validate body
  let bodyRaw: unknown
  try {
    bodyRaw = await c.req.json()
  } catch {
    return c.json(
      { error: { code: "INVALID_BODY", message: "Invalid JSON body" } },
      400
    )
  }

  const parsed = PingBodySchema.safeParse(bodyRaw)
  if (!parsed.success) {
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
          details: parsed.error.issues,
        },
      },
      400
    )
  }

  const { path, port, timeoutMs } = parsed.data

  if (RESERVED_PORTS.has(port)) {
    return c.json(
      {
        error: {
          code: "FORBIDDEN_PORT",
          message: "Port is reserved for internal infrastructure",
        },
      },
      400
    )
  }

  // Ownership check — resolve container via snapshot then verify tenant.
  const overview = await snapshotFromAgent()
  const container = overview.containers.find((ct) => ct.id === id)

  if (!container?.app_id || container.kind !== "app") {
    return c.json(
      {
        error: {
          code: "FORBIDDEN",
          message: "Ping is only available for app containers",
        },
      },
      403
    )
  }

  const db = createDb(env.DATABASE_URL)
  const ownerId = await resolveAppOwner(db, container.app_id)
  if (ownerId !== user.id) {
    return c.json(
      {
        error: { code: "FORBIDDEN", message: "You do not own this container" },
      },
      403
    )
  }

  const agent = getSharedAgent()
  const result = await agent.pingContainer({
    containerId: id,
    path,
    port,
    timeoutMs: timeoutMs ?? 2000,
  })

  return c.json({
    ok: result.ok,
    statusCode: result.statusCode,
    latencyMs: result.latencyMs,
    error: result.error,
  })
})

// ---------------------------------------------------------------------------
// Diff loop — exported for lifecycle management + testability
// ---------------------------------------------------------------------------

let prevById = new Map<string, ContainerStatus>()
let loopHandle: ReturnType<typeof setInterval> | null = null
let consecutiveFailures = 0

/**
 * Pure tick function — extracted for testability.
 * Takes the agent, a publish function, the prev-state map and an owner resolver.
 */
export async function monitoringTick(
  agent: Agent,
  publish: typeof eventBus.publish,
  prev: Map<string, ContainerStatus>,
  resolveOwner: (
    kind: ContainerKind | undefined,
    runtimeId: string
  ) => Promise<string | null>,
  syncAppRuntime?: (container: ContainerSnapshot) => Promise<void>
): Promise<void> {
  const now = Date.now()
  const { containers: protoContainers } = await agent.listContainers({
    kindFilter: "",
  })

  for (const c of protoContainers) {
    const raw = {
      id: c.id,
      name: c.name,
      image: c.image,
      status: c.status || "unknown",
      uptime_s: c.uptimeS,
      cpu_pct: c.cpuPct,
      mem_bytes: c.memBytes,
      mem_limit_bytes: c.memLimitBytes,
      restart_count: c.restartCount,
      kind: c.kind || undefined,
      app_id: c.appId || undefined,
      color: c.color || undefined,
      last_ping_ms: c.lastPingMs > 0 ? c.lastPingMs : undefined,
      last_ping_ok: c.lastPingMs > 0 ? c.lastPingOk : undefined,
      last_seen_ms: c.lastSeenMs > 0 ? c.lastSeenMs : now,
    }

    const parsed = ContainerSnapshotSchema.safeParse(raw)
    if (!parsed.success) continue

    const container = parsed.data
    const prevStatus = prev.get(container.id)
    const currentStatus = container.status

    // Emit on status change OR on first appearance with status "running" (catches blue-green swap).
    const shouldEmit =
      (prevStatus !== undefined && prevStatus !== currentStatus) ||
      (prevStatus === undefined && currentStatus === "running")

    if (container.kind === "app" && container.app_id && syncAppRuntime) {
      try {
        await syncAppRuntime(container)
      } catch (err) {
        log.warn(
          { appId: container.app_id, containerId: container.id, err },
          "app runtime status sync failed during monitoring tick"
        )
      }
    }

    if (
      shouldEmit &&
      container.app_id &&
      (container.kind === "app" || container.kind === "database")
    ) {
      try {
        const userId = await resolveOwner(container.kind, container.app_id)
        if (userId) {
          publish(`user:${userId}`, {
            id: nanoid(),
            type: "container.health",
            ...(container.kind === "app" ? { appId: container.app_id } : {}),
            message:
              prevStatus === undefined
                ? `Container ${container.name} appeared: ${currentStatus}`
                : `Container ${container.name} status changed: ${prevStatus} → ${currentStatus}`,
            t: now,
            data: { container, prev_status: prevStatus },
          })
        }
      } catch (err) {
        log.warn(
          { containerId: container.id, err },
          "resolveOwner failed during monitoring tick"
        )
      }
    }
    // Infra/agent containers: skip.

    prev.set(container.id, currentStatus)
  }
}

async function syncLiveAppRuntime(
  db: ReturnType<typeof createDb>,
  container: ContainerSnapshot
): Promise<void> {
  if (!container.app_id || container.kind !== "app") return
  if (!LIVE_APP_RUNTIME_STATUSES.has(container.status)) return

  await db
    .update(apps)
    .set({
      status: "running",
      container_id: container.name || container.id,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(apps.id, container.app_id),
        inArray(apps.status, ["running", "failed", "stopped", "restarting"]),
        or(
          ne(apps.status, "running"),
          isNull(apps.container_id),
          ne(apps.container_id, container.name || container.id)
        )
      )
    )
}

export function startMonitoringLoop(db: ReturnType<typeof createDb>): void {
  if (loopHandle !== null) return

  const agent = getSharedAgent()
  const resolveOwner = (kind: ContainerKind | undefined, runtimeId: string) =>
    resolveContainerOwner(db, { kind, app_id: runtimeId })

  loopHandle = setInterval(() => {
    monitoringTick(
      agent,
      eventBus.publish.bind(eventBus),
      prevById,
      resolveOwner,
      (container) => syncLiveAppRuntime(db, container)
    )
      .then(() => {
        if (consecutiveFailures > 0) {
          log.info(
            { afterFailures: consecutiveFailures },
            "monitoring tick recovered"
          )
          consecutiveFailures = 0
        }
      })
      .catch((err) => {
        consecutiveFailures += 1
        // Log niveau warn sur les 2 premiers échecs, puis debug pour éviter le spam.
        if (consecutiveFailures <= 2) {
          log.warn({ err, consecutiveFailures }, "monitoring tick error")
        } else {
          log.debug(
            { err, consecutiveFailures },
            "monitoring tick error (silenced)"
          )
        }
      })
  }, 5_000)

  log.info("monitoring loop started (interval=5s)")
}

export function stopMonitoringLoop(): void {
  if (loopHandle !== null) {
    clearInterval(loopHandle)
    loopHandle = null
    prevById = new Map()
    consecutiveFailures = 0
    log.info("monitoring loop stopped")
  }
}
