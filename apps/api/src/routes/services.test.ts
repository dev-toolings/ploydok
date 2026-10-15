// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, it, expect, mock } from "bun:test"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json()
}

// ---------------------------------------------------------------------------
// Module mocks (must precede imports that load the modules)
// ---------------------------------------------------------------------------

const mockGetServiceForUser = mock(async () => null as unknown)
const mockGetServiceForOwner = mock(async () => null as unknown)
const mockListServicesForProject = mock(async () => [] as unknown[])
const mockListServicesForOwner = mock(async () => [] as unknown[])
const mockHasRole = mock(async () => false)

mock.module("@ploydok/db/queries", () => ({
  getServiceForUser: mockGetServiceForUser,
  getServiceForOwner: mockGetServiceForOwner,
  listServicesForProject: mockListServicesForProject,
  listServicesForOwner: mockListServicesForOwner,
  hasRole: mockHasRole,
  insertService: mock(async () => ({})),
  updateServiceStatus: mock(async () => {}),
  updateServiceContainers: mock(async () => {}),
  markServiceDeleting: mock(async () => {}),
  uniqueServiceSlug: mock(async () => "my-svc"),
}))

mock.module("@ploydok/db", () => ({
  audit_log: {},
  services: {},
  projects: {},
  createDb: mock(() => ({})),
  eq: mock(() => ({})),
  and: mock(() => ({})),
}))

mock.module("../debug/singletons", () => ({
  getSharedAgent: () => ({
    imagePull: async function* () {},
    containerCreate: async () => ({ containerId: "ctr-1" }),
    containerStart: async () => ({}),
    containerStop: async () => ({}),
    containerRemove: async () => ({}),
    containerLogs: async function* () {},
  }),
  getSharedCaddy: () => ({}),
}))

mock.module("../services/marketplace-orchestrator", () => ({
  installFromTemplate: mock(async () => ({
    id: "svc-1",
    project_id: "proj-1",
    name: "My PB",
    slug: "my-pb",
    template_id: "pocketbase",
    template_version: "0.22.0",
    status: "pending",
    compose_raw: "",
    generated_env: {},
    domain: null,
    container_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
  })),
  startService: mock(async () => {}),
  stopService: mock(async () => {}),
  deleteService: mock(async () => {}),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createServicesRouter } from "./services"
import { Hono } from "hono"
import type { Db } from "@ploydok/db"

beforeEach(() => {
  mockGetServiceForUser.mockReset()
  mockGetServiceForUser.mockResolvedValue(null)
  mockGetServiceForOwner.mockReset()
  mockGetServiceForOwner.mockResolvedValue(null)
  mockListServicesForProject.mockReset()
  mockListServicesForProject.mockResolvedValue([])
  mockListServicesForOwner.mockReset()
  mockListServicesForOwner.mockResolvedValue([])
  mockHasRole.mockReset()
  mockHasRole.mockResolvedValue(false)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_USER = {
  id: "user-1",
  email: "test@example.com",
  display_name: "Test User",
  session_id: "sess-1",
}

function makeApp(db: Db, tokenScopes?: string[]) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", { ...FAKE_USER, ...(tokenScopes ? { token_scopes: tokenScopes } : {}) })
    await next()
  })
  app.route("/services", createServicesRouter(db))
  return app
}

function makeDb(ownerRows: unknown[] = []): Db {
  // thenable array: awaitable AND has .limit()
  function rows(data: unknown[] = []) {
    const p = Promise.resolve(data)
    return Object.assign(p, { limit: mock(async () => data) })
  }
  return {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => rows()),
        innerJoin: mock(() => ({ where: mock(() => rows(ownerRows)) })),
      })),
    })),
    insert: mock(() => ({ values: mock(async () => {}) })),
    update: mock(() => ({
      set: mock(() => ({ where: mock(async () => {}) })),
    })),
    delete: mock(() => ({ where: mock(async () => {}) })),
  } as unknown as Db
}

// ---------------------------------------------------------------------------
// GET /services
// ---------------------------------------------------------------------------

describe("GET /services", () => {
  it("returns empty list when user has no services", async () => {
    // No projectId → all-services path, innerJoin returns []
    const app = makeApp(makeDb())
    const res = await app.request("/services")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(Array.isArray(body.services)).toBe(true)
  })

  it("returns 404 when projectId does not belong to user", async () => {
    // ownership check → empty → 404
    const app = makeApp(makeDb())
    const res = await app.request("/services?projectId=proj-missing")
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("returns services when projectId matches", async () => {
    const fakeSvc = { id: "svc-1" }
    // ownership check (hasRole owner) passes; listServicesForProject returns fakeSvc
    mockHasRole.mockResolvedValueOnce(true)
    mockListServicesForProject.mockResolvedValueOnce([fakeSvc])

    const app = makeApp(makeDb())
    const res = await app.request("/services?projectId=proj-1")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.services).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// GET /services/:id
// ---------------------------------------------------------------------------

describe("GET /services/:id/logs", () => {
  it("returns 404 when the service is missing", async () => {
    mockGetServiceForUser.mockResolvedValueOnce(null)
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-unknown/logs")
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(body.error.code).toBe("NOT_FOUND")
  })

  it("returns an empty snapshot when the service has no containers", async () => {
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      container_ids: [],
    })
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-1/logs")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.containerFound).toBe(false)
    expect(body.lines).toEqual([])
  })
})

describe("GET /services/:id", () => {
  it("returns 404 when service not found", async () => {
    mockGetServiceForUser.mockResolvedValueOnce(null)
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-unknown")
    expect(res.status).toBe(404)
  })

  it("returns service detail when found", async () => {
    const fakeSvc = { id: "svc-1", status: "running" }
    mockGetServiceForUser.mockResolvedValueOnce(fakeSvc)
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-1")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.service.id).toBe("svc-1")
    expect(body.service.status).toBe("running")
  })

  it("keeps the stored domain and derives its instance public URL", async () => {
    const storedDomain = "n8n-abc123.demo.localhost"
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      status: "running",
      domain: storedDomain,
      compose_raw: "services:\n  web:\n    image: nginx",
      generated_env: {},
    })
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-1")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.service.domain).toBe(storedDomain)
    expect(body.service.publicUrl).toBe(
      `http://${storedDomain}:8181`
    )
  })
})

// ---------------------------------------------------------------------------
// POST /services/from-template
// ---------------------------------------------------------------------------

describe("POST /services/from-template", () => {
  it("returns 400 on missing body fields", async () => {
    const app = makeApp(makeDb())
    const res = await app.request("/services/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "proj-1" }),
    })
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error.code).toBe("VALIDATION_ERROR")
  })

  it("returns 201 with pending service on success", async () => {
    const app = makeApp(makeDb())
    const res = await app.request("/services/from-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "proj-1",
        templateId: "pocketbase",
        templateVersion: "0.22.0",
        name: "My PB",
        compose: "services:\n  app:\n    image: pocketbase:latest\n",
      }),
    })
    expect(res.status).toBe(201)
    const body = await json(res)
    expect(body.service.status).toBe("pending")
    expect(body.service.template_id).toBe("pocketbase")
  })
})

