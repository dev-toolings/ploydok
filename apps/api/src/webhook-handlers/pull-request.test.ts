// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, mock } from "bun:test"

const getAppByRepoAndOwnerMock = mock(async (): Promise<unknown> => null)
const getPreviewDeploymentByAppAndPrMock = mock(
  async (): Promise<unknown> => undefined
)
const updatePreviewDeploymentMock = mock(async () => undefined)
const insertPreviewDeploymentMock = mock(async () => undefined)
const previewDeployAddMock = mock(async () => undefined)
const previewTeardownAddMock = mock(async () => undefined)

mock.module("@ploydok/db/queries", () => ({
  getAppByRepoAndOwner: getAppByRepoAndOwnerMock,
  getPreviewDeploymentByAppAndPr: getPreviewDeploymentByAppAndPrMock,
  updatePreviewDeployment: updatePreviewDeploymentMock,
  insertPreviewDeployment: insertPreviewDeploymentMock,
}))

mock.module("../worker/queues", () => ({
  previewDeploy: { add: previewDeployAddMock },
  previewTeardown: { add: previewTeardownAddMock },
}))

import { handlePullRequest } from "./pull-request"

const db = {} as Parameters<typeof handlePullRequest>[0]

const previewEnabledApp = {
  id: "app-preview-1",
  slug: "docs",
  preview_enabled: true,
  preview_wildcard: "preview.example.com",
  preview_ttl_days: 5,
}

beforeEach(() => {
  getAppByRepoAndOwnerMock.mockReset()
  getPreviewDeploymentByAppAndPrMock.mockReset()
  updatePreviewDeploymentMock.mockReset()
  insertPreviewDeploymentMock.mockReset()
  previewDeployAddMock.mockReset()
  previewTeardownAddMock.mockReset()
})

describe("handlePullRequest", () => {
  it("creates a preview row and enqueues preview deploy on PR opened", async () => {
    getAppByRepoAndOwnerMock.mockResolvedValue(previewEnabledApp)
    getPreviewDeploymentByAppAndPrMock.mockResolvedValue(undefined)

    await handlePullRequest(
      db,
      {
        action: "opened",
        pull_request: { number: 42, head: { sha: "deadbeef" } },
        repository: { full_name: "acme/docs" },
        installation: { id: 7 },
      },
      "delivery-opened"
    )

    expect(getAppByRepoAndOwnerMock).toHaveBeenCalledWith(db, "acme/docs")
    expect(insertPreviewDeploymentMock).toHaveBeenCalledTimes(1)
    expect(updatePreviewDeploymentMock).not.toHaveBeenCalled()
    const insertCall = insertPreviewDeploymentMock.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ]
    expect(insertCall[1]).toMatchObject({
      id: "app-preview-1:pr-42",
      app_id: "app-preview-1",
      pr_number: 42,
      head_sha: "deadbeef",
      domain: "pr-42.preview.example.com",
      status: "pending",
    })
    expect(previewDeployAddMock).toHaveBeenCalledWith("preview.deploy", {
      appId: "app-preview-1",
      prNumber: 42,
      headSha: "deadbeef",
    })
  })

  it("enqueues preview teardown on PR closed even if previews are now disabled", async () => {
    getAppByRepoAndOwnerMock.mockResolvedValue({
      ...previewEnabledApp,
      preview_enabled: false,
    })

    await handlePullRequest(
      db,
      {
        action: "closed",
        pull_request: { number: 42, head: { sha: "deadbeef" } },
        repository: { full_name: "acme/docs" },
        installation: { id: 7 },
      },
      "delivery-closed"
    )

    expect(previewDeployAddMock).not.toHaveBeenCalled()
    expect(previewTeardownAddMock).toHaveBeenCalledWith("preview.teardown", {
      appId: "app-preview-1",
      prNumber: 42,
    })
    expect(insertPreviewDeploymentMock).not.toHaveBeenCalled()
    expect(updatePreviewDeploymentMock).toHaveBeenCalledWith(
      db,
      "app-preview-1:pr-42",
      { status: "tearing_down" }
    )
  })
})
