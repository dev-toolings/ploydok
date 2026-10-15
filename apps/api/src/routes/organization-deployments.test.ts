// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import {
  OrganizationDeploymentActivityResponseSchema,
  OrganizationDeploymentsResponseSchema,
} from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"

const user: AuthUser = {
  id: "user-1",
  email: "user@example.test",
  display_name: "User One",
  session_id: "session-1",
}

let accessibleOrganization: { id: string; slug: string } | null = {
  id: "org-1",
  slug: "workspace-one",
}
let membershipRole: "owner" | "member" = "owner"
let listCalls: Array<{ organizationId: string; options: unknown }> = []
let activityCalls: Array<{ organizationId: string; since: Date }> = []
let activityRows: Array<{ day: string; status: string; total: number }> = []
let listResult: {
  deployments: unknown[]
  total: number
  summary: Record<string, number>
} = {
  deployments: [],
  total: 0,
  summary: {
    total: 0,
    pending: 0,
    running: 0,
    succeeded: 0,
    succeededWithWarning: 0,
    failed: 0,
    cancelled: 0,
  },
}

mock.module("../services/organizations", () => ({
  getOrganizationBySlugForUser: async (
    _db: unknown,
    userId: string,
    slug: string
  ) =>
    userId === user.id && slug === accessibleOrganization?.slug
      ? {
          id: accessibleOrganization.id,
          name: "Workspace One",
          slug: accessibleOrganization.slug,
          is_default: false,
          created_at: new Date().toISOString(),
        }
      : null,
}))

mock.module("@ploydok/db/queries", () => ({
  getMembership: async () => ({
    role: membershipRole,
    accepted_at: new Date(),
  }),
  listOrganizationDeployments: async (
    _db: unknown,
    organizationId: string,
    options: unknown
  ) => {
    listCalls.push({ organizationId, options })
    return listResult
  },
  listOrganizationDeploymentActivity: async (
    _db: unknown,
    organizationId: string,
    since: Date
  ) => {
    activityCalls.push({ organizationId, since })
    return activityRows
  },
}))

async function buildApp(authedUser?: AuthUser) {
  const { createOrganizationDeploymentsRouter } =
    await import("./organization-deployments")
  const app = new Hono()
  app.use("*", async (c, next) => {
    if (authedUser) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(c as any).set("user", authedUser)
    }
    await next()
  })
  app.route("/organizations", createOrganizationDeploymentsRouter({} as any))
  return app
}

function reset() {
  accessibleOrganization = { id: "org-1", slug: "workspace-one" }
  membershipRole = "owner"
  listCalls = []
  activityCalls = []
  activityRows = []
  listResult = {
    deployments: [],
    total: 0,
    summary: {
      total: 0,
      pending: 0,
      running: 0,
      succeeded: 0,
      succeededWithWarning: 0,
      failed: 0,
      cancelled: 0,
    },
  }
}

