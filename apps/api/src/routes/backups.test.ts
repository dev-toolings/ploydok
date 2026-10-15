// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, mock, test } from "bun:test"
import { Hono } from "hono"
import {
  app_volumes,
  apps,
  backups,
  createDb,
  databases,
  memberships,
  projects,
  users,
  volume_backups,
  type Db,
} from "@ploydok/db"
import { eq } from "drizzle-orm"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { nanoid } from "nanoid"

const testPgUrl = Bun.env.PLOYDOK_TEST_PG_URL ?? Bun.env.DATABASE_URL

mock.module("@ploydok/db/queries", () => ({
  getAppForUser: mock(async () => ({
    id: "app-1",
    project_id: "proj-1",
    name: "demo-app",
  })),
  getMembership: mock(async () => null),
  listEventWebhooks: mock(async () => []),
  getEventWebhook: mock(async () => null),
  createEventWebhook: mock(async () => null),
  updateEventWebhook: mock(async () => null),
  deleteEventWebhook: mock(async () => false),
}))

mock.module("../auth/second-factor", () => ({
  requireTotpVerified: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
}))

mock.module("../logger", () => ({
  childLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

const { createBackupsRouter } = await import("./backups")

const fakeUser = {
  id: "user-1",
  email: "user@example.com",
  display_name: "User",
  session_id: "sess-1",
}

function makeChain(results: unknown[]) {
  const result = results.shift() ?? []
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(result),
    then: (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled),
  }
  return chain
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

function buildDb(selectResults: unknown[]) {
  const inserts: unknown[] = []
  const updates: unknown[] = []
  const deletes: unknown[] = []

  const db: Record<string, unknown> = {
    select: mock(() => makeChain(selectResults)),
    insert: mock((table: unknown) => ({
      values: mock(async (values: unknown) => {
        inserts.push({ table, values })
      }),
    })),
    update: mock((table: unknown) => ({
      set: mock((values: unknown) => ({
        where: mock(async () => {
          updates.push({ table, values })
        }),
      })),
    })),
    delete: mock((table: unknown) => ({
      where: mock(async () => {
        deletes.push(table)
      }),
    })),
  }

  return { db: db as unknown as Db, inserts, updates, deletes }
}

function wrapRouter(
  db: Db,
  user: typeof fakeUser & { token_scopes?: string[] } = fakeUser
) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", user)
    await next()
  })
  app.route("/", createBackupsRouter(db))
  return app
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe("volume backup routes", () => {
  it("lists app volume backups for an authorized member", async () => {
    const volumeRow = {
      id: "vol-1",
      app_id: "app-1",
      name: "data",
      mount_path: "/data",
      size_limit_bytes: null,
      created_at: new Date("2026-04-28T09:00:00.000Z"),
    }
    const backupRow = {
      id: "bkp-1",
      app_id: "app-1",
      volume_id: "vol-1",
      config_id: "cfg-1",
      destination_kind: "local",
      location: "/tmp/backup.tar",
      size_bytes: 42,
      age_encrypted: false,
      status: "succeeded",
      error: null,
      started_at: new Date("2026-04-28T10:00:00.000Z"),
      finished_at: new Date("2026-04-28T10:01:00.000Z"),
    }
    const { db } = buildDb([[volumeRow], [backupRow]])

    const res = await wrapRouter(db).fetch(
      req("GET", "/apps/app-1/volumes/vol-1/backups")
    )

    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      backups: Array<{
        id: string
        appId: string
        volumeId: string
        configId: string
        destinationKind: string
        location: string
        sizeBytes: number
        ageEncrypted: boolean
        status: string
        error: string | null
        startedAt: string
        finishedAt: string
      }>
    }
    expect(data.backups).toEqual([
      {
        id: "bkp-1",
        appId: "app-1",
        volumeId: "vol-1",
        configId: "cfg-1",
        destinationKind: "local",
        location: "/tmp/backup.tar",
        sizeBytes: 42,
        ageEncrypted: false,
        status: "succeeded",
        error: null,
        startedAt: "2026-04-28T10:00:00.000Z",
        finishedAt: "2026-04-28T10:01:00.000Z",
      },
    ])
  })

  it("creates a volume backup config with the same shape as database backups", async () => {
    const volumeRow = {
      id: "vol-1",
      app_id: "app-1",
      name: "data",
      mount_path: "/data",
      size_limit_bytes: null,
      created_at: new Date("2026-04-28T09:00:00.000Z"),
    }
    const createdRow = {
      id: "cfg-created",
      app_id: "app-1",
      volume_id: "vol-1",
      destination_kind: "local",
      s3_endpoint: null,
      s3_bucket: null,
      s3_prefix: null,
      s3_region: null,
      s3_credentials_secret_id: null,
      schedule_cron: "0 3 * * *",
      retention_days: 14,
      age_recipient_public_key: null,
      enabled: true,
      last_run_at: null,
      last_error: null,
      created_at: new Date("2026-04-28T10:00:00.000Z"),
    }
    const { db, inserts } = buildDb([[volumeRow], [], [createdRow]])

    const res = await wrapRouter(db).fetch(
      req("PUT", "/apps/app-1/volumes/vol-1/backup-config", {
        retentionDays: 14,
      })
    )

    expect(res.status).toBe(201)
    expect(inserts).toHaveLength(1)
    const payload = inserts[0] as {
      values: { app_id: string; volume_id: string; retention_days: number }
    }
    expect(payload.values.app_id).toBe("app-1")
    expect(payload.values.volume_id).toBe("vol-1")
    expect(payload.values.retention_days).toBe(14)

    const data = (await res.json()) as {
      config: { appId: string; volumeId: string; retentionDays: number }
    }
    expect(data.config.appId).toBe("app-1")
    expect(data.config.volumeId).toBe("vol-1")
    expect(data.config.retentionDays).toBe(14)
  })

  it("requires apps:write scope to mutate backup configuration with a PAT", async () => {
    const { db, inserts } = buildDb([])

    const res = await wrapRouter(db, {
      ...fakeUser,
      token_scopes: ["apps:read"],
    }).fetch(
      req("PUT", "/apps/app-1/volumes/vol-1/backup-config", {
        retentionDays: 14,
      })
    )

    expect(res.status).toBe(403)
    expect(inserts).toHaveLength(0)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("FORBIDDEN")
  })
})

