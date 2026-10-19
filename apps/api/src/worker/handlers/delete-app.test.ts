// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for handleDeleteApp (Wave 2 DB-anchored queue).
 *
 * Tests schema validation and graceful error handling.
 */
import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test"

// Image removal retries while a container still references the image.
Bun.env["PLOYDOK_IMAGE_REMOVE_RETRY_MS"] = "1"
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
import * as registryMod from "../registry"
import * as singletonsMod from "../../debug/singletons"
import { env } from "../../env"
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { resetCaddyIdCache } from "../../caddy/attachment"

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
  projectSwarmNetworkName?: string | null
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
              ? [{ network_name: options.projectNetworkName, swarm_network_name: options.projectSwarmNetworkName }]
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

  it("wipes normal and preview repositories and local images before deleting the app and its build directory", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb()
    const root = await mkdtemp(path.join(tmpdir(), "ploydok-delete-"))
    const testEnv = env as { PLOYDOK_BUILD_DIR: string }
    const previous = env.PLOYDOK_BUILD_DIR
    testEnv.PLOYDOK_BUILD_DIR = root
    const appDir = path.join(root, "Demo_APP")
    const sibling = path.join(root, "other-app")
    await mkdir(appDir)
    await writeFile(path.join(appDir, "build.log"), "artifact")
    await mkdir(sibling)
    const remove = mock(async (_req: { image: string; allTags: boolean }) => ({
      deleted: true,
    }))
    spyOn(singletonsMod, "getSharedAgent").mockReturnValue({
      imageRemove: remove,
    } as any)
    const registry = spyOn(registryMod, "deleteRepository").mockResolvedValue({
      tagsDeleted: 2,
      errors: [],
    })
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      app_id: "Demo_APP",
      requested_by_user_id: "user-1",
      source: "api",
      options: { dockerCleanup: false, deleteCaddyRoutes: false },
    })
    try {
      await handleDeleteApp(db, { id: "delete", payload: { jobId: "delete" } })
      expect(registry.mock.calls).toEqual([
        ["app-demo-app"],
        ["preview-app-demo-app"],
      ])
      const hosts = [
        ...new Set(
          [env.PLOYDOK_REGISTRY_URL, env.PLOYDOK_REGISTRY_PUSH_URL].map((url) =>
            url.replace(/^https?:\/\//, "")
          )
        ),
      ]
      expect(remove.mock.calls.map(([req]) => req)).toEqual(
        ["app-demo-app", "preview-app-demo-app"].flatMap((repo) =>
          hosts.map((host) => ({ image: `${host}/${repo}`, allTags: true }))
        )
      )
      expect(db.delete).toHaveBeenCalledWith(apps)
      await expect(access(appDir)).rejects.toThrow()
      await access(sibling)
      expect(updateCalls.at(-1)?.values).toMatchObject({ status: "succeeded" })
    } finally {
      testEnv.PLOYDOK_BUILD_DIR = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it("records partial image failures in the job while continuing repository cleanup and DB deletion", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb()
    const registry = spyOn(registryMod, "deleteRepository")
      .mockResolvedValueOnce({
        tagsDeleted: 1,
        errors: ["manifest DELETE 405"],
      })
      .mockResolvedValueOnce({ tagsDeleted: 1, errors: [] })
    const remove = mock(async () => {
      throw new Error("image in use")
    })
    spyOn(singletonsMod, "getSharedAgent").mockReturnValue({
      imageRemove: remove,
    } as any)
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      app_id: "demo",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    })
    await handleDeleteApp(db, { id: "delete", payload: { jobId: "delete" } })
    expect(registry).toHaveBeenCalledTimes(2)
    expect(remove.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(db.delete).toHaveBeenCalledWith(apps)
    const final = updateCalls.at(-1)?.values as {
      status: string
      error_message: string
    }
    expect(final.error_message).toContain("[localImages]")
    expect(final.error_message).toContain("image in use")
    // The app row is gone: leftover cleanup is a warning on a succeeded job.
    expect(final).toMatchObject({
      status: "succeeded",
      error_message: expect.stringContaining("[registry] manifest DELETE 405"),
    })
  })

  it("retries local image removal while a stopping container still uses the image", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb()
    spyOn(registryMod, "deleteRepository").mockResolvedValue({ tagsDeleted: 1, errors: [] })
    let attempts = 0
    const remove = mock(async () => {
      attempts++
      if (attempts <= 2) {
        throw new Error(
          "Docker responded with status code 409: conflict: unable to delete (must be forced) - container 670df2c1bbff is using its referenced image 813b39cd69d8"
        )
      }
    })
    spyOn(singletonsMod, "getSharedAgent").mockReturnValue({
      imageRemove: remove,
    } as any)
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      app_id: "demo",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    })
    const result = await handleDeleteApp(db, { id: "delete", payload: { jobId: "delete" } })
    expect(result?.steps.localImages).toEqual({ ok: true })
    expect(attempts).toBeGreaterThanOrEqual(3)
    expect(updateCalls.at(-1)?.values).toMatchObject({ status: "succeeded" })
  })

  it("preserves images when deleteImages is false", async () => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db } = createMockDb()
    const registry = spyOn(registryMod, "deleteRepository").mockResolvedValue({
      tagsDeleted: 0,
      errors: [],
    })
    const agent = spyOn(singletonsMod, "getSharedAgent")
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      app_id: "demo",
      requested_by_user_id: "user-1",
      source: "api",
      options: {
        deleteImages: false,
        dockerCleanup: false,
        deleteBuildArtifacts: false,
        deleteCaddyRoutes: false,
      },
    })
    await handleDeleteApp(db, { id: "delete", payload: { jobId: "delete" } })
    expect(registry).not.toHaveBeenCalled()
    expect(agent).not.toHaveBeenCalled()
  })

  it("validates payload schema: throws on invalid JSON", async () => {
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
      reason: "legacy payload format: drop after queue drain",
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

  it("removes the overlay and legacy bridge after deleting the last app", async () => {
    resetCaddyIdCache()
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb({
      appProjectId: "ABC", projectNetworkName: "bridge", projectSwarmNetworkName: null,
    })
    const events: string[] = []
    spyOn(singletonsMod, "getSharedAgent").mockReturnValue({
      ingressStatus: async () => ({ overlayInventoryComplete: true, projectOverlays: [{ name: "ploydok-swarm-proj-abc", hasWorkloads: false }] }),
      listContainers: async () => ({ containers: [{ id: "caddy", name: "ploydok-caddy" }] }),
      inspectContainerHealth: async () => ({ running: true }),
      networkDisconnect: async ({ networkId }: any) => { events.push(`detach:${networkId}`) },
      networkRemove: async ({ networkId }: any) => { events.push(`remove:${networkId}`) },
    } as any)
    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      app_id: "app", requested_by_user_id: "user", source: "api",
      options: { deleteImages: false, dockerCleanup: true, deleteBuildArtifacts: false, deleteCaddyRoutes: false },
    })
    await handleDeleteApp(db, { id: "job", payload: { jobId: "job" } })
    expect(events).toEqual(["detach:ploydok-swarm-proj-abc", "remove:ploydok-swarm-proj-abc", "detach:bridge", "remove:bridge"])
    expect(updateCalls.filter(call => call.table === projects).map(call => call.values))
      .toEqual([{ swarm_network_name: null }, { network_name: null }])
    resetCaddyIdCache()
  })

  it.each(["database", "service", "app"])("keeps the project network when a %s still uses it", async (consumer) => {
    const { handleDeleteApp } = await import("./delete-app")
    const { db, updateCalls } = createMockDb({
      appProjectId: "project-1",
      projectNetworkName: "ploydok-proj-project-1",
      databaseIds: consumer === "database" ? ["db-1"] : [],
      serviceIds: consumer === "service" ? ["svc-1"] : [],
      remainingAppIds: consumer === "app" ? ["app-2"] : [],
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

  it("records a failed app volume purge as a warning on the succeeded job", async () => {
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

    const finalUpdate = updateCalls.find(
      (call) =>
        call.table === app_delete_jobs && "status" in (call.values as any)
    )
    expect((finalUpdate?.values as any).status).toBe("succeeded")
    expect((finalUpdate?.values as any).error_message).toContain("[appVolumes] purge failed")
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
