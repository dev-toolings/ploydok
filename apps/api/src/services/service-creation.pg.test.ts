// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, mock } from "bun:test"
import {
  createDb,
  services,
  resource_creation_sagas,
  queue_outbox_events,
  type Db,
} from "@ploydok/db"
import { eq, sql } from "drizzle-orm"

// A failed Redis publish must leave the database intention recoverable.
mock.module("../worker/queues", () => ({
  serviceInstallQueue: {
    name: "service.install",
    add: async () => {
      throw new Error("Redis unavailable")
    },
  },
}))
mock.module("./projects.js", () => ({
  ensureProjectSwarmNetwork: async () => "ploydok-swarm-fixture",
}))
mock.module("../caddy/attachment.js", () => ({
  ensureCaddyOnProjectNetwork: async () => {},
}))
const { installFromTemplate, resumeServiceCreation } =
  await import("./marketplace-orchestrator")
import type { OrchestratorDeps } from "./marketplace-orchestrator"

type Point = "persist" | "create" | "route" | "complete" | null
const input = {
  projectId: "fixture-project",
  templateId: "fixture",
  templateVersion: "1",
  name: "Fixture",
  compose:
    "services:\n  first:\n    image: alpine:3.20\n    ports: ['8080:80']\n    environment:\n      DOMAIN: ${domain}\n  second:\n    image: alpine:3.20\n    depends_on: [first]\n",
}

async function isolated(run: (db: Db) => Promise<void>) {
  const db = createDb(process.env.DATABASE_URL!)
  try {
    await db.transaction(async (tx) => {
      for (const table of [
        "projects",
        "memberships",
        "services",
        "resource_creation_sagas",
        "queue_outbox_events",
      ]) {
        await tx.execute(
          sql.raw(
            `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`
          )
        )
      }
      await tx.execute(
        sql`INSERT INTO pg_temp.projects (id, owner_id, name, slug, created_at) VALUES ('fixture-project', 'fixture-user', 'Fixture', 'fixture', now())`
      )
      await tx.execute(
        sql`INSERT INTO pg_temp.memberships (id, org_id, user_id, role, accepted_at) VALUES ('fixture-member', 'fixture-project', 'fixture-user', 'owner', now())`
      )
      await run(tx as unknown as Db)
    })
  } finally {
    await db.$client.end()
  }
}

function grpcError(code: number, details: string) {
  return Object.assign(new Error(details), { code, details, metadata: {} })
}

