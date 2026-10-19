// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { Db } from "@ploydok/db"

const fakeUser = {
  id: "user-1",
  email: "test@example.com",
  display_name: "Test User",
  session_id: "session-1",
}

let deleteImpl: () => Promise<Record<string, unknown>> = async () => ({ ok: true })

let createCalls = 0
let createOrganizationImpl: (
  db: Db,
  userId: string,
  name: string,
  displayName?: string | null
) => Promise<Record<string, unknown>> = async () => ({
  id: "org-2",
  name: "Acme",
  slug: "acme",
  is_default: false,
  created_at: new Date().toISOString(),
})

mock.module("../services/organizations", () => ({
  createOrganizationForUser: async (
    db: Db,
    userId: string,
    name: string,
    displayName?: string | null
  ) => {
    createCalls += 1
    return createOrganizationImpl(db, userId, name, displayName)
  },
  listOrganizationsForUser: async () => [],
  getDefaultOrganizationForUser: async () => ({
    id: "org-1",
    name: "Test User",
    slug: "test-user",
    is_default: true,
    created_at: new Date().toISOString(),
  }),
  getOrganizationBySlugForUser: async () => null,
  deleteOrganizationForUser: async () => deleteImpl(),
  renameOrganizationForUser: async (
    _db: Db,
    slug: string,
    name: string,
    reslug: boolean
  ) => {
    renameCalls.push({ slug, name, reslug })
    return renameImpl(slug, name, reslug)
  },
}))

let renameCalls: Array<{ slug: string; name: string; reslug: boolean }> = []
let renameImpl: (
  slug: string,
  name: string,
  reslug: boolean
) => Promise<Record<string, unknown>> = async (slug, name, reslug) => ({
  ok: true,
  organization: {
    id: "org-1",
    name,
    slug: reslug ? "acme" : slug,
    is_default: true,
    created_at: new Date().toISOString(),
  },
  slug_changed: reslug,
  previous_slug: slug,
  slug_frozen_reason: reslug ? null : "not_requested",
})

let membershipRole: "owner" | "member" | null = "owner"

mock.module("../auth/require-role", () => ({
  requireRole:
    () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (c: any, next: () => Promise<void>) => {
      if (membershipRole !== "owner") {
        return c.json(
          { error: { code: "FORBIDDEN", message: "Owner role required" } },
          403
        )
      }
      return next()
    },
}))

function buildApp(router: Hono) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", fakeUser)
    await next()
  })
  app.route("/organizations", router)
  return app
}

