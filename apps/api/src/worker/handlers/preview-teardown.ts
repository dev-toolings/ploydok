// SPDX-License-Identifier: AGPL-3.0-only
import { rm } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { Db } from "@ploydok/db"
import {
  getPreviewDeployment,
  updatePreviewDeployment,
} from "@ploydok/db/queries"
import { staticRoot } from "./build-static"
import { workerLog } from "../logger"
import { isNotFound, toAgentError } from "../../agent"
import { getSharedAgent, getSharedCaddy } from "../../debug/singletons"
import { runtimeContainerShortId } from "../../services/runtime-containers"

const log = workerLog.child({ subsystem: "preview-teardown" })

const PreviewTeardownPayloadSchema = z.object({
  appId: z.string(),
  prNumber: z.number().int().positive(),
})

function sanitizeToken(value: string, maxLen = 20): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
  return normalized || "app"
}

function previewResourceId(appId: string, prNumber: number): string {
  return `preview-${sanitizeToken(appId, 16)}-${runtimeContainerShortId(
    appId
  )}-pr-${prNumber}`
}

async function stopPreviewContainer(containerRef: string | null): Promise<void> {
  if (!containerRef) return
  try {
    await getSharedAgent().containerStop({
      containerId: containerRef,
      timeoutSeconds: 10,
    })
  } catch (error) {
    if (!isNotFound(toAgentError(error))) {
      log.warn({ containerRef, error }, "preview stop failed; retry required")
      throw error
    }
  }

  try {
    await getSharedAgent().containerRemove({
      containerId: containerRef,
      force: true,
      removeVolumes: false,
    })
  } catch (error) {
    if (!isNotFound(toAgentError(error))) {
      log.warn({ containerRef, error }, "preview remove failed; retry required")
      throw error
    }
  }
}

/**
 * Remove the live preview route, runtime container and any static preview
 * assets. This is intentionally idempotent so cleanup jobs and manual teardown
 * can race safely.
 */
export async function handlePreviewTeardown(
  db: Db,
  payload: unknown
): Promise<void> {
  const parsed = PreviewTeardownPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    log.error(
      { issues: parsed.error.issues },
      "invalid preview teardown payload"
    )
    throw new Error("Invalid preview teardown payload")
  }

  const { appId, prNumber } = parsed.data
  const previewId = `${appId}:pr-${prNumber}`
  const resourceId = previewResourceId(appId, prNumber)

  try {
    log.info({ appId, prNumber }, "starting preview teardown")

    const preview = await getPreviewDeployment(db, previewId)
    await updatePreviewDeployment(db, previewId, {
      status: "tearing_down",
    })

    await getSharedCaddy().removeRoute(resourceId)
    await stopPreviewContainer(preview?.container_id ?? null)
    await rm(path.join(staticRoot(), resourceId), {
      recursive: true,
      force: true,
    })

    await updatePreviewDeployment(db, previewId, {
      status: "torn_down",
      container_id: null,
    })

    log.info({ appId, prNumber }, "preview teardown complete")
  } catch (error) {
    log.error({ appId, prNumber, error }, "preview teardown failed")
    throw error
  }
}
