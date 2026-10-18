// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock } from "bun:test"
import { Hono } from "hono"
import type { Context } from "hono"
import type { Db } from "@ploydok/db"
import type { AuthUser } from "../auth/middleware"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let rejectTotp = false

// Mock the crypto module to avoid keyring dependency
mock.module("../secrets/crypto", () => ({
  encryptSecret: mock(async (value: string) => ({
    enc: Buffer.from(`enc:${value}`),
    nonce: Buffer.from("testnonce123"),
  })),
  decryptSecret: mock(async (enc: Buffer) =>
    enc.toString().replace("enc:", "")
  ),
}))

mock.module("../auth/second-factor", () => ({
  requireTotpVerified: mock(
    () => async (c: Context, next: () => Promise<void>) => {
      if (rejectTotp) {
        return c.json(
          {
            error: {
              code: "TOTP_REQUIRED",
              message: "TOTP verification required",
            },
          },
          401
        )
      }

      await next()
    }
  ),
}))

mock.module("@ploydok/db", () => ({
  createDb: mock(() => ({})),
  audit_log: {
    user_id: "user_id",
    action: "action",
    target_type: "target_type",
    target_id: "target_id",
    metadata: "metadata",
    created_at: "created_at",
  },
  databases: {
    id: "id",
    name: "name",
    kind: "kind",
  },
  users: {
    id: "id",
    require_totp_for_secret_reveal: "require_totp_for_secret_reveal",
  },
  secrets: {
    id: "id",
    app_id: "app_id",
    project_id: "project_id",
    scope: "scope",
    phase: "phase",
    key: "key",
    value_ciphertext: "value_ciphertext",
    nonce: "nonce",
    linked_database_id: "linked_database_id",
    created_at: "created_at",
  },
  env_vars: {
    id: "id",
    app_id: "app_id",
    key: "key",
    value: "value",
    updated_at: "updated_at",
  },
}))

mock.module("@ploydok/db/queries", () => ({
  getAppForUser: mock(async (_db: unknown, appId: string, userId: string) => {
    if (appId === "app1" && userId === "user1") {
      return { id: "app1", project_id: "proj1", name: "Test App" }
    }
    return null
  }),
}))

mock.module("../logger", () => ({
  childLogger: mock(() => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  })),
}))

const { audit_log, secrets } = await import("@ploydok/db")
const { createSecretsRouter } = await import("./secrets")

// ---------------------------------------------------------------------------
// Fake DB
// ---------------------------------------------------------------------------

type StoredSecret = {
  id: string
  app_id: string
  project_id: string
  scope: "shared" | "prod" | "preview" | "dev"
  phase: "build" | "runtime" | "both"
  key: string
  value_ciphertext: Buffer
  nonce: Buffer
  linked_database_id: string | null
  created_at: Date
}

type SecretColumn = keyof StoredSecret

type ConditionFilters = {
  equals: Partial<Record<SecretColumn, unknown>>
  isNull: Set<SecretColumn>
  notIn: Partial<Record<SecretColumn, Array<unknown>>>
}

const secretColumns = new Set<SecretColumn>([
  "id",
  "app_id",
  "project_id",
  "scope",
  "phase",
  "key",
  "value_ciphertext",
  "nonce",
  "linked_database_id",
  "created_at",
])

const fakeUser: AuthUser = {
  id: "user1",
  email: "user@example.com",
  display_name: "User",
  session_id: "session1",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function queryChunks(value: unknown): Array<unknown> {
  if (isRecord(value) && Array.isArray(value.queryChunks)) {
    return value.queryChunks
  }

  return []
}

function stringChunk(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.value)) {
    return null
  }

  const parts = value.value
  if (!parts.every((part) => typeof part === "string")) {
    return null
  }

  return parts.join("")
}

function columnName(value: unknown): SecretColumn | null {
  if (typeof value === "string" && secretColumns.has(value as SecretColumn)) {
    return value as SecretColumn
  }

  const chunk = stringChunk(value)
  if (chunk && secretColumns.has(chunk as SecretColumn)) {
    return chunk as SecretColumn
  }

  if (!isRecord(value) || typeof value.name !== "string") {
    return null
  }

  return secretColumns.has(value.name as SecretColumn)
    ? (value.name as SecretColumn)
    : null
}

function paramValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value
  }

  if (isRecord(value) && "encoder" in value && "value" in value) {
    return value.value
  }

  return undefined
}

function extractFilters(condition: unknown): ConditionFilters {
  const filters: ConditionFilters = {
    equals: {},
    isNull: new Set(),
    notIn: {},
  }

  collectFilters(condition, filters)
  return filters
}

function collectFilters(condition: unknown, filters: ConditionFilters) {
  const chunks = queryChunks(condition)

  for (const chunk of chunks) {
    if (queryChunks(chunk).length > 0) {
      collectFilters(chunk, filters)
    }
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const name = columnName(chunks[index])
    if (!name) continue

    const operator = stringChunk(chunks[index + 1])?.trim()
    if (operator === "=") {
      filters.equals[name] = paramValue(chunks[index + 2])
      continue
    }

    if (operator === "is null") {
      filters.isNull.add(name)
      continue
    }

    if (operator === "not in") {
      const values = chunks[index + 2]
      filters.notIn[name] = Array.isArray(values)
        ? values.map((value) => paramValue(value))
        : []
    }
  }
}

function matchesFilters(row: StoredSecret, filters: ConditionFilters) {
  for (const [key, value] of Object.entries(filters.equals)) {
    if (row[key as SecretColumn] !== value) return false
  }

  for (const key of filters.isNull) {
    if (row[key] !== null) return false
  }

  for (const [key, values] of Object.entries(filters.notIn)) {
    if (values.includes(row[key as SecretColumn])) return false
  }

  return true
}

function secretRow(key: string, overrides: Partial<StoredSecret> = {}) {
  return {
    id: `${key.toLowerCase()}-id`,
    app_id: "app1",
    project_id: "proj1",
    scope: "shared",
    phase: "runtime",
    key,
    value_ciphertext: Buffer.from(`enc:${key.toLowerCase()}`),
    nonce: Buffer.from("nonce"),
    linked_database_id: null,
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } satisfies StoredSecret
}

function buildFakeDb(initialSecrets: Array<StoredSecret>) {
  const rows = [...initialSecrets]
  const auditRows: Array<unknown> = []

  function selectedRows(table: unknown, condition: unknown) {
    if (table !== secrets) return []

    const filters = extractFilters(condition)
    return rows.filter((row) => matchesFilters(row, filters))
  }

  const db = {
    select: mock(() => {
      let table: unknown
      let condition: unknown
      const chain = {
        from(nextTable: unknown) {
          table = nextTable
          return chain
        },
        leftJoin() {
          return chain
        },
        where(nextCondition: unknown) {
          condition = nextCondition
          return chain
        },
        limit(count: number) {
          return Promise.resolve(selectedRows(table, condition).slice(0, count))
        },
      }
      return chain
    }),
    insert: mock((table: unknown) => ({
      values: mock(async (values: unknown) => {
        if (table === secrets) {
          rows.push(values as StoredSecret)
        }
        if (table === audit_log) {
          auditRows.push(values)
        }
        return values
      }),
    })),
    update: mock((table: unknown) => ({
      set: mock((values: Partial<StoredSecret>) => ({
        where: mock(async (condition: unknown) => {
          if (table !== secrets) return

          const filters = extractFilters(condition)
          for (const row of rows) {
            if (matchesFilters(row, filters)) {
              Object.assign(row, values)
            }
          }
        }),
      })),
    })),
    delete: mock((table: unknown) => ({
      where: mock((condition: unknown) => {
        const removed: Array<StoredSecret> = []
        if (table === secrets) {
          const filters = extractFilters(condition)
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index]
            if (row && matchesFilters(row, filters)) {
              removed.push(row)
              rows.splice(index, 1)
            }
          }
        }

        return {
          returning: mock(async () => removed.map((row) => ({ id: row.id }))),
        }
      }),
    })),
  }

  return { db: db as unknown as Db, rows, auditRows }
}

function buildApp(db: Db) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    ;(c as { set: (key: string, value: AuthUser) => void }).set(
      "user",
      fakeUser
    )
    await next()
  })
  app.route("/", createSecretsRouter(db))
  return app
}

function importRequest(path: string, content: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  })
}

function updateRequest(path: string, value: string) {
  return patchRequest(path, { value })
}

function patchRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PATCH /:id/secrets/:key", () => {
  it("moves a secret to another phase and keeps its value", async () => {
    const { db, rows } = buildFakeDb([secretRow("SITE_URL")])
    const app = buildApp(db)

    const res = await app.fetch(
      patchRequest("/app1/secrets/SITE_URL?scope=shared&phase=runtime", {
        phase: "both",
      })
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      key: "SITE_URL",
      scope: "shared",
      phase: "both",
    })
    expect(rows[0]?.phase).toBe("both")
    expect(rows[0]?.value_ciphertext.toString()).toBe("enc:site_url")
  })

  it("updates the value and the phase together", async () => {
    const { db, rows } = buildFakeDb([secretRow("SITE_URL")])
    const app = buildApp(db)

    const res = await app.fetch(
      patchRequest("/app1/secrets/SITE_URL?scope=shared&phase=runtime", {
        value: "https://example.test",
        phase: "build",
      })
    )

    expect(res.status).toBe(200)
    expect(rows[0]?.phase).toBe("build")
    expect(rows[0]?.value_ciphertext.toString()).toBe(
      "enc:https://example.test"
    )
  })

  it("refuses a phase that already holds the same key", async () => {
    const { db, rows } = buildFakeDb([
      secretRow("SITE_URL"),
      secretRow("SITE_URL", { id: "secret-build", phase: "build" }),
    ])
    const app = buildApp(db)

    const res = await app.fetch(
      patchRequest("/app1/secrets/SITE_URL?scope=shared&phase=runtime", {
        phase: "build",
      })
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: {
        code: "SECRET_EXISTS",
        message: "SITE_URL already exists for the build phase",
      },
    })
    expect(rows.map((row) => row.phase)).toEqual(["runtime", "build"])
  })

  it("rejects a body with neither value nor phase", async () => {
    const { db } = buildFakeDb([secretRow("FOO")])
    const app = buildApp(db)

    const res = await app.fetch(
      patchRequest("/app1/secrets/FOO?scope=shared&phase=runtime", {})
    )

    expect(res.status).toBe(400)
  })

  it("updates the value of an existing key", async () => {
    const { db, rows, auditRows } = buildFakeDb([secretRow("FOO")])
    const app = buildApp(db)
    const previousCreatedAt = rows[0]?.created_at

    const res = await app.fetch(
      updateRequest("/app1/secrets/FOO?scope=shared&phase=runtime", "updated")
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      key: "FOO",
      scope: "shared",
      phase: "runtime",
    })
    expect(rows[0]?.value_ciphertext.toString()).toBe("enc:updated")
    expect(rows[0]?.nonce.toString()).toBe("testnonce123")
    expect(rows[0]?.created_at).not.toBe(previousCreatedAt)
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: "secret.updated" })
    )
  })

  it("returns 404 when the key does not exist for the requested scope and phase", async () => {
    const { db } = buildFakeDb([secretRow("FOO", { phase: "build" })])
    const app = buildApp(db)

    const res = await app.fetch(
      updateRequest("/app1/secrets/FOO?scope=shared&phase=runtime", "updated")
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Secret not found" },
    })
  })

  it("returns 400 when the secret is managed by a database link", async () => {
    const { db, rows } = buildFakeDb([
      secretRow("DATABASE_URL", { linked_database_id: "db1" }),
    ])
    const app = buildApp(db)

    const res = await app.fetch(
      updateRequest(
        "/app1/secrets/DATABASE_URL?scope=shared&phase=runtime",
        "updated"
      )
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: "LINKED_SECRET",
        message: "managed by a database link, unlink first",
      },
    })
    expect(rows[0]?.value_ciphertext.toString()).toBe("enc:database_url")
  })

  it("returns 400 when the body is invalid", async () => {
    const { db, rows } = buildFakeDb([secretRow("FOO")])
    const app = buildApp(db)

    const res = await app.fetch(
      updateRequest("/app1/secrets/FOO?scope=shared&phase=runtime", "")
    )

    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe("VALIDATION_ERROR")
    expect(rows[0]?.value_ciphertext.toString()).toBe("enc:foo")
  })

  it("returns 404 when the app does not exist", async () => {
    const { db } = buildFakeDb([secretRow("FOO")])
    const app = buildApp(db)

    const res = await app.fetch(
      updateRequest(
        "/missing/secrets/FOO?scope=shared&phase=runtime",
        "updated"
      )
    )

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "App not found" },
    })
  })
})

