// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock } from "bun:test"
import { Hono } from "hono"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import { createDatabasesRouter } from "./databases"
import type { Db } from "@ploydok/db"

// ── Mocks ─────────────────────────────────────────────────────────────────────

mock.module("../auth/second-factor", () => ({
  requireTotpVerified: mock(
    () => async (_c: unknown, next: () => Promise<void>) => {
      await next()
    }
  ),
}))

mock.module("../databases/spawner", () => ({
  spawnDatabase: mock(async () => ({
    id: "db-test-id",
    containerId: "container-123",
    connectionString:
      "postgres://ploydok:secret@ploydok-db-db-test-id:5432/app",
  })),
  getConnectionString: mock(
    async () => "postgres://ploydok:secret@ploydok-db-db-test-id:5432/app"
  ),
  getConnectionPassword: mock(async () => "secret"),
  startDatabaseContainer: mock(async () => {}),
  stopDatabaseContainer: mock(async () => {}),
  recreateDatabaseContainer: mock(
    async (_db: unknown, row: Record<string, unknown>) => row
  ),
  removeDatabasePublicProxy: mock(async () => {}),
  resumeDatabaseCreation: mock(async () => {}),
  compensateDatabaseCreation: mock(async () => {}),
}))

mock.module("../debug/singletons", () => ({
  getSharedAgent: () => ({
    containerStop: mock(async () => ({})),
    containerRemove: mock(async () => ({})),
    containerLogs: mock(async function* () {}),
    containerStats: mock(async function* () {}),
  }),
  getSharedCaddy: () => ({}),
}))

mock.module("../logger", () => ({
  childLogger: mock(() => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  })),
}))

mock.module("../env", () => ({
  env: {
    DATABASE_URL: "postgres://localhost/test",
    NODE_ENV: "test",
    WEB_ORIGIN: "http://localhost:5173",
    SESSION_SECRET: "test-secret",
    MASTER_KEY: "dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLXBhZGRpbmc=",
    REDIS_URL: "redis://127.0.0.1:6379/0",
    PLOYDOK_REGISTRY_URL: "127.0.0.1:5000",
    PLOYDOK_REGISTRY_PUSH_URL: "registry:5000",
    PLOYDOK_BUILD_DIR: "/tmp/.ploydok-test/builds",
    PLOYDOK_BUILDKIT_ADDR: "docker-container://ploydok-buildkitd",
    GITHUB_APP_CALLBACK_URL: "http://localhost:3335/github/app/callback",
    GITLAB_OAUTH_CALLBACK_URL: "http://localhost:3335/gitlab/callback",
  },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────

const fakeUser = {
  id: "user-1",
  email: "t@t.com",
  display_name: "T",
  session_id: "s",
}

function makeChain(result: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => ({ limit: () => Promise.resolve(result) }),
    limit: () => Promise.resolve(result),
  }
  return chain
}

function buildDb(
  overrides: Partial<{
    selectResult: unknown[]
    dbRow: unknown
  }> = {}
) {
  const { dbRow = null } = overrides

  const db: Record<string, unknown> = {
    select: mock(() => makeChain(dbRow ? [{ db: dbRow }] : [])),
    insert: mock(() => ({ values: mock(async () => {}) })),
    update: mock(() => ({
      set: mock(() => ({ where: mock(async () => {}) })),
    })),
    delete: mock(() => ({ where: mock(async () => {}) })),
  }
  return db as unknown as Db
}

function wrapRouter(db: Db) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", fakeUser)
    await next()
  })
  app.route("/", createDatabasesRouter(db))
  return app
}