describe("GET /organizations/:orgSlug/deployments", () => {
  it("requires authentication", async () => {
    reset()
    const app = await buildApp()

    const response = await app.request(
      "/organizations/workspace-one/deployments"
    )

    expect(response.status).toBe(401)
    expect(listCalls).toHaveLength(0)
  })

  it("requires apps:read for PAT-authenticated requests", async () => {
    reset()
    const app = await buildApp({ ...user, token_scopes: ["databases:read"] })

    const response = await app.request(
      "/organizations/workspace-one/deployments"
    )

    expect(response.status).toBe(403)
    expect(listCalls).toHaveLength(0)
  })

  it("returns 404 and never queries builds outside the member workspace", async () => {
    reset()
    const app = await buildApp(user)

    const response = await app.request(
      "/organizations/workspace-two/deployments"
    )

    expect(response.status).toBe(404)
    expect(listCalls).toHaveLength(0)
  })

  it("scopes the query to the resolved organization and serializes deployments", async () => {
    reset()
    listResult = {
      deployments: [
        {
          build: {
            id: "build-org-1",
            app_id: "app-org-1",
            status: "succeeded",
            build_method: "dockerfile",
            image_tag: null,
            container_id: null,
            runtime_ref: null,
            commit_sha: "abcdef",
            commit_message: "Ship workspace deployments",
            error_message: null,
            post_deploy_error: null,
            requested_by_user_id: "user-1",
            source: "api",
            started_at: new Date("2026-01-01T10:00:00.000Z"),
            finished_at: new Date("2026-01-01T10:01:00.000Z"),
            created_at: new Date("2026-01-01T10:00:00.000Z"),
          },
          app: { id: "app-org-1", name: "API", slug: "api" },
        },
      ],
      total: 1,
      summary: {
        total: 1,
        pending: 0,
        running: 0,
        succeeded: 1,
        succeededWithWarning: 0,
        failed: 0,
        cancelled: 0,
      },
    }
    const app = await buildApp(user)

    const response = await app.request(
      "/organizations/workspace-one/deployments"
    )
    const body = (await response.json()) as {
      deployments: Array<{ app: { id: string }; createdAt: number }>
      pagination: {
        page: number
        pageSize: number
        total: number
        totalPages: number
        hasNext: boolean
      }
      canManage: boolean
    }

    expect(response.status).toBe(200)
    OrganizationDeploymentsResponseSchema.parse(body)
    expect(listCalls).toEqual([
      {
        organizationId: "org-1",
        options: { page: 1, pageSize: 20 },
      },
    ])
    expect(body.deployments).toHaveLength(1)
    expect(body.deployments[0]?.app.id).toBe("app-org-1")
    expect(body.deployments[0]?.createdAt).toBe(
      new Date("2026-01-01T10:00:00.000Z").getTime()
    )
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
      hasNext: false,
    })
    expect(body.canManage).toBe(true)
  })

  it("passes validated filters and computes pagination", async () => {
    reset()
    listResult = {
      ...listResult,
      total: 43,
      summary: { ...listResult.summary, total: 43, failed: 4 },
    }
    const app = await buildApp(user)
    const response = await app.request(
      "/organizations/workspace-one/deployments?page=2&pageSize=25&appId=app-1&status=failed&source=api&q=fix&from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-31T00%3A00%3A00.000Z"
    )
    const body = (await response.json()) as {
      pagination: {
        page: number
        pageSize: number
        total: number
        totalPages: number
        hasNext: boolean
      }
    }

    expect(response.status).toBe(200)
    expect(listCalls[0]).toEqual({
      organizationId: "org-1",
      options: {
        page: 2,
        pageSize: 25,
        appId: "app-1",
        status: "failed",
        source: "api",
        q: "fix",
        from: new Date("2026-01-01T00:00:00.000Z"),
        to: new Date("2026-01-31T00:00:00.000Z"),
      },
    })
    expect(body.pagination).toEqual({
      page: 2,
      pageSize: 25,
      total: 43,
      totalPages: 2,
      hasNext: false,
    })
  })

  it("marks member workspaces read-only for mutating UI actions", async () => {
    reset()
    membershipRole = "member"
    const app = await buildApp(user)
    const response = await app.request(
      "/organizations/workspace-one/deployments"
    )
    const body = (await response.json()) as { canManage: boolean }

    expect(response.status).toBe(200)
    expect(body.canManage).toBe(false)
  })

  it("rejects invalid filter values before querying", async () => {
    reset()
    const app = await buildApp(user)

    const response = await app.request(
      "/organizations/workspace-one/deployments?page=0&status=unknown"
    )

    expect(response.status).toBe(400)
    expect(listCalls).toHaveLength(0)
  })
})

describe("GET /organizations/:orgSlug/deployments/activity", () => {
  it("returns one zero-filled bucket per day and folds statuses", async () => {
    reset()
    const today = new Date().toISOString().slice(0, 10)
    activityRows = [
      { day: today, status: "succeeded", total: 2 },
      { day: today, status: "succeeded_with_warning", total: 1 },
      { day: today, status: "failed", total: 3 },
      { day: today, status: "cancelled", total: 1 },
      { day: "1999-01-01", status: "failed", total: 9 },
    ]
    const app = await buildApp(user)

    const response = await app.request(
      "/organizations/workspace-one/deployments/activity?days=7"
    )

    expect(response.status).toBe(200)
    const body = OrganizationDeploymentActivityResponseSchema.parse(
      await response.json()
    )
    expect(body.days).toBe(7)
    expect(body.buckets).toHaveLength(7)
    expect(body.buckets.at(-1)).toEqual({
      date: today,
      succeeded: 3,
      failed: 3,
      other: 1,
    })
    expect(body.buckets.slice(0, 6).every((b) => b.failed === 0)).toBe(true)
    expect(activityCalls[0]?.organizationId).toBe("org-1")
    expect(activityCalls[0]?.since.toISOString().slice(0, 10)).toBe(
      body.buckets[0]?.date
    )
  })

  it("rejects ranges other than 7, 30 or 90 days", async () => {
    reset()
    const app = await buildApp(user)

    const response = await app.request(
      "/organizations/workspace-one/deployments/activity?days=14"
    )

    expect(response.status).toBe(400)
    expect(activityCalls).toHaveLength(0)
  })

  it("returns 404 outside the member workspace", async () => {
    reset()
    const app = await buildApp(user)

    const response = await app.request(
      "/organizations/other-workspace/deployments/activity"
    )

    expect(response.status).toBe(404)
    expect(activityCalls).toHaveLength(0)
  })
})
