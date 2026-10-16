// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { Db } from "@ploydok/db"
import type { AuthUser } from "../auth/middleware"

let snapshots = 0
mock.module("../services/request-logs", () => ({
  runtimeLogSource: (value?: string) =>
    value === undefined || value === "app"
      ? "app"
      : ["requests", "all"].includes(value)
        ? value
        : null,
  getRequestLogs: () => ({
    snapshot: async () => {
      snapshots++
      return [{ t: 1, kind: "request", line: "GET /menu 200 12 ms" }]
    },
  }),
}))
const { createAppsRouter } = await import("./apps")
afterAll(() => mock.restore())

function client(
  membership: "owner" | "member" | "foreign",
  authenticated = true
) {
  let query = 0
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => {
      query++
      // getAppForUser allows members, getAppForOwner requires ownership.
      if (membership === "foreign" || (query > 1 && membership !== "owner"))
        return []
      return [{ app: { id: "app-a", container_id: null } }]
    },
  }
  const db = { select: () => chain } as unknown as Db
  const app = new Hono<{ Variables: { user: AuthUser } }>()
  app.use("*", async (c, next) => {
    if (authenticated)
      c.set("user", {
        id: "caller",
        email: "test@example.invalid",
        display_name: "Test",
        session_id: "test",
      })
    await next()
  })
  app.route("/apps", createAppsRouter(db))
  return app
}

describe("HTTP request log source authorization", () => {
  for (const source of ["requests", "all"]) {
    it(`${source} rejects foreign users and non-owner members before opening Caddy logs`, async () => {
      const before = snapshots
      for (const membership of ["foreign", "member"] as const) {
        const response = await client(membership).request(
          `/apps/app-a/runtime-logs?source=${source}`
        )
        expect(response.status).toBe(404)
      }
      expect(snapshots).toBe(before)
    })
  }
  it("allows an owner to read sanitized requests without an app container", async () => {
    const response = await client("owner").request(
      "/apps/app-a/runtime-logs?source=requests"
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      containerFound: true,
      lines: [{ kind: "request" }],
    })
  })
  it("rejects missing authentication and invalid sources without opening logs", async () => {
    const before = snapshots
    expect(
      (
        await client("owner", false).request(
          "/apps/app-a/runtime-logs?source=requests"
        )
      ).status
    ).toBe(401)
    expect(
      (await client("owner").request("/apps/app-a/runtime-logs?source=raw"))
        .status
    ).toBe(400)
    expect(snapshots).toBe(before)
  })
})