function req(method: string, path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("POST /databases validation", () => {
  it("returns 400 on invalid kind", async () => {
    const db = buildDb({ dbRow: { id: "proj-1" } })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("POST", "/", {
        projectId: "proj-1",
        kind: "sqlite",
        name: "mydb",
        plan: "small",
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("VALIDATION_ERROR")
  })

  it("returns 400 on invalid name (uppercase)", async () => {
    const db = buildDb({ dbRow: { id: "proj-1" } })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("POST", "/", {
        projectId: "proj-1",
        kind: "postgres",
        name: "MyDB",
        plan: "small",
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("VALIDATION_ERROR")
  })

  it("returns 400 on invalid plan", async () => {
    const db = buildDb({ dbRow: { id: "proj-1" } })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("POST", "/", {
        projectId: "proj-1",
        kind: "postgres",
        name: "mydb",
        plan: "xlarge",
      })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("VALIDATION_ERROR")
  })

  it("accepts libsql as a managed Dokploy-style SQLite database", async () => {
    const db = buildDb({ dbRow: { id: "proj-1" } })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("POST", "/", {
        projectId: "proj-1",
        kind: "libsql",
        name: "local-sqlite",
        plan: "small",
      })
    )
    expect(res.status).toBe(201)
    const data = (await res.json()) as { id: string }
    expect(data.id).toBe("db-test-id")
  })

  it("replays POST /databases by idempotency key", async () => {
    const db = buildDb({
      dbRow: {
        id: "db-existing",
        project_id: "proj-1",
        creation_idempotency_key: "create-test-key:database",
      },
    })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("POST", "/", {
        projectId: "proj-1",
        kind: "postgres",
        name: "mydb",
        plan: "small",
        idempotencyKey: "create-test-key:database",
      })
    )

    expect(res.status).toBe(200)
    const data = (await res.json()) as { id: string }
    expect(data.id).toBe("db-existing")
  })
})

describe("POST /databases/external", () => {
  it("registers an external PostgreSQL database", async () => {
    const db = buildDb({ dbRow: { id: "proj-1" } })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("POST", "/external", {
        projectId: "proj-1",
        name: "host-postgres",
        connectionString: "postgres://app:secret@10.0.0.5:5432/app",
      })
    )

    expect(res.status).toBe(201)
    const data = (await res.json()) as { id: string }
    expect(typeof data.id).toBe("string")
  })

  it("rejects non-PostgreSQL external database URLs", async () => {
    const db = buildDb({ dbRow: { id: "proj-1" } })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("POST", "/external", {
        projectId: "proj-1",
        name: "mysql-host",
        connectionString: "mysql://app:secret@10.0.0.5:3306/app",
      })
    )

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("VALIDATION_ERROR")
  })
})

describe("POST /databases/:id/reveal", () => {
  it("returns the connection string and extracted password", async () => {
    const db = buildDb({
      dbRow: {
        id: "db-test-id",
        project_id: "proj-1",
        kind: "postgres",
        name: "mydb",
        plan: "small",
        status: "running",
        host: "ploydok-db-db-test-id",
        port: 5432,
        container_id: "container-123",
        connection_string_enc: Buffer.from("enc"),
        connection_string_nonce: Buffer.from("nonce"),
        master_password_enc: Buffer.from("pw"),
        master_password_nonce: Buffer.from("nonce"),
      },
    })
    const app = wrapRouter(db)
    const res = await app.fetch(req("POST", "/db-test-id/reveal"))

    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      connection_string: string
      password: string
    }
    expect(data.connection_string).toContain("postgres://")
    expect(data.password).toBe("secret")
  })
})

describe("DELETE /databases/:id", () => {
  const mockDatabaseRow = {
    id: "db-test-id",
    project_id: "proj-1",
    kind: "postgres",
    name: "mydb",
    plan: "small",
    status: "running",
    host: "ploydok-db-db-test-id",
    port: 5432,
    container_id: "container-123",
    connection_string_enc: Buffer.from("enc"),
    connection_string_nonce: Buffer.from("nonce"),
  }

  it("returns 400 if confirm string is wrong", async () => {
    const db = buildDb({ dbRow: mockDatabaseRow })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("DELETE", "/db-test-id", { confirm: "wrong" })
    )
    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("CONFIRM_REQUIRED")
  })

  it("returns 404 if database not found", async () => {
    const db = buildDb({ dbRow: null })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("DELETE", "/nonexistent", { confirm: "delete nonexistent" })
    )
    expect(res.status).toBe(404)
  })
})

