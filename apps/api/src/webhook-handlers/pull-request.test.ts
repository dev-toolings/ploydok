// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, test, mock } from "bun:test"
const app = mock(async (): Promise<unknown> => null)
const enqueue = mock(async (..._args: any[]) => ({}))
mock.module("@ploydok/db/queries", () => ({ getAppByRepoAndOwner: app }))
mock.module("../worker/queues", () => ({
  previewDeploy: { name: "preview.deploy" }, previewTeardown: { name: "preview.teardown" },
}))
mock.module("../worker/preview-intents", () => ({ enqueuePreviewIntent: enqueue }))
const { handlePullRequest } = await import("./pull-request")
beforeEach(() => { app.mockReset(); enqueue.mockClear() })
const fixture = { id: "app-fixture", slug: "docs", preview_enabled: true, preview_wildcard: "preview.example.test", preview_ttl_days: 5 }
const request = (action: string) => ({ action, pull_request: { number: 42, head: { sha: "sha-one" } }, repository: { full_name: "acme/docs" } })
test("opened enqueues the preview row and immutable deploy intent together", async () => {
  app.mockResolvedValue(fixture)
  await handlePullRequest({} as never, request("opened"), "delivery-one")
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(enqueue.mock.calls[0]![2]).toMatchObject({
    action: "deploy", appId: "app-fixture", prNumber: 42, headSha: "sha-one",
    domain: "pr-42.preview.example.test", source: "webhook:pull_request",
  })
})
test("closed retains durable teardown even after previews are disabled", async () => {
  app.mockResolvedValue({ ...fixture, preview_enabled: false })
  await handlePullRequest({} as never, request("closed"), "delivery-two")
  expect(enqueue.mock.calls[0]![2]).toEqual({
    action: "teardown", appId: "app-fixture", prNumber: 42, source: "webhook:pull_request",
  })
})