function runtime(point: Point = null) {
  let pending = point
  const swarmServices = new Map<string, Record<string, string>>()
  let creates = 0
  let transactions = 0
  const fail = (at: Point) => {
    if (pending === at) {
      pending = null
      throw new Error(`interrupted at ${at}`)
    }
  }
  const swarm = {
    swarmEnsureSingleNode: async () => ({}),
    serviceCreate: async (req: { spec: Record<string, unknown> }) => {
      const name = String(req.spec["name"])
      if (swarmServices.has(name)) throw grpcError(6, `${name} already exists`)
      creates++
      swarmServices.set(name, req.spec["labels"] as Record<string, string>)
      // The second response is lost after Docker performed the mutation.
      if (creates === 2) fail("create")
      return { serviceId: name }
    },
    serviceRemove: mock(async (req: { serviceName: string }) => {
      if (!swarmServices.delete(req.serviceName))
        throw grpcError(5, `service ${req.serviceName} not found`)
      return {}
    }),
  }
  const agent = {} as OrchestratorDeps["agent"]
  const caddy = {
    upsertRoute: async () => {
      fail("route")
    },
    removeRoute: async () => {},
  }
  const wrap = (db: Db) =>
    new Proxy(db, {
      get(target, prop) {
        if (prop === "transaction")
          return (callback: (tx: unknown) => Promise<unknown>) =>
            target.transaction(async (tx) => {
              transactions++
              const result = await callback(tx)
              if (transactions === 1) fail("persist")
              if (transactions === 2) fail("complete")
              return result
            })
        const value = Reflect.get(target, prop)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  return {
    agent,
    swarm,
    caddy,
    swarmServices,
    wrap,
    get creates() {
      return creates
    },
  }
}

test.skipIf(!process.env.DATABASE_URL)(
  "service, saga and reference-only outbox survive a Redis publishing failure",
  async () => {
    await isolated(async (db) => {
      const r = runtime()
      const row = await installFromTemplate(
        { db, agent: r.agent, swarm: r.swarm, caddy: r.caddy },
        "fixture-user",
        input
      )
      const [saga] = await db.select().from(resource_creation_sagas)
      const [intent] = await db.select().from(queue_outbox_events)
      expect(row.status).toBe("pending")
      expect(saga?.resource_type).toBe("service")
      expect(saga?.requested_by_user_id).toBe("fixture-user")
      expect(intent?.payload).toEqual({ serviceId: row.id })
      expect(intent?.dispatched_at).toBeNull()
      expect(r.creates).toBe(0)
    })
  }
)

test
  .skipIf(!process.env.DATABASE_URL)
  .each(["persist", "create", "route", "complete"] as const)(
  "resumes an interruption at %s without duplicating Swarm services",
  async (point) => {
    await isolated(async (db) => {
      const initial = runtime()
      const row = await installFromTemplate(
        { db, agent: initial.agent, swarm: initial.swarm, caddy: initial.caddy },
        "fixture-user",
        input
      )
      const r = runtime(point)
      const deps = { agent: r.agent, swarm: r.swarm, caddy: r.caddy }
      await expect(
        resumeServiceCreation({ db: r.wrap(db), ...deps }, row.id)
      ).rejects.toThrow(`interrupted at ${point}`)
      const [partial] = await db.select().from(services)
      if (point !== "persist")
        expect(partial?.swarm_service_names).toHaveLength(2)
      await db
        .update(resource_creation_sagas)
        .set({ next_retry_at: new Date(0) })
      await resumeServiceCreation({ db, ...deps }, row.id)
      const [finished] = await db.select().from(services)
      const [saga] = await db.select().from(resource_creation_sagas)
      expect(finished?.status).toBe("running")
      expect(finished?.swarm_service_names).toHaveLength(2)
      expect(saga?.state).toBe("complete")
      expect(r.creates).toBe(2)
      expect([...r.swarmServices.keys()].sort()).toEqual(
        [...finished!.swarm_service_names!].sort()
      )
      for (const labels of r.swarmServices.values())
        expect(labels["ploydok.service_id"]).toBe(row.id)
    })
  }
)

test.skipIf(!process.env.DATABASE_URL)(
  "compensation removes planned Swarm services and retries an interrupted cleanup",
  async () => {
    await isolated(async (db) => {
      const r = runtime("create")
      const deps = { agent: r.agent, swarm: r.swarm, caddy: r.caddy }
      const row = await installFromTemplate({ db, ...deps }, "fixture-user", input)
      await expect(resumeServiceCreation({ db, ...deps }, row.id)).rejects.toThrow(
        "interrupted at create"
      )
      await db
        .update(resource_creation_sagas)
        .set({ state: "compensating", next_retry_at: new Date(0) })
      r.swarm.serviceRemove.mockRejectedValueOnce(new Error("agent unavailable"))
      await expect(resumeServiceCreation({ db, ...deps }, row.id)).rejects.toThrow(
        "agent unavailable"
      )
      const [pending] = await db.select().from(resource_creation_sagas)
      expect(pending?.state).toBe("compensating")
      await db
        .update(resource_creation_sagas)
        .set({ next_retry_at: new Date(0) })
      await resumeServiceCreation({ db, ...deps }, row.id)
      const [saga] = await db.select().from(resource_creation_sagas)
      const [service] = await db
        .select()
        .from(services)
        .where(eq(services.id, row.id))
      expect(saga?.state).toBe("compensated")
      expect(service?.swarm_service_names).toEqual([])
      expect(service?.status).toBe("failed")
      expect(r.swarmServices.size).toBe(0)
    })
  }
)