describe("GET /databases", () => {
  const mockDatabaseRow = {
    id: "db-test-id",
    project_id: "proj-1",
    kind: "postgres",
    version: "16",
    name: "mydb",
    plan: "small",
    management_mode: "managed",
    status: "running",
    health_status: "healthy",
    host: "ploydok-db-db-test-id",
    port: 5432,
    exposure_mode: "internal",
    public_enabled: false,
    public_port: null,
    public_host: null,
    public_url: null,
    rotation_schedule: "manual",
    rotation_in_progress: false,
    password_rotated_at: null,
    last_started_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  }

  function buildListDb(rows: unknown[]) {
    const backupProtectionWhere = mock(() => backupProtectionQuery)
    const latestBackupWhere = mock(() => latestBackupQuery)
    const latestBackupLimit = mock(() => latestBackupQuery)
    const latestBackupOrderBy = mock(() => latestBackupQuery)
    const lastSuccessfulBackupWhere = mock(() => lastSuccessfulBackupQuery)
    const lastSuccessfulBackupLimit = mock(() => lastSuccessfulBackupQuery)
    const lastSuccessfulBackupOrderBy = mock(() => lastSuccessfulBackupQuery)
    const backupProtectionQuery = {
      from: () => backupProtectionQuery,
      where: backupProtectionWhere,
      as: () => ({}),
    }
    const latestBackupQuery = {
      from: () => latestBackupQuery,
      where: latestBackupWhere,
      orderBy: latestBackupOrderBy,
      limit: latestBackupLimit,
      as: () => ({}),
    }
    const lastSuccessfulBackupQuery = {
      from: () => lastSuccessfulBackupQuery,
      where: lastSuccessfulBackupWhere,
      orderBy: lastSuccessfulBackupOrderBy,
      limit: lastSuccessfulBackupLimit,
      as: () => ({}),
    }
    const linkedAppsJoin = mock(() => linkedAppsQuery)
    const linkedAppsQuery = {
      from: () => linkedAppsQuery,
      innerJoin: linkedAppsJoin,
      where: () => linkedAppsQuery,
      as: () => ({}),
    }
    const listLeftJoinLateral = mock(() => listQuery)
    const listQuery = {
      from: () => listQuery,
      innerJoin: () => listQuery,
      leftJoin: () => listQuery,
      leftJoinLateral: listLeftJoinLateral,
      where: () => Promise.resolve(rows),
      then: (onFulfilled: (value: unknown[]) => unknown) =>
        Promise.resolve(rows).then(onFulfilled),
    }
    let selectCalls = 0

    return Object.assign(
      {
        select: mock(() => {
          selectCalls += 1
          if (selectCalls === 1) return backupProtectionQuery
          if (selectCalls === 2) return latestBackupQuery
          if (selectCalls === 3) return lastSuccessfulBackupQuery
          if (selectCalls === 4) return linkedAppsQuery
          return listQuery
        }),
        insert: mock(() => ({ values: mock(async () => {}) })),
        update: mock(() => ({
          set: mock(() => ({ where: mock(async () => {}) })),
        })),
        delete: mock(() => ({ where: mock(async () => {}) })),
      } as unknown as Db,
      {
        latestBackupLimit,
        latestBackupOrderBy,
        latestBackupWhere,
        lastSuccessfulBackupLimit,
        lastSuccessfulBackupOrderBy,
        lastSuccessfulBackupWhere,
        backupProtectionWhere,
        linkedAppsJoin,
        listLeftJoinLateral,
      }
    )
  }

  it("returns disabled protection and no latest backup without configuration", async () => {
    const db = buildListDb([
      {
        db: mockDatabaseRow,
        backup_enabled: null,
        backup_schedule_cron: null,
        latest_backup_status: null,
        latest_backup_at: null,
        last_successful_backup_at: null,
        linked_apps: null,
      },
    ])
    const app = wrapRouter(db)
    const res = await app.fetch(req("GET", "/"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      expect.objectContaining({
        backup_enabled: false,
        backup_deadline_at: null,
        latest_backup_status: null,
        latest_backup_at: null,
        linked_apps: [],
      }),
    ])
  })

  it("returns enabled protection and the latest backup summary", async () => {
    const latestBackupAt = new Date("2026-03-02T03:04:05.000Z")
    const db = buildListDb([
      {
        db: mockDatabaseRow,
        backup_enabled: true,
        backup_schedule_cron: "0 3 * * *",
        backup_configured_at: new Date("2026-02-01T03:00:00.000Z"),
        latest_backup_status: "succeeded",
        latest_backup_at: latestBackupAt,
        last_successful_backup_at: new Date("2026-03-02T03:05:06.000Z"),
        linked_apps: null,
      },
    ])
    const app = wrapRouter(db)
    const res = await app.fetch(req("GET", "/"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      expect.objectContaining({
        backup_enabled: true,
        backup_deadline_at: "2026-03-03T15:00:00.000Z",
        latest_backup_status: "succeeded",
        latest_backup_at: latestBackupAt.toISOString(),
        last_successful_backup_at: "2026-03-02T03:05:06.000Z",
        linked_apps: [],
      }),
    ])
  })

  it("orders the latest-backup subquery by start time and id", async () => {
    const db = buildListDb([])
    const app = wrapRouter(db)
    const res = await app.fetch(req("GET", "/"))

    expect(res.status).toBe(200)
    expect(db.latestBackupOrderBy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything()
    )
    expect(db.latestBackupLimit).toHaveBeenCalledWith(1)
    expect(db.latestBackupWhere).toHaveBeenCalledWith(expect.anything())
    expect(db.lastSuccessfulBackupOrderBy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything()
    )
    expect(db.lastSuccessfulBackupLimit).toHaveBeenCalledWith(1)
    expect(db.lastSuccessfulBackupWhere).toHaveBeenCalledWith(
      expect.anything()
    )
    expect(db.listLeftJoinLateral).toHaveBeenCalledTimes(4)
    const protectionScope = (
      db.backupProtectionWhere.mock.calls as unknown as Array<[SQL]>
    )[0]?.[0]
    if (!protectionScope) throw new Error("Missing backup-protection scope")
    expect(new PgDialect().sqlToQuery(protectionScope).sql).toContain(
      '"backup_configs"."database_id" = "databases"."id"'
    )
    const latestBackupScope = (
      db.latestBackupWhere.mock.calls as unknown as Array<[SQL]>
    )[0]?.[0]
    if (!latestBackupScope) throw new Error("Missing latest-backup scope")
    expect(new PgDialect().sqlToQuery(latestBackupScope).sql).toContain(
      '"backups"."config_id"'
    )
    const successfulBackupScope = (
      db.lastSuccessfulBackupWhere.mock.calls as unknown as Array<[SQL]>
    )[0]?.[0]
    if (!successfulBackupScope) throw new Error("Missing successful-backup scope")
    const successfulBackupQuery = new PgDialect().sqlToQuery(
      successfulBackupScope
    )
    expect(successfulBackupQuery.sql).toContain('"backups"."config_id"')
    expect(successfulBackupQuery.sql).toContain('"backups"."status"')
  })

  it("returns linked apps with their names, slugs, and count", async () => {
    const db = buildListDb([
      {
        db: mockDatabaseRow,
        backup_enabled: false,
        backup_schedule_cron: null,
        latest_backup_status: null,
        latest_backup_at: null,
        last_successful_backup_at: null,
        linked_apps: [
          {
            app_id: "app-api",
            app_name: "API",
            app_slug: "api",
            env_prefix: "DATABASE",
          },
          {
            app_id: "app-worker",
            app_name: "Worker",
            app_slug: "worker",
            env_prefix: "REDIS",
          },
        ],
      },
    ])
    const app = wrapRouter(db)
    const res = await app.fetch(req("GET", "/?projectId=proj-1"))

    expect(res.status).toBe(200)
    const data = (await res.json()) as Array<{
      linked_apps: Array<{
        app_id: string
        app_name: string | null
        app_slug: string | null
        env_prefix: string
      }>
    }>
    expect(data[0]?.linked_apps).toEqual([
      {
        app_id: "app-api",
        app_name: "API",
        app_slug: "api",
        env_prefix: "DATABASE",
      },
      {
        app_id: "app-worker",
        app_name: "Worker",
        app_slug: "worker",
        env_prefix: "REDIS",
      },
    ])
    expect(data[0]?.linked_apps).toHaveLength(2)
    expect(db.linkedAppsJoin).toHaveBeenCalledTimes(1)
  })

  it("restricts linked apps to the database project", async () => {
    const db = buildListDb([])
    const app = wrapRouter(db)
    const res = await app.fetch(req("GET", "/"))

    expect(res.status).toBe(200)
    const projectScopedJoin = (
      db.linkedAppsJoin.mock.calls as unknown as Array<[unknown, SQL]>
    )[0]?.[1]
    if (!projectScopedJoin) throw new Error("Missing linked-app project join")
    expect(new PgDialect().sqlToQuery(projectScopedJoin).sql).toContain(
      '"apps"."project_id" = "databases"."project_id"'
    )
  })

  it("returns 200 with array", async () => {
    const app = wrapRouter(buildListDb([]))
    const res = await app.fetch(req("GET", "/"))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(Array.isArray(data)).toBe(true)
  })
})