describe("POST /organizations", () => {
  it("returns 400 on invalid payload", async () => {
    createCalls = 0
    const { createOrganizationsRouter } = await import("./organizations")
    const app = buildApp(createOrganizationsRouter({} as Db))

    const res = await app.request("/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    })

    expect(res.status).toBe(400)
    expect(createCalls).toBe(0)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("VALIDATION_ERROR")
  })

  it("creates a workspace and returns 201", async () => {
    createCalls = 0
    createOrganizationImpl = async (_db, userId, name, displayName) => ({
      id: "org-2",
      name,
      slug: "acme",
      is_default: false,
      created_at: new Date().toISOString(),
      _userId: userId,
      _displayName: displayName,
    })

    const { createOrganizationsRouter } = await import("./organizations")
    const app = buildApp(createOrganizationsRouter({} as Db))

    const res = await app.request("/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    })

    expect(res.status).toBe(201)
    expect(createCalls).toBe(1)
    const data = (await res.json()) as {
      organization: {
        name: string
        slug: string
        is_default: boolean
        _userId: string
        _displayName: string | null | undefined
      }
    }
    expect(data.organization.name).toBe("Acme")
    expect(data.organization.slug).toBe("acme")
    expect(data.organization.is_default).toBe(false)
    expect(data.organization._userId).toBe(fakeUser.id)
    expect(data.organization._displayName).toBe(fakeUser.display_name)
  })
})

describe("PATCH /organizations/:slug", () => {
  async function patch(slug: string, body: unknown) {
    const { createOrganizationsRouter } = await import("./organizations")
    const app = buildApp(createOrganizationsRouter({} as Db))
    return app.request(`/organizations/${slug}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("rejects a blank name with 400 and never calls the service", async () => {
    renameCalls = []
    membershipRole = "owner"

    const res = await patch("test-user", { name: "   " })

    expect(res.status).toBe(400)
    expect(renameCalls).toHaveLength(0)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("VALIDATION_ERROR")
  })

  it("rejects a non-owner with 403 before touching the service", async () => {
    renameCalls = []
    membershipRole = "member"

    const res = await patch("test-user", { name: "Acme", reslug: true })

    expect(res.status).toBe(403)
    expect(renameCalls).toHaveLength(0)
  })

  it("renames a pristine workspace and reports the new slug", async () => {
    renameCalls = []
    membershipRole = "owner"

    const res = await patch("test-user", { name: "Acme", reslug: true })

    expect(res.status).toBe(200)
    expect(renameCalls).toEqual([
      { slug: "test-user", name: "Acme", reslug: true },
    ])
    const data = (await res.json()) as {
      organization: { name: string; slug: string }
      slug_changed: boolean
      previous_slug: string
      slug_frozen_reason: string | null
    }
    expect(data.organization.name).toBe("Acme")
    expect(data.organization.slug).toBe("acme")
    expect(data.slug_changed).toBe(true)
    expect(data.previous_slug).toBe("test-user")
    expect(data.slug_frozen_reason).toBeNull()
  })

  it("defaults reslug to false so the URL is kept", async () => {
    renameCalls = []
    membershipRole = "owner"

    const res = await patch("test-user", { name: "Acme" })

    expect(res.status).toBe(200)
    expect(renameCalls[0]?.reslug).toBe(false)
    const data = (await res.json()) as {
      slug_changed: boolean
      slug_frozen_reason: string | null
    }
    expect(data.slug_changed).toBe(false)
    expect(data.slug_frozen_reason).toBe("not_requested")
  })

  it("surfaces a frozen slug on a workspace that is no longer pristine", async () => {
    renameCalls = []
    membershipRole = "owner"
    renameImpl = async (slug, name) => ({
      ok: true,
      organization: {
        id: "org-1",
        name,
        slug,
        is_default: true,
        created_at: new Date().toISOString(),
      },
      slug_changed: false,
      previous_slug: slug,
      slug_frozen_reason: "not_pristine",
    })

    const res = await patch("test-user", { name: "Acme", reslug: true })

    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      organization: { slug: string }
      slug_changed: boolean
      slug_frozen_reason: string | null
    }
    expect(data.organization.slug).toBe("test-user")
    expect(data.slug_changed).toBe(false)
    expect(data.slug_frozen_reason).toBe("not_pristine")
  })

  it("maps an unresolvable slug collision to 409", async () => {
    renameCalls = []
    membershipRole = "owner"
    renameImpl = async () => ({ ok: false, reason: "slug_conflict" })

    const res = await patch("test-user", { name: "Acme", reslug: true })

    expect(res.status).toBe(409)
    const data = (await res.json()) as { error: { code: string } }
    expect(data.error.code).toBe("SLUG_CONFLICT")
  })

  it("maps a missing workspace to 404", async () => {
    renameCalls = []
    membershipRole = "owner"
    renameImpl = async () => ({ ok: false, reason: "not_found" })

    const res = await patch("gone", { name: "Acme" })

    expect(res.status).toBe(404)
  })
})


it("returns 409 when deleting an organization that still has runtime resources", async () => {
  membershipRole = "owner"
  deleteImpl = async () => ({ ok: false, reason: "not_empty" })
  const { createOrganizationsRouter } = await import("./organizations")
  const app = buildApp(createOrganizationsRouter({} as Db))
  const response = await app.request("/organizations/test-user", { method: "DELETE" })
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    error: { code: "ORGANIZATION_NOT_EMPTY" },
  })
})
