// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, mock } from "bun:test"
const enqueue = mock(async (..._args: any[]) => ({}))
mock.module("@ploydok/db/queries", () => ({
  listExpiredPreviews: async () => [{ id: "app-1:pr-7", app_id: "app-1", pr_number: 7 }],
}))
mock.module("../queues", () => ({ previewTeardown: { name: "preview.teardown" } }))
mock.module("../preview-intents", () => ({ enqueuePreviewIntent: enqueue }))
const { cleanupExpiredPreviews } = await import("./cleanup-previews")
test("cleanup persists teardown intention instead of claiming terminal success", async () => {
  await cleanupExpiredPreviews({} as never)
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(enqueue.mock.calls[0]![2]).toEqual({
    action: "teardown", appId: "app-1", prNumber: 7, source: "cron:preview",
  })
})