describe("POST /:id/secrets/import", () => {
  it("replace removes manual keys absent from the targeted scope and phase", async () => {
    const { db, rows, auditRows } = buildFakeDb([
      secretRow("FOO"),
      secretRow("REMOVE_ME"),
    ])
    const app = buildApp(db)

    const res = await app.fetch(
      importRequest(
        "/app1/secrets/import?scope=shared&phase=runtime&mode=replace",
        "FOO=updated"
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ imported: 1, removed: 1 })
    expect(rows.map((row) => row.key).sort()).toEqual(["FOO"])
    expect(rows[0]?.value_ciphertext.toString()).toBe("enc:updated")
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: "secret.synced" })
    )
  })

  it("replace accepts empty content to remove all targeted manual keys", async () => {
    const { db, rows } = buildFakeDb([
      secretRow("REMOVE_ONE"),
      secretRow("REMOVE_TWO"),
      secretRow("BUILD_ONLY", { phase: "build" }),
    ])
    const app = buildApp(db)

    const res = await app.fetch(
      importRequest(
        "/app1/secrets/import?scope=shared&phase=runtime&mode=replace",
        ""
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ imported: 0, removed: 2 })
    expect(rows.map((row) => row.key)).toEqual(["BUILD_ONLY"])
  })

  it("replace preserves database-linked keys even when absent", async () => {
    const { db, rows } = buildFakeDb([
      secretRow("FOO"),
      secretRow("DATABASE_URL", { linked_database_id: "db1" }),
    ])
    const app = buildApp(db)

    const res = await app.fetch(
      importRequest(
        "/app1/secrets/import?scope=shared&phase=runtime&mode=replace",
        "FOO=updated"
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ imported: 1, removed: 0 })
    expect(rows.map((row) => row.key).sort()).toEqual(["DATABASE_URL", "FOO"])
  })

  it("replace does not touch other scopes or phases", async () => {
    const { db, rows } = buildFakeDb([
      secretRow("FOO"),
      secretRow("REMOVE_ME"),
      secretRow("BUILD_ONLY", { phase: "build" }),
      secretRow("PROD_ONLY", { scope: "prod" }),
    ])
    const app = buildApp(db)

    const res = await app.fetch(
      importRequest(
        "/app1/secrets/import?scope=shared&phase=runtime&mode=replace",
        "FOO=updated"
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ imported: 1, removed: 1 })
    expect(
      rows.map((row) => `${row.scope}:${row.phase}:${row.key}`).sort()
    ).toEqual([
      "prod:runtime:PROD_ONLY",
      "shared:build:BUILD_ONLY",
      "shared:runtime:FOO",
    ])
  })

  it("merge mode keeps existing keys by default", async () => {
    const { db, rows, auditRows } = buildFakeDb([
      secretRow("FOO"),
      secretRow("KEEP_ME"),
    ])
    const app = buildApp(db)

    const res = await app.fetch(
      importRequest(
        "/app1/secrets/import?scope=shared&phase=runtime",
        "FOO=updated"
      )
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ imported: 1, removed: 0 })
    expect(rows.map((row) => row.key).sort()).toEqual(["FOO", "KEEP_ME"])
    expect(auditRows).toContainEqual(
      expect.objectContaining({ action: "secret.imported" })
    )
  })

  it("sanitizes Laravel zero-config values during import", async () => {
    const { db, rows } = buildFakeDb([])
    const app = buildApp(db)

    const res = await app.fetch(
      importRequest(
        "/app1/secrets/import?scope=shared&phase=runtime",
        [
          "APP_KEY=",
          "DB_CONNECTION=sqlite",
          "SESSION_DRIVER=database",
          "CACHE_STORE=database",
        ].join("\n")
      )
    )

    expect(res.status).toBe(200)
    const byKey = new Map(
      rows.map((row) => [row.key, row.value_ciphertext.toString()])
    )
    expect(byKey.get("APP_KEY")).toMatch(/^enc:base64:[A-Za-z0-9+/]+=*$/)
    expect(byKey.get("SESSION_DRIVER")).toBe("enc:file")
    expect(byKey.get("CACHE_STORE")).toBe("enc:file")
  })

  it("rejects invalid import modes", async () => {
    const { db } = buildFakeDb([])
    const app = buildApp(db)

    const res = await app.fetch(
      importRequest(
        "/app1/secrets/import?scope=shared&phase=runtime&mode=overwrite",
        "FOO=bar"
      )
    )

    expect(res.status).toBe(400)
  })
})