describe("backup inventory route", () => {
  it("lists present database and volume artifacts with age and destination size", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ploydok-backup-inventory-"))
    tempDirs.push(dir)
    const databaseLocation = path.join(dir, "database.dump")
    const volumeLocation = path.join(dir, "volume.tar")
    const missingLocation = path.join(dir, "missing.dump")
    const artifactDate = new Date(Date.now() - 90_000)
    await writeFile(databaseLocation, "database backup")
    await writeFile(volumeLocation, "volume backup")
    await utimes(databaseLocation, artifactDate, artifactDate)
    await utimes(volumeLocation, artifactDate, artifactDate)

    const databaseStartedAt = new Date("2026-04-28T10:00:00.000Z")
    const volumeStartedAt = new Date("2026-04-28T09:00:00.000Z")
    const { db } = buildDb([
      [
        {
          backup: {
            id: "inventory-db-1",
            database_id: "db-1",
            config_id: "db-config-1",
            destination_kind: "local",
            location: databaseLocation,
            size_bytes: 1,
            age_encrypted: false,
            status: "succeeded",
            error: null,
            started_at: databaseStartedAt,
            finished_at: databaseStartedAt,
          },
          database: { id: "db-1", name: "primary" },
          config: null,
          project: { id: "project-1" },
        },
        {
          backup: {
            id: "inventory-missing",
            database_id: "db-1",
            config_id: "db-config-2",
            destination_kind: "local",
            location: missingLocation,
            size_bytes: 999,
            age_encrypted: false,
            status: "succeeded",
            error: null,
            started_at: databaseStartedAt,
            finished_at: databaseStartedAt,
          },
          database: { id: "db-1", name: "primary" },
          config: null,
          project: { id: "project-1" },
        },
      ],
      [
        {
          backup: {
            id: "inventory-volume-1",
            app_id: "app-1",
            volume_id: "vol-1",
            config_id: "volume-config-1",
            destination_kind: "local",
            location: volumeLocation,
            size_bytes: 1,
            age_encrypted: false,
            status: "succeeded",
            error: null,
            started_at: volumeStartedAt,
            finished_at: volumeStartedAt,
          },
          app: { id: "app-1", name: "demo-app" },
          volume: { id: "vol-1", name: "data" },
          config: null,
          project: { id: "project-1" },
        },
      ],
    ])

    const res = await wrapRouter(db).fetch(req("GET", "/backups/inventory"))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      backups: Array<{
        id: string
        kind: string
        present: boolean
        sizeBytes: number
        ageSeconds: number
        databaseId: string | null
        volumeId: string | null
      }>
    }
    expect(body.backups).toHaveLength(2)
    expect(body.backups.map((backup) => backup.id).sort()).toEqual([
      "inventory-db-1",
      "inventory-volume-1",
    ])
    expect(body.backups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "inventory-db-1",
          kind: "database",
          present: true,
          sizeBytes: Buffer.byteLength("database backup"),
          databaseId: "db-1",
          volumeId: null,
        }),
        expect.objectContaining({
          id: "inventory-volume-1",
          kind: "volume",
          present: true,
          sizeBytes: Buffer.byteLength("volume backup"),
          databaseId: null,
          volumeId: "vol-1",
        }),
      ])
    )
    expect(body.backups.every((backup) => backup.ageSeconds >= 60)).toBe(true)
  })

  it("filters inventory queries by the token scopes that were granted", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ploydok-backup-inventory-"))
    tempDirs.push(dir)
    const location = path.join(dir, "volume.tar")
    await writeFile(location, "volume backup")

    const { db } = buildDb([
      [
        {
          backup: {
            id: "inventory-volume-scoped",
            app_id: "app-1",
            volume_id: "vol-1",
            config_id: "volume-config-1",
            destination_kind: "local",
            location,
            status: "succeeded",
            started_at: new Date("2026-04-28T09:00:00.000Z"),
            finished_at: new Date("2026-04-28T09:00:00.000Z"),
          },
          app: { id: "app-1", name: "demo-app" },
          volume: { id: "vol-1", name: "data" },
          config: null,
          project: { id: "project-1" },
        },
      ],
    ])

    const res = await wrapRouter(db, {
      ...fakeUser,
      token_scopes: ["apps:read"],
    }).fetch(req("GET", "/backups/inventory"))

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      backups: Array<{ id: string; kind: string }>
    }
    expect(body.backups).toEqual([
      expect.objectContaining({
        id: "inventory-volume-scoped",
        kind: "volume",
      }),
    ])
  })

  test.skipIf(!testPgUrl)(
    "isolates inventory to projects where the current user is an accepted member",
    async () => {
      const db = createDb(testPgUrl!)
      const dir = await mkdtemp(
        path.join(tmpdir(), "ploydok-backup-inventory-")
      )
      tempDirs.push(dir)
      const suffix = nanoid(8)
      const now = new Date()
      const userA = `inventory-user-a-${suffix}`
      const userB = `inventory-user-b-${suffix}`
      const projectA = `inventory-project-a-${suffix}`
      const projectB = `inventory-project-b-${suffix}`
      const databaseA = `inventory-database-a-${suffix}`
      const databaseB = `inventory-database-b-${suffix}`
      const appA = `inventory-app-a-${suffix}`
      const appB = `inventory-app-b-${suffix}`
      const volumeA = `inventory-volume-a-${suffix}`
      const volumeB = `inventory-volume-b-${suffix}`

      const createArtifact = async (name: string, contents: string) => {
        const location = path.join(dir, name)
        await writeFile(location, contents)
        return location
      }

      try {
        await db.insert(users).values([
          {
            id: userA,
            email: `${userA}@example.test`,
            display_name: "Inventory user A",
            created_at: now,
            updated_at: now,
            recovery_token_hash: null,
            recovery_expires_at: null,
          },
          {
            id: userB,
            email: `${userB}@example.test`,
            display_name: "Inventory user B",
            created_at: now,
            updated_at: now,
            recovery_token_hash: null,
            recovery_expires_at: null,
          },
        ])
        await db.insert(projects).values([
          {
            id: projectA,
            owner_id: userA,
            name: "Inventory project A",
            slug: `inventory-a-${suffix}`,
            created_at: now,
          },
          {
            id: projectB,
            owner_id: userB,
            name: "Inventory project B",
            slug: `inventory-b-${suffix}`,
            created_at: now,
          },
        ])
        await db.insert(memberships).values({
          id: `inventory-membership-${suffix}`,
          org_id: projectA,
          user_id: userA,
          role: "owner",
          invited_at: now,
          accepted_at: now,
        })
        await db.insert(databases).values([
          {
            id: databaseA,
            project_id: projectA,
            kind: "postgres",
            version: "16",
            name: "Visible database",
            plan: "small",
            management_mode: "managed",
            volume_name: `db-volume-a-${suffix}`,
            container_id: `db-container-a-${suffix}`,
            status: "running",
            health_status: "healthy",
            created_at: now,
          },
          {
            id: databaseB,
            project_id: projectB,
            kind: "postgres",
            version: "16",
            name: "Hidden database",
            plan: "small",
            management_mode: "managed",
            volume_name: `db-volume-b-${suffix}`,
            container_id: `db-container-b-${suffix}`,
            status: "running",
            health_status: "healthy",
            created_at: now,
          },
        ])
        await db.insert(apps).values([
          {
            id: appA,
            project_id: projectA,
            name: "Visible app",
            slug: `inventory-app-a-${suffix}`,
            created_at: now,
            updated_at: now,
          },
          {
            id: appB,
            project_id: projectB,
            name: "Hidden app",
            slug: `inventory-app-b-${suffix}`,
            created_at: now,
            updated_at: now,
          },
        ])
        await db.insert(app_volumes).values([
          {
            id: volumeA,
            app_id: appA,
            name: "data",
            mount_path: "/data",
            created_at: now,
          },
          {
            id: volumeB,
            app_id: appB,
            name: "data",
            mount_path: "/data",
            created_at: now,
          },
        ])

        const [
          databaseLocationA,
          databaseLocationB,
          volumeLocationA,
          volumeLocationB,
        ] = await Promise.all([
          createArtifact("database-a.dump", "visible database"),
          createArtifact("database-b.dump", "hidden database"),
          createArtifact("volume-a.tar", "visible volume"),
          createArtifact("volume-b.tar", "hidden volume"),
        ])
        await db.insert(backups).values([
          {
            id: `inventory-backup-database-a-${suffix}`,
            database_id: databaseA,
            config_id: null,
            destination_kind: "local",
            location: databaseLocationA,
            status: "succeeded",
            started_at: now,
            finished_at: now,
          },
          {
            id: `inventory-backup-database-b-${suffix}`,
            database_id: databaseB,
            config_id: null,
            destination_kind: "local",
            location: databaseLocationB,
            status: "succeeded",
            started_at: now,
            finished_at: now,
          },
        ])
        await db.insert(volume_backups).values([
          {
            id: `inventory-backup-volume-a-${suffix}`,
            app_id: appA,
            volume_id: volumeA,
            config_id: null,
            destination_kind: "local",
            location: volumeLocationA,
            status: "succeeded",
            started_at: now,
            finished_at: now,
          },
          {
            id: `inventory-backup-volume-b-${suffix}`,
            app_id: appB,
            volume_id: volumeB,
            config_id: null,
            destination_kind: "local",
            location: volumeLocationB,
            status: "succeeded",
            started_at: now,
            finished_at: now,
          },
        ])

        const res = await wrapRouter(db, {
          ...fakeUser,
          id: userA,
        }).fetch(req("GET", "/backups/inventory"))

        expect(res.status).toBe(200)
        const body = (await res.json()) as {
          backups: Array<{ id: string; resourceName: string }>
        }
        expect(body.backups.map((backup) => backup.id).sort()).toEqual([
          `inventory-backup-database-a-${suffix}`,
          `inventory-backup-volume-a-${suffix}`,
        ])
        expect(body.backups.map((backup) => backup.resourceName)).not.toContain(
          "Hidden database"
        )
        expect(body.backups.map((backup) => backup.resourceName)).not.toContain(
          "Hidden app:data"
        )

        const scopedRouter = wrapRouter(db, { ...fakeUser, id: userA })
        const databaseOnly = await scopedRouter.fetch(
          req("GET", `/backups/inventory?kind=database&resourceId=${databaseA}`)
        )
        expect(
          (
            (await databaseOnly.json()) as { backups: Array<{ id: string }> }
          ).backups.map((backup: { id: string }) => backup.id)
        ).toEqual([`inventory-backup-database-a-${suffix}`])
        const volumeOnly = await scopedRouter.fetch(
          req(
            "GET",
            `/backups/inventory?kind=volume&resourceId=${volumeA}&appId=${appA}`
          )
        )
        expect(
          (
            (await volumeOnly.json()) as { backups: Array<{ id: string }> }
          ).backups.map((backup: { id: string }) => backup.id)
        ).toEqual([`inventory-backup-volume-a-${suffix}`])
        const mismatchedApp = await scopedRouter.fetch(
          req(
            "GET",
            `/backups/inventory?kind=volume&resourceId=${volumeA}&appId=${appB}`
          )
        )
        expect(
          ((await mismatchedApp.json()) as { backups: unknown[] }).backups
        ).toEqual([])
      } finally {
        await db.delete(projects).where(eq(projects.id, projectA))
        await db.delete(projects).where(eq(projects.id, projectB))
        await db.delete(users).where(eq(users.id, userA))
        await db.delete(users).where(eq(users.id, userB))
        await db.$client.end()
      }
    }
  )
})

