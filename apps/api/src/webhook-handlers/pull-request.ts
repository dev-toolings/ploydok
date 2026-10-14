// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from "@ploydok/db"
import { childLogger } from "../logger"
import {
  getAppByRepoAndOwner,
  getPreviewDeploymentByAppAndPr,
  updatePreviewDeployment,
  insertPreviewDeployment,
} from "@ploydok/db/queries"
import { previewDeploy, previewTeardown } from "../worker/queues"

const log = childLogger("webhook:pull-request")

export interface PullRequestPayload {
  action: string
  pull_request: {
    number: number
    head: {
      sha: string
    }
  }
  repository: {
    full_name: string
  }
  installation?: {
    id: number
  }
}

/**
 * Handle GitHub pull_request webhook events.
 * On opened/synchronize: enqueue preview deploy.
 * On closed: enqueue preview teardown.
 */
export async function handlePullRequest(
  db: Db,
  payload: PullRequestPayload,
  deliveryId: string
): Promise<void> {
  const { action, pull_request, repository, installation } = payload
  const prNumber = pull_request.number
  const headSha = pull_request.head.sha
  const repoFullName = repository.full_name
  const installationId = installation?.id

  log.debug(
    { deliveryId, action, prNumber, repoFullName },
    "pull_request event"
  )

  // Find app by repo + owner
  const app = await getAppByRepoAndOwner(db, repoFullName)
  if (!app) {
    log.debug({ repoFullName, deliveryId }, "no app found for repo — skipping")
    return
  }

  const now = new Date()
  const expiresAt = new Date(
    now.getTime() + (app.preview_ttl_days ?? 7) * 24 * 60 * 60 * 1000
  )

  switch (action) {
    case "opened":
    case "synchronize": {
      if (!app.preview_enabled) {
        log.debug(
          { appId: app.id, deliveryId },
          "preview deployments disabled — skipping"
        )
        return
      }

      log.info(
        { appId: app.id, prNumber, headSha, deliveryId },
        "enqueuing preview deploy"
      )

      const previewId = `${app.id}:pr-${prNumber}`
      const domain = `pr-${prNumber}.${app.preview_wildcard || `preview.${app.slug}`}`
      const existingPreview = await getPreviewDeploymentByAppAndPr(
        db,
        app.id,
        prNumber
      )

      if (existingPreview) {
        await updatePreviewDeployment(db, previewId, {
          head_sha: headSha,
          domain,
          status: "pending",
          expires_at: expiresAt,
          updated_at: now,
        })
      } else {
        await insertPreviewDeployment(db, {
          id: previewId,
          app_id: app.id,
          pr_number: prNumber,
          head_sha: headSha,
          domain,
          status: "pending",
          expires_at: expiresAt,
          created_at: now,
          updated_at: now,
        })
      }

      await previewDeploy.add("preview.deploy", {
        appId: app.id,
        prNumber,
        headSha,
      })
      break
    }

    case "closed": {
      log.info(
        { appId: app.id, prNumber, deliveryId },
        "enqueuing preview teardown"
      )

      await updatePreviewDeployment(db, `${app.id}:pr-${prNumber}`, { status: "tearing_down" })
      await previewTeardown.add("preview.teardown", {
        appId: app.id,
        prNumber,
      })
      break
    }

    default:
      log.debug({ action, deliveryId }, "unhandled pull_request action")
  }
}
