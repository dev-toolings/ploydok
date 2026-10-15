// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for handleDeleteApp (Wave 2 DB-anchored queue).
 *
 * Tests schema validation and graceful error handling.
 */
import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test"
import {
  app_delete_jobs,
  apps,
  databases,
  projects,
  services,
} from "@ploydok/db"
import * as queueClaimMod from "../queue-claim"
import * as queueAuditMod from "../queue-audit"
import * as appVolumesMod from "../../services/app-volumes"

mock.module("../../caddy/attachment.js", () => ({
  detachCaddyFromProjectNetwork: async () => {},
}))

const stopSwarmAppMock = mock(async () => {})
const stopAppMock = mock(async () => {})

mock.module("../swarm-runner.js", () => ({
  stopSwarmApp: stopSwarmAppMock,
}))

mock.module("../runner.js", () => ({
  stopApp: stopAppMock,
}))

function createMockDb(options?: {
  failDelete?: boolean
  appProjectId?: string
  projectNetworkName?: string | null
  remainingAppIds?: string[]
  databaseIds?: string[]
  serviceIds?: string[]
}) {
  const updateCalls: Array<{ table: unknown; values: unknown }> = []

  const select = mock((selection: Record<string, unknown>) => ({
    from: mock((table: unknown) => ({
      where: mock(() => ({
        limit: mock(async () => {
          if (
            table === apps &&
            Object.prototype.hasOwnProperty.call(selection, "project_id") &&
            options?.appProjectId
          ) {
            return [{ project_id: options.appProjectId }]
          }

          if (table === apps) {
            return (options?.remainingAppIds ?? []).map((id) => ({ id }))
          }

          if (table === projects) {
            return options && "projectNetworkName" in options
              ? [{ network_name: options.projectNetworkName }]
              : []
          }

          if (table === databases) {
            return (options?.databaseIds ?? []).map((id) => ({ id }))
          }

          if (table === services) {
            return (options?.serviceIds ?? []).map((id) => ({ id }))
          }

          return []
        }),
      })),
    })),
  }))

  const db = {
    select,
    update: mock((table: unknown) => ({
      set: mock((values: unknown) => ({
        where: mock(async () => {
          updateCalls.push({ table, values })
          return []
        }),
      })),
    })),
    delete: mock((_table: unknown) => ({
      where: mock(async () => {
        if (options?.failDelete) {
          throw new Error("delete failed")
        }
        return []
      }),
    })),
  }

  return { db: db as unknown as import("@ploydok/db").Db, updateCalls }
}

