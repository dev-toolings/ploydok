// SPDX-License-Identifier: AGPL-3.0-only
import { rm } from "node:fs/promises"
import path from "node:path"
import { Worker, UnrecoverableError, DelayedError } from "bullmq"
import {
  createRedis,
  apps,
  app_delete_jobs,
  builds,
  system_jobs,
} from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { eq } from "drizzle-orm"
import { resolveAppOwner } from "@ploydok/db/queries"
import { eventBus } from "./event-bus"
import { env } from "../env"
import { workerLog as logger } from "./logger"
import { handleDeploy } from "./handlers/deploy"
import { FatalDeployError } from "./errors"
import { failedDeleteSteps, handleDeleteApp } from "./handlers/delete-app"
import { handleDomainVerify } from "./handlers/domain-verify"
import type { DomainVerifyPayload } from "./handlers/domain-verify"
import {
  runRegistryGc,
  startRegistryGcCron,
  stopRegistryGcCron,
  GcRegistryOptionsSchema,
} from "./handlers/gc-registry"
import { ensureStateDirs } from "./state-dirs"
import { claimQueuedRow } from "./queue-claim"
import { auditClaimed, auditUnauthorized } from "./queue-audit"
import {
  dockerCleanupQueue,
  gcQueue,
  transactionalOutboxQueues,
} from "./queues"
import { handleGcImagesJob } from "./handlers/gc-images"
import { handleGcBuildcacheJob } from "./handlers/gc-buildcache"
import { handleDockerCleanupJob } from "./handlers/gc-docker"
import {
  isDockerCleanupScheduleEnabled,
  startDockerCleanupCron,
  stopDockerCleanupCron,
} from "./jobs/docker-cleanup"
import {
  startAuditRetentionCron,
  stopAuditRetentionCron,
} from "./handlers/audit-retention"
import {
  startPurgeWebhookSecretsCron,
  stopPurgeWebhookSecretsCron,
} from "./jobs/purge-old-webhook-secrets"
import {
  startCertExpiryCheckCron,
  stopCertExpiryCheckCron,
} from "./jobs/cert-expiry-check"
import {
  startRotateDatabasesCron,
  stopRotateDatabasesCron,
} from "./jobs/rotate-databases"
import {
  startBackupDatabasesCron,
  stopBackupDatabasesCron,
} from "./jobs/backup-databases"
import {
  startOrphanContainerGcCron,
  stopOrphanContainerGcCron,
} from "./jobs/gc-orphan-containers"
import {
  startReapStuckBuildsCron,
  stopReapStuckBuildsCron,
} from "./jobs/reap-stuck-builds"
import {
  startCleanupPreviewsCron,
  stopCleanupPreviewsCron,
} from "./jobs/cleanup-previews"
import { startAuditAnchorCron, stopAuditAnchorCron } from "./jobs/audit-anchor"
import { handleSyncProviderRepos } from "./handlers/sync-provider-repos"
import type { SyncProviderReposPayload } from "./handlers/sync-provider-repos"
import { loadPreviewIntentPayload, completePreviewIntent } from "./preview-intents"
import { handlePreviewDeploy } from "./handlers/preview-deploy"
import { resumeServiceCreation } from "../services/marketplace-orchestrator"
import { handlePreviewTeardown } from "./handlers/preview-teardown"
import { getSharedAgent } from "../debug/singletons"
import type { Agent } from "../agent"
import {
  startScheduledJobsRunner,
  stopScheduledJobsRunner,
} from "./jobs/scheduled-jobs-runner"
import {
  capturePlatformManifests,
  refreshAdvisories,
} from "../advisories/service"
import { startCveRefreshCron, stopCveRefreshCron } from "./jobs/cve-refresh"
import {
  startPurgeBuildLogsCron,
  stopPurgeBuildLogsCron,
} from "./jobs/purge-build-logs"
import {
  startCaddyReconcileCron,
  stopCaddyReconcileCron,
} from "./jobs/caddy-reconcile"
import { startAutoHealCron, stopAutoHealCron } from "./jobs/auto-heal"
import { startDiskHistorySampler, stopDiskHistorySampler } from "../disk/history"
import {
  startImageUpdateWatchCron,
  stopImageUpdateWatchCron,
} from "./jobs/image-update-watch"
import { handleArchiveBuildLog } from "./handlers/archive-build-log"
import type { ArchiveBuildLogPayload } from "./handlers/archive-build-log"
import { DeployCancelledError } from "./app-deploy-lock"
import { runQueuedDeployWithLease } from "./queue-deploy-lease"
import { handleImageScan } from "./handlers/scan-image"
import {
  startOutboxDispatcher,
  stopOutboxDispatcher,
} from "./outbox-dispatcher"
import {
  startQueueOutboxDispatcher,
  stopQueueOutboxDispatcher,
} from "./queue-outbox-dispatcher"
import {
  startResourceCreationReconciler,
  stopResourceCreationReconciler,
} from "../services/resource-creation-reconciler"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Returned by `startWorker`. Call `stop()` for graceful shutdown. */
export interface WorkerHandle {
  stop(): Promise<void>
}