describe("database backup routes", () => {
  it("requires database scopes for database backup config reads", async () => {
    const { db } = buildDb([])

    const res = await wrapRouter(db, {
      ...fakeUser,
      token_scopes: ["apps:read"],
    }).fetch(req("GET", "/databases/db-1/backup-config"))

    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("FORBIDDEN")
  })

  it("allows databases:* scope for database backup config reads", async () => {
    const dbRow = { id: "db-1", name: "primary" }
    const configRow = {
      id: "cfg-1",
      database_id: "db-1",
      destination_kind: "local",
      s3_endpoint: null,
      s3_bucket: null,
      s3_prefix: null,
      s3_region: null,
      s3_credentials_secret_id: null,
      schedule_cron: "0 3 * * *",
      retention_days: 7,
      age_recipient_public_key: null,
      enabled: true,
      last_run_at: null,
      last_error: null,
      created_at: new Date("2026-04-28T10:00:00.000Z"),
    }
    const { db } = buildDb([[{ db: dbRow }], [configRow]])

    const res = await wrapRouter(db, {
      ...fakeUser,
      token_scopes: ["databases:*"],
    }).fetch(req("GET", "/databases/db-1/backup-config"))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { config: { id: string } }
    expect(body.config.id).toBe("cfg-1")
  })
})