describe("handleDeleteApp", () => {
  beforeEach(() => {
    mock.restore()
  })

  it("validates payload schema — throws on invalid JSON", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const fakeDb = createMockDb().db
    const job = {
      id: "job-invalid",
      payload: "{invalid json}",
    }

    await expect(handleDeleteApp(fakeDb, job)).rejects.toThrow()
  })

  it("drops legacy payload with appId and audits unauthorized", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db } = createMockDb()
    const auditSpy = spyOn(queueAuditMod, "auditUnauthorized")
    const claimSpy = spyOn(queueClaimMod, "claimQueuedRow")

    await handleDeleteApp(db, {
      id: "job-legacy",
      payload: JSON.stringify({ appId: "app-legacy" }),
    })

    expect(auditSpy).toHaveBeenCalledTimes(1)
    expect(auditSpy.mock.calls[0]?.[0]).toMatchObject({
      reason: "legacy payload format — drop after queue drain",
    })
    expect(claimSpy).not.toHaveBeenCalled()
  })

  it("claims jobId and marks app_delete_jobs as succeeded when cascade succeeds", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb()
    const claimed = {
      app_id: "app-1",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimed)

    await handleDeleteApp(db, {
      id: "job-success",
      payload: JSON.stringify({ jobId: "job-success" }),
    })

    expect(
      updateCalls.some(
        (call) =>
          call.table === app_delete_jobs &&
          (call.values as any).status === "succeeded"
      )
    ).toBeTrue()
    const appDeleteUpdate = updateCalls.find(
      (call) => call.table === app_delete_jobs
    )
    expect(appDeleteUpdate?.values).toMatchObject({ status: "succeeded" })
  })

  it("accepts BullMQ object payloads produced by enqueueWithDbRow", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb()
    const claimed = {
      app_id: "app-1",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimed)

    await handleDeleteApp(db, {
      id: "bullmq-job",
      payload: { jobId: "app-delete-row" },
    })

    expect(
      updateCalls.some(
        (call) =>
          call.table === app_delete_jobs &&
          (call.values as any).status === "succeeded"
      )
    ).toBeTrue()
  })

  it("keeps the project network when a database still uses it", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb({
      appProjectId: "project-1",
      projectNetworkName: "ploydok-proj-project-1",
      databaseIds: ["db-1"],
    })
    const claimed = {
      app_id: "app-1",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimed)

    await handleDeleteApp(db, {
      id: "job-network-skip",
      payload: { jobId: "app-delete-row" },
    })

    expect(updateCalls.some((call) => call.table === projects)).toBeFalse()
    expect(
      updateCalls.some(
        (call) =>
          call.table === app_delete_jobs &&
          (call.values as any).status === "succeeded"
      )
    ).toBeTrue()
  })

  it("purges the app volume root during the delete cascade", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb()
    const claimed = {
      app_id: "app-with-volumes",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    }

    const purgeSpy = spyOn(
      appVolumesMod,
      "purgeAppVolumeRoot"
    ).mockResolvedValue()
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimed)

    await handleDeleteApp(db, {
      id: "job-volume-purge",
      payload: { jobId: "app-delete-row" },
    })

    expect(purgeSpy).toHaveBeenCalledWith("app-with-volumes")
    expect(
      updateCalls.some(
        (call) =>
          call.table === app_delete_jobs &&
          (call.values as any).status === "succeeded"
      )
    ).toBeTrue()
  })

  it("marks app_delete_jobs as failed when cascade step throws unexpectedly", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb({ failDelete: true })
    const claimed = {
      app_id: "app-1",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimed)

    await handleDeleteApp(db, {
      id: "job-fail",
      payload: JSON.stringify({ jobId: "job-fail" }),
    })

    expect(
      updateCalls.some(
        (call) =>
          call.table === app_delete_jobs &&
          (call.values as any).status === "failed"
      )
    ).toBeTrue()
    const appDeleteUpdate = updateCalls.find(
      (call) => call.table === app_delete_jobs
    )
    expect(appDeleteUpdate?.values).toMatchObject({
      status: "failed",
      error_message: expect.stringContaining("delete failed"),
    })
  })

  it("marks the delete job failed when app volume purge fails", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb()
    const claimed = {
      app_id: "app-volume-fail",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimed)
    spyOn(appVolumesMod, "purgeAppVolumeRoot").mockRejectedValue(
      new Error("purge failed")
    )

    await handleDeleteApp(db, {
      id: "job-volume-fail",
      payload: JSON.stringify({ jobId: "job-volume-fail" }),
    })

    expect(
      updateCalls.some(
        (call) =>
          call.table === app_delete_jobs &&
          (call.values as any).status === "failed"
      )
    ).toBeTrue()
    const finalUpdate = updateCalls.find(
      (call) =>
        call.table === app_delete_jobs && "status" in (call.values as any)
    )
    expect((finalUpdate?.values as any).error_message).toContain("purge failed")
  })

  it("stops the Swarm service before leftover docker containers", async () => {
    stopSwarmAppMock.mockClear()
    stopAppMock.mockClear()
    const { handleDeleteApp } = await import("./delete-app")
    const { db } = createMockDb()
    const claimed = {
      app_id: "app-swarm",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: true,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimed)

    await handleDeleteApp(db, {
      id: "job-swarm-cleanup",
      payload: { jobId: "app-delete-row" },
    })

    expect(stopSwarmAppMock).toHaveBeenCalledTimes(1)
    expect(stopAppMock).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(stopSwarmAppMock.mock.calls)).toContain("app-swarm")
  })
})
