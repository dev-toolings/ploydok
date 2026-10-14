// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from "@ploydok/db"
import { childLogger } from "../logger"
import {
  getAppByRepoAndOwner,
} from "@ploydok/db/queries"
import { enqueuePreviewIntent } from "../worker/preview-intents"
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

      const domain = `pr-${prNumber}.${app.preview_wildcard || `preview.${app.slug}`}`
      await enqueuePreviewIntent(db, previewDeploy, {
        action: "deploy", appId: app.id, prNumber, headSha, domain, expiresAt,
        source: "webhook:pull_request",
      })
      break
    }

    case "closed": {
      log.info(
        { appId: app.id, prNumber, deliveryId },
        "enqueuing preview teardown"
      )

      await enqueuePreviewIntent(db, previewTeardown, {
        action: "teardown", appId: app.id, prNumber, source: "webhook:pull_request",
      })
      break
    }

    default:
      log.debug({ action, deliveryId }, "unhandled pull_request action")
  }
}
