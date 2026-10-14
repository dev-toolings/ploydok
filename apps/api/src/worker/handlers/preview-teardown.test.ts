// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, mock } from "bun:test"

const queryMocks = {
  getPreviewDeployment: mock(async () => ({
    id: "app-1:pr-7",
    container_id: "preview-container-7",
  })),
  updatePreviewDeployment: mock(async (_db: unknown, _id: string, _patch: Record<string, unknown>) => {}),
}

const caddy = {
  removeRoute: mock(async () => {}),
}

const agent = {
  containerStop: mock(async () => ({})),
  containerRemove: mock(async () => ({})),
}

mock.module("@ploydok/db/queries", () => queryMocks)
mock.module("../../debug/singletons", () => ({
  getSharedCaddy: mock(() => caddy),
  getSharedAgent: mock(() => agent),
}))

describe("handlePreviewTeardown", () => {
  beforeEach(() => {
    queryMocks.getPreviewDeployment.mockClear()
    queryMocks.updatePreviewDeployment.mockClear()
    caddy.removeRoute.mockClear()
    agent.containerStop.mockClear()
    agent.containerRemove.mockClear()
  })

  it("removes route, container and marks the preview as torn down", async () => {
    const { handlePreviewTeardown } = await import("./preview-teardown")
    await handlePreviewTeardown({} as never, {
      appId: "app-1",
      prNumber: 7,
    })

    expect(caddy.removeRoute).toHaveBeenCalledWith("preview-app-1-app-1-pr-7")
    expect(agent.containerStop).toHaveBeenCalledWith(
      expect.objectContaining({ containerId: "preview-container-7" })
    )
    expect(queryMocks.updatePreviewDeployment).toHaveBeenCalledWith(
      expect.anything(),
      "app-1:pr-7",
      expect.objectContaining({ status: "torn_down", container_id: null })
    )

  })
})

it.each(["containerStop", "containerRemove"] as const)("propagates %s failures, preserves the reference and completes on retry", async (method) => {
  const { handlePreviewTeardown } = await import("./preview-teardown")
  queryMocks.updatePreviewDeployment.mockClear()
  agent[method].mockRejectedValueOnce(new Error("agent unavailable"))
  await expect(handlePreviewTeardown({} as never, { appId: "app-1", prNumber: 7 })).rejects.toThrow("agent unavailable")
  expect(queryMocks.updatePreviewDeployment.mock.calls.map(call => call[2])).toEqual([{ status: "tearing_down" }])
  await handlePreviewTeardown({} as never, { appId: "app-1", prNumber: 7 })
  expect(agent.containerRemove).toHaveBeenLastCalledWith(expect.objectContaining({ containerId: "preview-container-7" }))
  expect(queryMocks.updatePreviewDeployment).toHaveBeenLastCalledWith(expect.anything(), "app-1:pr-7", { status: "torn_down", container_id: null })
})

it("treats agent NotFound as an idempotent completed teardown", async () => {
  const { handlePreviewTeardown } = await import("./preview-teardown")
  const notFound = Object.assign(new Error("gone"), { code: 5, details: "not found" })
  agent.containerStop.mockRejectedValueOnce(notFound)
  agent.containerRemove.mockRejectedValueOnce(notFound)
  await handlePreviewTeardown({} as never, { appId: "app-1", prNumber: 7 })
  expect(queryMocks.updatePreviewDeployment).toHaveBeenLastCalledWith(expect.anything(), "app-1:pr-7", { status: "torn_down", container_id: null })
})
