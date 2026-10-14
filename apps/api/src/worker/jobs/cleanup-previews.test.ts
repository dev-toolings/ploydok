// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, mock } from "bun:test"

const events: string[] = []
const update = mock(async (_db: unknown, _id: string, status: string) => { events.push(status) })
const add = mock(async () => { events.push("queued") })
mock.module("@ploydok/db/queries", () => ({
  listExpiredPreviews: async () => [{ id: "app-1:pr-7", app_id: "app-1", pr_number: 7 }],
  updatePreviewDeploymentStatus: update,
}))
mock.module("../queues", () => ({ previewTeardown: { add } }))
const { cleanupExpiredPreviews } = await import("./cleanup-previews")

test("cleanup keeps the reference and marks tearing_down before enqueue, never terminal success", async () => {
  await cleanupExpiredPreviews({} as never)
  expect(events).toEqual(["tearing_down", "queued"])
  expect(add).toHaveBeenCalledWith("preview.teardown", { appId: "app-1", prNumber: 7 })
})