describe("GET /databases/:id", () => {
  const mockDatabaseRow = {
    id: "db-test-id",
    project_id: "proj-1",
    kind: "postgres",
    version: "16",
    name: "mydb",
    plan: "small",
    status: "running",
    health_status: "healthy",
    host: "ploydok-db-db-test-id",
    port: 5432,
    exposure_mode: "internal",
    public_enabled: false,
    public_port: null,
    public_host: null,
    public_url: null,
    rotation_schedule: "manual",
    rotation_in_progress: false,
    password_rotated_at: null,
    last_started_at: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
  }

  function buildDetailDb(linkRows: unknown[]) {
    let selectCalls = 0
    const db: Record<string, unknown> = {
      select: mock(() => {
        selectCalls += 1

        if (selectCalls === 1) {
          const chain = {
            from: () => chain,
            innerJoin: () => chain,
            where: () => ({
              limit: () => Promise.resolve([{ db: mockDatabaseRow }]),
            }),
          }
          return chain
        }

        const chain = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve(linkRows),
        }
        return chain
      }),
      insert: mock(() => ({ values: mock(async () => {}) })),
      update: mock(() => ({
        set: mock(() => ({ where: mock(async () => {}) })),
      })),
      delete: mock(() => ({ where: mock(async () => {}) })),
    }
    return db as unknown as Db
  }

  it("returns linked app names for linked databases", async () => {
    const db = buildDetailDb([
      {
        app_id: "app-1",
        app_name: "api",
        app_slug: "api",
        env_prefix: "DATABASE",
      },
    ])
    const app = wrapRouter(db)
    const res = await app.fetch(req("GET", "/db-test-id"))

    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      linked_apps: Array<{
        app_id: string
        app_name: string | null
        app_slug: string | null
        env_prefix: string
      }>
    }
    expect(data.linked_apps).toEqual([
      {
        app_id: "app-1",
        app_name: "api",
        app_slug: "api",
        env_prefix: "DATABASE",
      },
    ])
  })

  it("returns an empty linked app list for unlinked databases", async () => {
    const db = buildDetailDb([])
    const app = wrapRouter(db)
    const res = await app.fetch(req("GET", "/db-test-id"))

    expect(res.status).toBe(200)
    const data = (await res.json()) as { linked_apps: unknown[] }
    expect(data.linked_apps).toEqual([])
  })
})

