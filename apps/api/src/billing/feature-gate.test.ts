// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock } from "bun:test"
import {
  requireFeature,
  checkQuota,
  resolveOrganizationId,
} from "./feature-gate"
import type { Db } from "@ploydok/db"

const ENTERPRISE_FEATURES = {
  sso: true,
  whitelabel: true,
  caddy_override: true,
  audit_logs: true,
  s3_backups: true,
}

const FREE_FEATURES = {
  sso: false,
  whitelabel: false,
  caddy_override: false,
  audit_logs: true,
  s3_backups: true,
}

const QUOTAS = {
  apps_count: 3,
  services_count: 3,
  members_count: 3,
}

function mockDb(opts: {
  project?: { id: string; slug: string } | null
  subscription?: { org_id: string; plan_slug: string } | null
  plan?: {
    slug: string
    features: Record<string, boolean>
    quotas: Record<string, number>
  } | null
}): Db {
  const project =
    opts.project === undefined ? { id: "uuid-ent", slug: "acme" } : opts.project
  const subscription =
    opts.subscription === undefined
      ? { org_id: "uuid-ent", plan_slug: "enterprise" }
      : opts.subscription
  const plan =
    opts.plan === undefined
      ? {
          slug: "enterprise",
          features: ENTERPRISE_FEATURES,
          quotas: QUOTAS,
        }
      : opts.plan

  return {
    query: {
      projects: {
        findFirst: mock(() => project),
      },
      org_subscriptions: {
        findFirst: mock(() => subscription),
      },
      billing_plans: {
        findFirst: mock(() => plan),
      },
    },
  } as unknown as Db
}

function mockContext(params: Record<string, string | undefined>) {
  const json = mock((data: unknown, options: unknown) => ({ data, options }))
  const c = {
    req: {
      param: mock((name: string) => params[name]),
    },
    json,
  } as any
  return { c, json }
}

describe("feature-gate", () => {
  describe("resolveOrganizationId", () => {
    it("returns the id when a project exists with that id", async () => {
      const findFirst = mock(async () => ({ id: "uuid-ent", slug: "acme" }))
      const db = {
        query: { projects: { findFirst } },
      } as unknown as Db

      const id = await resolveOrganizationId(db, "uuid-ent")
      expect(id).toBe("uuid-ent")
      expect(findFirst).toHaveBeenCalledTimes(1)
    })

    it("falls back to slug when the id lookup misses", async () => {
      let calls = 0
      const findFirst = mock(async () => {
        calls += 1
        if (calls === 1) return null
        return { id: "uuid-ent", slug: "acme" }
      })
      const db = {
        query: { projects: { findFirst } },
      } as unknown as Db

      const id = await resolveOrganizationId(db, "acme")
      expect(id).toBe("uuid-ent")
      expect(findFirst).toHaveBeenCalledTimes(2)
    })

    it("returns null when neither id nor slug matches", async () => {
      const findFirst = mock(async () => null)
      const db = {
        query: { projects: { findFirst } },
      } as unknown as Db

      expect(await resolveOrganizationId(db, "missing")).toBeNull()
      expect(findFirst).toHaveBeenCalledTimes(2)
    })
  })

  describe("requireFeature middleware", () => {
    it("calls next() when a slug resolves to an org with the feature", async () => {
      const middleware = requireFeature(mockDb({}), "sso")
      const { c, json } = mockContext({ slug: "acme" })
      let nextCalled = false

      await middleware(c, async () => {
        nextCalled = true
      })

      expect(nextCalled).toBe(true)
      expect(json).not.toHaveBeenCalled()
    })

    it("calls next() when the identifier is already a project UUID", async () => {
      const middleware = requireFeature(mockDb({}), "sso")
      const { c, json } = mockContext({ slug: "uuid-ent" })
      let nextCalled = false

      await middleware(c, async () => {
        nextCalled = true
      })

      expect(nextCalled).toBe(true)
      expect(json).not.toHaveBeenCalled()
    })

    it("reads the orgSlug route param", async () => {
      const middleware = requireFeature(mockDb({}), "sso")
      const { c, json } = mockContext({ orgSlug: "acme" })
      let nextCalled = false

      await middleware(c, async () => {
        nextCalled = true
      })

      expect(nextCalled).toBe(true)
      expect(json).not.toHaveBeenCalled()
    })

    it("returns 403 when the resolved org's plan does not include the feature", async () => {
      const middleware = requireFeature(
        mockDb({
          subscription: { org_id: "uuid-ent", plan_slug: "free" },
          plan: {
            slug: "free",
            features: FREE_FEATURES,
            quotas: QUOTAS,
          },
        }),
        "sso"
      )
      const { c, json } = mockContext({ slug: "acme" })
      let nextCalled = false

      await middleware(c, async () => {
        nextCalled = true
      })

      expect(nextCalled).toBe(false)
      expect(json).toHaveBeenCalledWith(
        {
          error: "Feature sso is not available in your plan",
          feature: "sso",
        },
        { status: 403 }
      )
    })

    it("returns 404 when the slug does not match an organization", async () => {
      const middleware = requireFeature(
        mockDb({ project: null, subscription: null }),
        "sso"
      )
      const { c, json } = mockContext({ slug: "missing-org" })
      let nextCalled = false

      await middleware(c, async () => {
        nextCalled = true
      })

      expect(nextCalled).toBe(false)
      expect(json).toHaveBeenCalledWith(
        { error: "Organization not found" },
        { status: 404 }
      )
    })

    it("returns 400 when no organization identifier is present", async () => {
      const middleware = requireFeature(mockDb({}), "sso")
      const { c, json } = mockContext({})
      let nextCalled = false

      await middleware(c, async () => {
        nextCalled = true
      })

      expect(nextCalled).toBe(false)
      expect(json).toHaveBeenCalledWith(
        { error: "Missing organization identifier" },
        { status: 400 }
      )
    })
  })

  describe("checkQuota", () => {
    it("returns true when usage is below limit", async () => {
      const db = mockDb({
        subscription: null,
        plan: {
          slug: "free",
          features: FREE_FEATURES,
          quotas: QUOTAS,
        },
      })

      const result = await checkQuota(db, "org-123", "apps_count", 2)
      expect(result).toBe(true)
    })

    it("returns false when usage meets limit", async () => {
      const db = mockDb({
        subscription: null,
        plan: {
          slug: "free",
          features: FREE_FEATURES,
          quotas: QUOTAS,
        },
      })

      const result = await checkQuota(db, "org-123", "apps_count", 3)
      expect(result).toBe(false)
    })
  })
})
