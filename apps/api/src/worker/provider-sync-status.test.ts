// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import type { AuthUser } from "../auth/middleware"
import * as database from "@ploydok/db"

const receipts = new Map<string, Record<string, string>>()
const expirations = new Map<string, number>()
mock.module("@ploydok/db", () => ({
  ...database,
  createRedis: () => ({
    multi() {
      const transaction = {
        hset(key: string, target: string, value: string) {
          receipts.set(key, { ...receipts.get(key), [target]: value })
          return transaction
        },
        expire(key: string, seconds: number) {
          expirations.set(key, seconds)
          return transaction
        },
        async exec() {
          return []
        },
      }
      return transaction
    },
    async hgetall(key: string) {
      return receipts.get(key) ?? {}
    },
  }),
}))

const { writeSyncTargetStatus, readSyncStatus } =
  await import("./provider-sync-status")
const { eventsRouter } = await import("../routes/events")

beforeEach(() => {
  receipts.clear()
  expirations.clear()
})

test("retains completed receipts for late subscribers and isolates users and sync IDs", async () => {
  await writeSyncTargetStatus("owner", "sync", "github-42", {
    status: "done",
    totalRepos: 13,
  })
  expect(await readSyncStatus("owner", "sync")).toEqual({
    status: "done",
    totalRepos: 13,
  })
  expect(await readSyncStatus("other", "sync")).toBeNull()
  expect(await readSyncStatus("owner", "other")).toBeNull()
  expect([...expirations.values()]).toEqual([86_400])
})

test("waits for every installation and sums results including empty snapshots", async () => {
  await writeSyncTargetStatus("owner", "sync", "github-42", {
    status: "done",
    totalRepos: 13,
  })
  await writeSyncTargetStatus("owner", "sync", "github-99", {
    status: "running",
  })
  expect(await readSyncStatus("owner", "sync")).toEqual({
    status: "running",
    totalRepos: 13,
  })
  await writeSyncTargetStatus("owner", "sync", "github-99", {
    status: "done",
    totalRepos: 0,
  })
  expect(await readSyncStatus("owner", "sync")).toEqual({
    status: "done",
    totalRepos: 13,
  })
})

test("reconciles GitLab failures without an SSE event", async () => {
  await writeSyncTargetStatus("owner", "sync", "gitlab-owner", {
    status: "error",
    error: "Token revoked",
  })
  expect(await readSyncStatus("owner", "sync")).toEqual({
    status: "error",
    totalRepos: 0,
    error: "Token revoked",
  })
})

test("status endpoint requires authentication and returns only the caller's receipt", async () => {
  await writeSyncTargetStatus("owner", "sync", "github-42", {
    status: "done",
    totalRepos: 13,
  })
  expect((await eventsRouter.request("/provider-sync/sync")).status).toBe(401)
  const app = new Hono<{ Variables: { user?: AuthUser } }>()
  app.use("*", async (c, next) => {
    c.set("user", { id: c.req.header("test-user") } as AuthUser)
    await next()
  })
  app.route("/events", eventsRouter)
  expect(
    (
      await app.request("/events/provider-sync/sync", {
        headers: { "test-user": "other" },
      })
    ).status
  ).toBe(404)
  const response = await app.request("/events/provider-sync/sync", {
    headers: { "test-user": "owner" },
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: "done", totalRepos: 13 })
})