describe("POST /databases/:id lifecycle", () => {
  const mockDatabaseRow = {
    id: "db-test-id",
    project_id: "proj-1",
    kind: "postgres",
    version: "16",
    name: "mydb",
    plan: "small",
    status: "running",
    health_status: "healthy",
    host: "ploydok-db-db-test-id",
    port: 5432,
    exposure_mode: "internal",
    public_enabled: false,
    public_port: null,
    public_host: null,
    public_url: null,
    volume_name: "ploydok-db-db-test-id",
    container_id: "container-123",
    connection_string_enc: Buffer.from("enc"),
    connection_string_nonce: Buffer.from("nonce"),
  }

  it("starts a database", async () => {
    const db = buildDb({ dbRow: mockDatabaseRow })
    const app = wrapRouter(db)
    const res = await app.fetch(req("POST", "/db-test-id/start"))
    expect(res.status).toBe(200)
  })

  it("updates network settings", async () => {
    const db = buildDb({ dbRow: mockDatabaseRow })
    const app = wrapRouter(db)
    const res = await app.fetch(
      req("PATCH", "/db-test-id/network", {
        exposureMode: "public_proxy",
        publicEnabled: true,
      })
    )
    expect(res.status).toBe(200)
  })

  it("rejects lifecycle actions for external databases", async () => {
    const db = buildDb({
      dbRow: {
        ...mockDatabaseRow,
        management_mode: "external",
        container_id: null,
      },
    })
    const app = wrapRouter(db)
    const res = await app.fetch(req("POST", "/db-test-id/start"))

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("UNSUPPORTED_DATABASE_MODE")
  })
})

describe("GET /databases/:id/logs", () => {
  it("returns 404 when the database is missing", async () => {
    const app = wrapRouter(buildDb({ dbRow: null }))
    const res = await app.fetch(req("GET", "/db-missing/logs"))
    expect(res.status).toBe(404)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("NOT_FOUND")
  })

  it("returns an empty snapshot when the database has no container", async () => {
    const app = wrapRouter(
      buildDb({
        dbRow: {
          id: "db-1",
          container_id: null,
        },
      })
    )
    const res = await app.fetch(req("GET", "/db-1/logs"))
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      lines: unknown[]
      containerFound: boolean
    }
    expect(data.containerFound).toBe(false)
    expect(data.lines).toEqual([])
  })
})
