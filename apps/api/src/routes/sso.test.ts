// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock } from "bun:test"
import type { Db } from "@ploydok/db"
import { createSSORouter } from "./sso"

const FREE_PLAN = {
  slug: "free",
  features: {
    sso: false,
    whitelabel: false,
    caddy_override: false,
    audit_logs: true,
    s3_backups: true,
  },
  quotas: {
    apps_count: 3,
    services_count: 3,
    members_count: 3,
  },
}

function mockDb(opts: { project?: { id: string; slug: string } | null }): Db {
  const project =
    opts.project === undefined ? { id: "uuid-ent", slug: "acme" } : opts.project

  return {
    query: {
      projects: {
        findFirst: mock(() => project),
      },
      org_subscriptions: {
        findFirst: mock(() =>
          project ? { org_id: project.id, plan_slug: "free" } : null
        ),
      },
      billing_plans: {
        findFirst: mock(() => FREE_PLAN),
      },
    },
  } as unknown as Db
}

const MUTATING: Array<{ method: string; path: string }> = [
  { method: "POST", path: "/orgs/acme/sso-configs" },
  { method: "PATCH", path: "/orgs/acme/sso-configs" },
  { method: "DELETE", path: "/orgs/acme/sso-configs" },
  { method: "POST", path: "/orgs/acme/sso-configs/test" },
]

describe("SSO mutating routes", () => {
  for (const { method, path } of MUTATING) {
    it(`${method} ${path} returns 403 when sso is not on the plan`, async () => {
      const router = createSSORouter(mockDb({}))
      const res = await router.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({}),
      })

      expect(res.status).toBe(403)
      const body = (await res.json()) as { feature?: string; error?: string }
      expect(body.feature).toBe("sso")
    })
  }

  it("POST /orgs/:slug/sso-configs returns 404 for an unknown slug", async () => {
    const router = createSSORouter(mockDb({ project: null }))
    const res = await router.request("/orgs/missing/sso-configs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("Organization not found")
  })
})