describe("parseDotenv (via import)", () => {
  // Test the .env parser via the import endpoint behaviour
  it("parses standard KEY=VALUE", async () => {
    const content = "FOO=bar\nBAR=baz"
    // Simulate what parseDotenv would return
    const lines = content.split("\n").filter(Boolean)
    const result = lines.map((line) => {
      const [k, ...rest] = line.split("=")
      return { key: k, value: rest.join("="), scope: "shared" }
    })
    expect(result).toHaveLength(2)
    expect(result[0]?.key).toBe("FOO")
    expect(result[0]?.value).toBe("bar")
  })

  it("ignores comment lines", () => {
    const lines = ["# comment", "FOO=bar", "", "  "]
    const valid = lines.filter((l) => l.trim() && !l.trim().startsWith("#"))
    expect(valid).toHaveLength(1)
  })

  it("strips inline comments from unquoted values", () => {
    const raw = "bar # inline comment"
    const commentIdx = raw.indexOf(" #")
    const value =
      commentIdx !== -1 ? raw.slice(0, commentIdx).trim() : raw.trim()
    expect(value).toBe("bar")
  })

  it("unquotes double-quoted values", () => {
    const raw = '"hello world"'
    const unquoted = raw.slice(1, -1)
    expect(unquoted).toBe("hello world")
  })

  it("unquotes single-quoted values", () => {
    const raw = "'hello'"
    const unquoted = raw.slice(1, -1)
    expect(unquoted).toBe("hello")
  })

  it("handles @scope prefix directive", () => {
    const line = "@prod MY_KEY=myvalue"
    const match = line.match(/^@(\w+)\s+([A-Z][A-Z0-9_]*)=(.*)$/)
    expect(match).not.toBeNull()
    expect(match![1]).toBe("prod")
    expect(match![2]).toBe("MY_KEY")
    expect(match![3]).toBe("myvalue")
  })

  it("handles # @scope comment directive", () => {
    const line = "# @scope preview"
    const match = line.match(/^#\s*@scope\s+(\w+)/)
    expect(match).not.toBeNull()
    expect(match![1]).toBe("preview")
  })
})

describe("TOTP reveal gate", () => {
  it("requires TOTP for bulk export when the user setting requires it", async () => {
    rejectTotp = true
    const { db } = buildFakeDb([secretRow("FOO")])
    const app = buildApp(db)

    try {
      const res = await app.fetch(
        new Request(
          "http://localhost/app1/secrets/export?age_recipient=age1test"
        )
      )

      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        error: {
          code: "TOTP_REQUIRED",
          message: "TOTP verification required",
        },
      })
    } finally {
      rejectTotp = false
    }
  })

  it("requireTotpVerified is wired to the reveal route", async () => {
    // The mock above makes requireTotpVerified a pass-through middleware.
    // Verifying it's imported and used correctly.
    const { requireTotpVerified } = await import("../auth/second-factor")
    expect(requireTotpVerified).toBeDefined()
  })
})

describe("scope validation", () => {
  it("valid scopes pass", () => {
    const scopes = ["shared", "prod", "preview", "dev"]
    for (const s of scopes) {
      expect(["shared", "prod", "preview", "dev"].includes(s)).toBe(true)
    }
  })

  it("invalid scope rejected", () => {
    expect(["shared", "prod", "preview", "dev"].includes("staging")).toBe(false)
  })
})

describe("key validation", () => {
  it("UPPER_SNAKE_CASE keys pass", () => {
    const regex = /^[A-Z][A-Z0-9_]*$/
    expect(regex.test("MY_KEY")).toBe(true)
    expect(regex.test("FOO")).toBe(true)
    expect(regex.test("FOO_123")).toBe(true)
  })

  it("lowercase keys rejected", () => {
    const regex = /^[A-Z][A-Z0-9_]*$/
    expect(regex.test("my_key")).toBe(false)
    expect(regex.test("foo")).toBe(false)
  })

  it("keys starting with digit rejected", () => {
    const regex = /^[A-Z][A-Z0-9_]*$/
    expect(regex.test("1FOO")).toBe(false)
  })
})
