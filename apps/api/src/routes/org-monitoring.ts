// SPDX-License-Identifier: AGPL-3.0-only
//
// Organization-scoped monitoring routes — filtered by org membership.
//
// Endpoints:
//   GET  /organizations/:orgSlug/monitoring/overview       — snapshot filtered to org's projects
//   GET  /organizations/:orgSlug/monitoring/fleet/quotas    — fleet quotas for org's apps
//   POST /organizations/:orgSlug/monitoring/ping/:id        — HTTP ping with org gate
//
// Gate: 401 if not authenticated, 404 if org not found or user not a member.
// Then filter containers by project membership (org_id → projects.id).

import { Hono } from "hono"
import { z } from "zod"
import { and, eq, isNotNull, inArray } from "drizzle-orm"
import { getSharedAgent } from "../debug/singletons"
import {
  ContainerSnapshotSchema,
  PLANS,
  type ContainerSnapshot,
  type MonitoringOverview,
  type PlanName,
} from "@ploydok/shared"
import { apps, databases, projects, memberships } from "@ploydok/db"
import { createDb } from "@ploydok/db"
import { env } from "../env"
import { childLogger } from "../logger"
import { AgentError } from "../agent/errors"
import type { AuthUser } from "../auth/middleware"
import { getOrganizationBySlugForUser } from "../services/organizations"

const log = childLogger("org-monitoring")

function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

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

/**
 * Resolve a container to its project ID (org_id).
 * Returns null if the container has no app_id, or if the app/database doesn't belong to a project.
 */
async function resolveContainerProjectId(
  db: ReturnType<typeof createDb>,
  container: Pick<ContainerSnapshot, "kind" | "app_id">
): Promise<string | null> {
  if (!container.app_id) return null

  if (container.kind === "app" || container.kind === undefined) {
    const rows = await db
      .select({ project_id: apps.project_id })
      .from(apps)
      .where(eq(apps.id, container.app_id))
      .limit(1)
    return rows[0]?.project_id ?? null
  }

  if (container.kind === "database") {
    const rows = await db
      .select({ project_id: databases.project_id })
      .from(databases)
      .where(eq(databases.id, container.app_id))
      .limit(1)
    return rows[0]?.project_id ?? null
  }

  return null
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOrgMonitoringRouter(
  db: ReturnType<typeof createDb>
): Hono {
  const router = new Hono()

  // ---------------------------------------------------------------------------
  // GET /:orgSlug/monitoring/overview
  // ---------------------------------------------------------------------------

  router.get("/:orgSlug/monitoring/overview", async (c) => {
    const user = getUser(c) as AuthUser | undefined

    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      )
    }

    const orgSlug = c.req.param("orgSlug")

    // Verify membership
    const org = await getOrganizationBySlugForUser(db, user.id, orgSlug)
    if (!org) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Organization not found" } },
        404
      )
    }

    try {
      const overview = await snapshotFromAgent()

      // Filter containers to those belonging to the org's projects.
      const owned: typeof overview.containers = []
      for (const ct of overview.containers) {
        const projectId = await resolveContainerProjectId(db, ct)
        if (projectId === org.id) {
          owned.push(ct)
        }
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
  // GET /:orgSlug/monitoring/fleet/quotas
  // ---------------------------------------------------------------------------

  interface FleetQuotasResponse {
    apps: number
    running: number
    cpu: { declared: number }
    mem: { declared_bytes: number }
    pids: { declared: number }
  }

  router.get("/:orgSlug/monitoring/fleet/quotas", async (c) => {
    const user = getUser(c) as AuthUser | undefined

    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      )
    }

    const orgSlug = c.req.param("orgSlug")

    // Verify membership
    const org = await getOrganizationBySlugForUser(db, user.id, orgSlug)
    if (!org) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Organization not found" } },
        404
      )
    }

    // Query all apps belonging to this org (direct membership, not via user).
    const rows = await db
      .select({
        status: apps.status,
        plan: apps.plan,
        cpu_limit: apps.cpu_limit,
        mem_limit_bytes: apps.mem_limit_bytes,
        pids_limit: apps.pids_limit,
      })
      .from(apps)
      .where(eq(apps.project_id, org.id))

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
  // POST /:orgSlug/monitoring/ping/:id
  // ---------------------------------------------------------------------------

  const RESERVED_PORTS = new Set([22, 5000, 2020, 8180, 8181, 8543])

  const PingBodySchema = z.object({
    path: z.string().regex(/^\/[^\s?#]{0,255}$/),
    port: z.number().int().min(1024).max(65535),
    timeoutMs: z.number().int().positive().optional(),
  })

  router.post("/:orgSlug/monitoring/ping/:id", async (c) => {
    const user = getUser(c) as AuthUser | undefined

    if (!user) {
      return c.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Authentication required",
          },
        },
        401
      )
    }

    const orgSlug = c.req.param("orgSlug")
    const id = c.req.param("id")

    // Verify membership
    const org = await getOrganizationBySlugForUser(db, user.id, orgSlug)
    if (!org) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Organization not found" } },
        404
      )
    }

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

    // Ownership check — resolve container via snapshot, verify it belongs to the org.
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

    const projectId = await resolveContainerProjectId(db, container)
    if (projectId !== org.id) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "You do not have access to this container",
          },
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

  return router
}