interface GcRegistryPayload {
  id?: string
  data: unknown
}

async function resolveDeployJobAppId(
  db: Db,
  data: unknown
): Promise<string | null> {
  const payload = typeof data === "string" ? JSON.parse(data) : data

  if (!payload || typeof payload !== "object") return null

  const buildId = (payload as { buildId?: unknown }).buildId
  if (typeof buildId === "string") {
    const rows = await db
      .select({ app_id: builds.app_id })
      .from(builds)
      .where(eq(builds.id, buildId))
      .limit(1)
    return rows[0]?.app_id ?? null
  }

  const appId = (payload as { appId?: unknown }).appId
  return typeof appId === "string" ? appId : null
}

export async function handleGcRegistryJob(
  db: Db,
  job: GcRegistryPayload
): Promise<void> {
  const { jobId } = job.data as { jobId?: string }
  if (!jobId) {
    auditUnauthorized({
      jobName: "gc.registry.requested",
      jobId: job.id ?? "",
      payload: job.data,
      reason: "legacy payload (no jobId): drop after queue drain",
    })
    return
  }

  const claimed = await claimQueuedRow<typeof system_jobs.$inferSelect>({
    db,
    table: system_jobs,
    id: jobId,
  })
  if (!claimed) {
    auditUnauthorized({
      jobName: "gc.registry.requested",
      jobId: job.id ?? "",
      payload: job.data,
      reason: "no matching pending system_jobs row",
    })
    return
  }

  let opts: { appId?: string | null | undefined; keepPerRepo: number }
  try {
    opts = GcRegistryOptionsSchema.parse(claimed.options)
  } catch (err) {
    await db
      .update(system_jobs)
      .set({
        status: "failed",
        finished_at: new Date(),
        error_message:
          err instanceof Error ? err.message.slice(0, 1000) : String(err),
      })
      .where(eq(system_jobs.id, jobId))

    auditUnauthorized({
      jobName: "gc.registry.requested",
      jobId: job.id ?? "",
      payload: claimed.options,
      reason: "invalid system_jobs.options schema",
    })
    return
  }

  auditClaimed({
    jobName: "gc.registry.requested",
    jobId: job.id ?? "",
    rowId: jobId,
    actor: claimed.requested_by_user_id,
    source: claimed.source,
  })

  try {
    const result = await runRegistryGc(
      opts.appId
        ? { db, appFilter: opts.appId, keepPerRepo: opts.keepPerRepo }
        : { db, keepPerRepo: opts.keepPerRepo }
    )
    await db
      .update(system_jobs)
      .set({ status: "succeeded", finished_at: new Date() })
      .where(eq(system_jobs.id, jobId))
    logger.info({ jobId, ...result }, "gc.registry done")
  } catch (err) {
    await db
      .update(system_jobs)
      .set({
        status: "failed",
        finished_at: new Date(),
        error_message:
          err instanceof Error ? err.message.slice(0, 1000) : String(err),
      })
      .where(eq(system_jobs.id, jobId))
    throw err
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * Start BullMQ workers for all job types.
 *
 * Each queue maps 1-to-1 to a handler. Deploy jobs can run concurrently for
 * different apps; an in-process per-app lock keeps same-app deploys sequential.
 *
 * Pass `opts.signal` to stop via AbortSignal (e.g. from a test or SIGTERM).
 */
export function startWorker(
  db: Db,
  opts?: { signal?: AbortSignal; agent?: Agent }
): WorkerHandle {
  void ensureStateDirs()
  const connection = createRedis(env.REDIS_URL)
  const agent = opts?.agent ?? getSharedAgent()
  const deployConcurrency = env.PLOYDOK_DEPLOY_CONCURRENCY

  const workers: Worker[] = [
    new Worker(
      "deploy",
      async (job, token) => {
        const attempt = job.attemptsMade + 1
        const maxAttempts = job.opts.attempts ?? 1
        logger.info(
          { jobId: job.id, name: job.name, attempt, maxAttempts },
          "deploy job started"
        )
        try {
          const runDeploy = () =>
            handleDeploy(db, {
              id: job.id ?? "",
              payload: JSON.stringify(job.data),
              attempts: attempt,
              max_attempts: maxAttempts,
            })
          const appId = await resolveDeployJobAppId(db, job.data)
          const buildId =
            typeof job.data?.buildId === "string" ? job.data.buildId : null
          if (appId && buildId) {
            await runQueuedDeployWithLease(db, appId, buildId, runDeploy, job, token, {
              retryFailed: attempt > 1,
            })
          } else {
            await runDeploy()
          }
        } catch (err) {
          if (err instanceof DelayedError) {
            logger.info({ jobId: job.id }, "deploy deferred")
            throw err
          }
          if (err instanceof DeployCancelledError) {
            logger.info({ jobId: job.id }, "deploy cancelled")
            throw new UnrecoverableError(err.message)
          }
          if (err instanceof FatalDeployError) {
            logger.error(
              { jobId: job.id, err, kind: "fatal", attempt, maxAttempts },
              "deploy.failed kind=fatal: skipping retries"
            )
            throw new UnrecoverableError(err.message)
          }
          logger.warn(
            { jobId: job.id, err, kind: "transient", attempt, maxAttempts },
            "deploy.failed kind=transient: will retry"
          )
          throw err
        }
      },
      { connection, concurrency: deployConcurrency }
    ),

    new Worker(
      "gc.registry",
      async (job) => {
        await handleGcRegistryJob(db, job)
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "gc.images",
      async (job) => {
        await handleGcImagesJob(db, job)
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "gc.buildcache",
      async (job) => {
        await handleGcBuildcacheJob(db, job)
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "gc.docker",
      async (job) => {
        await handleDockerCleanupJob(db, job)
      },
      // Manual and scheduled cleanup must never overlap.
      { connection, concurrency: 1 }
    ),

    new Worker(
      "scan.image",
      async (job) => {
        await handleImageScan(db, job.data)
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "cleanup.build",
      async (job) => {
        logger.info({ jobId: job.id }, "cleanup.build job started")
        const { appId, buildId } = job.data as {
          appId: string
          buildId: string
        }
        const dir = path.join(env.PLOYDOK_BUILD_DIR, appId, buildId)
        await rm(dir, { recursive: true, force: true })
        logger.info(
          { jobId: job.id, appId, buildId, dir },
          "workspace cleaned up"
        )
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "app.delete",
      async (job) => {
        logger.info({ jobId: job.id }, "app.delete job started")

        // Parse job payload to extract appId for notification purposes.
        let appIdForNotification: string | null = null
        let requestedByUserId: string | null = null
        let deleteJobId: string | null = null
        try {
          const payload =
            typeof job.data === "string" ? JSON.parse(job.data) : job.data
          if (payload.jobId) {
            deleteJobId = payload.jobId
            const jobRow = await db
              .select({
                app_id: app_delete_jobs.app_id,
                requested_by_user_id: app_delete_jobs.requested_by_user_id,
              })
              .from(app_delete_jobs)
              .where(eq(app_delete_jobs.id, payload.jobId))
              .limit(1)
            appIdForNotification = jobRow[0]?.app_id ?? null
            requestedByUserId = jobRow[0]?.requested_by_user_id ?? null
          }
        } catch {
          // best-effort to extract appId for notification
        }

        const recipientId =
          requestedByUserId ??
          (appIdForNotification
            ? await resolveAppOwner(db, appIdForNotification)
            : null)
        const [appRow] = appIdForNotification
          ? await db
              .select({ name: apps.name })
              .from(apps)
              .where(eq(apps.id, appIdForNotification))
              .limit(1)
          : [null]
        const appName = appRow?.name ?? "App"

        try {
          const result = await handleDeleteApp(db, {
            id: job.id ?? "",
            payload: job.data,
          })
          if (!result) {
            logger.warn({ jobId: job.id }, "app.delete job not claimed")
            return
          }
          // Step names are safe to show; raw Docker errors stay in the job
          // row and the logs.
          const failedSteps = failedDeleteSteps(result)
          if (!result.steps.dbCascade.ok) {
            logger.warn(
              { jobId: job.id, failedSteps },
              "app.delete did not remove the app"
            )
            if (recipientId && appIdForNotification) {
              eventBus.publish(`user:${recipientId}`, {
                type: "app.delete.failed",
                appId: appIdForNotification,
                message: `${appName} deletion failed: ${failedSteps.join(", ")}`,
                data: { appName, failedSteps },
              })
            }
            return
          }
          if (failedSteps.length > 0) {
            logger.warn(
              { jobId: job.id, failedSteps },
              "app.delete done with leftover cleanup"
            )
          } else {
            logger.info({ jobId: job.id }, "app.delete done")
          }
          if (recipientId && appIdForNotification) {
            try {
              eventBus.publish(`user:${recipientId}`, {
                type: "app.deleted",
                appId: appIdForNotification,
                message:
                  failedSteps.length > 0
                    ? `${appName} deleted, cleanup to check: ${failedSteps.join(", ")}`
                    : `${appName} deleted`,
                data: { appName, warnings: failedSteps },
              })
            } catch (pubErr) {
              logger.warn(
                { pubErr, appId: appIdForNotification },
                "eventBus publish app.deleted failed (non-fatal)"
              )
            }
          }
        } catch (err) {
          if (recipientId && appIdForNotification) {
            try {
              eventBus.publish(`user:${recipientId}`, {
                type: "app.delete.failed",
                appId: appIdForNotification,
                message:
                  env.NODE_ENV === "prod"
                    ? `${appName} deletion failed`
                    : err instanceof Error
                      ? err.message
                      : `${appName} deletion failed`,
                data: { appName, failedSteps: ["dbCascade"] },
              })
            } catch {
              // best-effort
            }
          }
          throw err
        }
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "domain.verify",
      async (job) => {
        logger.info({ jobId: job.id }, "domain.verify job started")
        const payload = job.data as DomainVerifyPayload
        await handleDomainVerify(db, payload)
        logger.info(
          { jobId: job.id, domainId: payload.domainId },
          "domain.verify done"
        )
      },
      { connection, concurrency: 5 }
    ),

    new Worker(
      "provider.repos.sync",
      async (job) => {
        logger.info(
          { jobId: job.id, data: job.data },
          "provider.repos.sync job started"
        )
        const payload = job.data as SyncProviderReposPayload
        await handleSyncProviderRepos(db, payload)
        logger.info({ jobId: job.id }, "provider.repos.sync done")
      },
      { connection, concurrency: 2 }
    ),

    new Worker(
      "preview.deploy",
      async (job) => {
        logger.info({ jobId: job.id }, "preview.deploy job started")
        try {
          const payload = await loadPreviewIntentPayload(db, job.data, "deploy")
          if (payload) await handlePreviewDeploy(db, payload)
          await completePreviewIntent(db, job.data)
          logger.info({ jobId: job.id }, "preview.deploy done")
        } catch (err) {
          if (err instanceof FatalDeployError) {
            logger.error(
              { jobId: job.id, err, kind: "fatal" },
              "preview.deploy failed kind=fatal: skipping retries"
            )
            throw new UnrecoverableError(err.message)
          }
          throw err
        }
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "service.install",
      async (job) => {
        if (typeof job.data?.serviceId !== "string" || !job.data.serviceId) {
          throw new UnrecoverableError("Invalid service installation payload")
        }
        await resumeServiceCreation({ db, agent: getSharedAgent() }, job.data.serviceId)
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "preview.teardown",
      async (job) => {
        logger.info({ jobId: job.id }, "preview.teardown job started")
        const payload = await loadPreviewIntentPayload(db, job.data, "teardown")
        if (payload) await handlePreviewTeardown(db, payload)
        await completePreviewIntent(db, job.data)
        logger.info({ jobId: job.id }, "preview.teardown done")
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "cve.refresh",
      async (job) => {
        logger.info(
          { jobId: job.id, data: job.data },
          "cve.refresh job started"
        )
        await capturePlatformManifests(db)
        const result = await refreshAdvisories(db, connection)
        logger.info({ jobId: job.id, ...result }, "cve.refresh done")
      },
      { connection, concurrency: 1 }
    ),

    new Worker(
      "logs.archive",
      async (job) => {
        const payload =
          typeof job.data === "string"
            ? (JSON.parse(job.data) as ArchiveBuildLogPayload)
            : (job.data as ArchiveBuildLogPayload)
        await handleArchiveBuildLog(db, payload)
      },
      { connection, concurrency: 2 }
    ),
  ]

  // Attach error loggers to each worker
  for (const worker of workers) {
    worker.on("failed", (job, err) => {
      logger.warn({ jobId: job?.id, err }, `${worker.name} job failed`)
    })
  }

  startRegistryGcCron({ db, queue: gcQueue })
  startPurgeWebhookSecretsCron(db)
  startCertExpiryCheckCron(db)
  startRotateDatabasesCron(db)
  startBackupDatabasesCron(db)
  startOrphanContainerGcCron(db)
  startReapStuckBuildsCron(db)
  startCleanupPreviewsCron(db)
  startAuditRetentionCron({ db })
  startAuditAnchorCron(db, agent)
  startScheduledJobsRunner(db, agent)
  startCveRefreshCron(db)
  startPurgeBuildLogsCron(db)
  startCaddyReconcileCron(db)
  if (isDockerCleanupScheduleEnabled(env.PLOYDOK_DOCKER_CLEANUP_ENABLED)) {
    startDockerCleanupCron({ db, queue: dockerCleanupQueue })
  } else {
    logger.info(
      "daily Docker cleanup disabled (PLOYDOK_DOCKER_CLEANUP_ENABLED=off)"
    )
  }
  startAutoHealCron(db)
  startDiskHistorySampler(db)
  startImageUpdateWatchCron(db)
  startOutboxDispatcher(db)
  startQueueOutboxDispatcher(db, transactionalOutboxQueues)
  startResourceCreationReconciler(db)

  const abortHandler = () => stop()
  opts?.signal?.addEventListener("abort", abortHandler)

  async function stop() {
    stopRegistryGcCron()
    stopPurgeWebhookSecretsCron()
    stopCertExpiryCheckCron()
    stopRotateDatabasesCron()
    stopBackupDatabasesCron()
    stopOrphanContainerGcCron()
    stopReapStuckBuildsCron()
    stopCleanupPreviewsCron()
    stopAuditRetentionCron()
    stopAuditAnchorCron()
    stopScheduledJobsRunner()
    stopCveRefreshCron()
    stopPurgeBuildLogsCron()
    stopCaddyReconcileCron()
    stopDockerCleanupCron()
    stopAutoHealCron()
    stopDiskHistorySampler()
    stopImageUpdateWatchCron()
    stopOutboxDispatcher()
    await stopQueueOutboxDispatcher()
    await stopResourceCreationReconciler()
    await Promise.all(workers.map((w) => w.close())).catch((err) => {
      logger.error({ err }, "error closing BullMQ workers")
    })
  }

  return { stop }
}