// ---------------------------------------------------------------------------
// DELETE /services/:id
// ---------------------------------------------------------------------------

describe("DELETE /services/:id", () => {
  it("returns 404 when service not found", async () => {
    mockGetServiceForUser.mockResolvedValueOnce(null)
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-missing", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "delete My PB" }),
    })
    expect(res.status).toBe(404)
  })

  it("returns 400 when confirm string is wrong", async () => {
    mockGetServiceForOwner.mockResolvedValueOnce({ id: "svc-1" })
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      name: "My PB",
      status: "stopped",
      container_ids: [],
    })
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "wrong" }),
    })
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.error.code).toBe("CONFIRM_REQUIRED")
  })

  it("returns 200 ok when confirm matches", async () => {
    mockGetServiceForOwner.mockResolvedValueOnce({ id: "svc-1" })
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      name: "My PB",
      status: "stopped",
      container_ids: [],
    })
    const app = makeApp(makeDb())
    const res = await app.request("/services/svc-1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "delete My PB" }),
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.ok).toBe(true)
  })
})

describe("service PAT scopes", () => {
  it("rejects every mutation for a read-only PAT before reaching ownership or Docker", async () => {
    const app = makeApp(makeDb(), ["services:read"])
    for (const [method, path] of [["POST", "/services/from-template"], ["POST", "/services/svc-1/start"], ["POST", "/services/svc-1/stop"], ["DELETE", "/services/svc-1"]]) {
      const res = await app.request(path!, { method: method! })
      expect(res.status).toBe(403)
      expect((await json(res)).error.code).toBe("FORBIDDEN")
    }
    expect(mockGetServiceForOwner).not.toHaveBeenCalled()
  })

  it("requires services:read on every read route", async () => {
    const app = makeApp(makeDb(), ["apps:read"])
    for (const path of ["/services", "/services/svc-1", "/services/svc-1/logs"]) {
      expect((await app.request(path)).status).toBe(403)
    }
    expect((await makeApp(makeDb(), ["services:read"]).request("/services")).status).toBe(200)
  })

  it("a write PAT still cannot mutate another owner's service", async () => {
    const app = makeApp(makeDb(), ["services:write"])
    expect((await app.request("/services/svc-other/start", { method: "POST" })).status).toBe(404)
    expect(mockGetServiceForOwner).toHaveBeenCalledWith(expect.anything(), "svc-other", "user-1")
    mockGetServiceForOwner.mockResolvedValueOnce({ id: "svc-1" })
    expect((await app.request("/services/svc-1/start", { method: "POST" })).status).toBe(200)
  })
})

describe("service secret disclosure", () => {
  it("masks generated values on ordinary consultation", async () => {
    mockGetServiceForUser.mockResolvedValue({
      id: "svc-1", compose_raw: "PASSWORD=legacy-secret", generated_env: { password: "legacy-secret" },
    });
    const res = await makeApp({} as Db).request("/services/svc-1");
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("legacy-secret");
  });
});

it("reveals only to owners with write scope and audits before returning plaintext", async () => {
  const { protectServiceSecrets } = await import("../services/service-secrets");
  const protectedValues = await protectServiceSecrets("TOKEN=secret-fixture", { token: "secret-fixture" });
  mockGetServiceForOwner.mockResolvedValue({ id: "svc-1", ...protectedValues });
  const audit: unknown[] = [];
  const db = { insert: () => ({ values: async (value: unknown) => { audit.push(value); } }) } as unknown as Db;
  let res = await makeApp(db, ["services:read"]).request("/services/svc-1/secrets/reveal", { method: "POST" });
  expect(res.status).toBe(403);
  expect(audit).toHaveLength(0);
  res = await makeApp(db, ["services:write"]).request("/services/svc-1/secrets/reveal", { method: "POST" });
  expect(res.status).toBe(200);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ action: "service.secrets.revealed", target_id: "svc-1" });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect((await res.json() as any).secrets.token).toBe("secret-fixture");
  mockGetServiceForOwner.mockResolvedValue(null);
  res = await makeApp(db, ["services:write"]).request("/services/svc-1/secrets/reveal", { method: "POST" });
  expect(res.status).toBe(404);
});
