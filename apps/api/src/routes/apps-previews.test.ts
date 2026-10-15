// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, mock } from "bun:test"
import { Hono } from "hono"
const app = mock(async (): Promise<unknown> => ({ id: "fixture-app" }))
const enqueue = mock(async (..._args: any[]) => ({}))
mock.module("@ploydok/db/queries", () => ({
  getAppForUser: app, listPreviewDeploymentsForApp: async () => [],
  getPreviewDeploymentByAppAndPr: async () => undefined,
}))
mock.module("../worker/queues", () => ({ previewTeardown: { name: "preview.teardown" } }))
mock.module("../worker/preview-intents", () => ({ enqueuePreviewIntent: enqueue }))
const { createPreviewsRoute } = await import("./apps-previews")
test("manual teardown checks ownership and accepts a durable audited actor reference", async () => {
  const router = new Hono()
  router.use("*", async (c, next) => { c.set("user" as never, { id: "fixture-user" } as never); await next() })
  router.route("/", createPreviewsRoute({} as never))
  let res = await router.request("/fixture-app/previews/7/teardown", { method: "POST" })
  expect(res.status).toBe(200)
  expect(enqueue.mock.calls[0]![2]).toEqual({
    action: "teardown", appId: "fixture-app", prNumber: 7, source: "api", requestedByUserId: "fixture-user",
  })
  app.mockResolvedValue(null)
  res = await router.request("/fixture-app/previews/7/teardown", { method: "POST" })
  expect(res.status).toBe(404)
  expect(enqueue).toHaveBeenCalledTimes(1)
})
