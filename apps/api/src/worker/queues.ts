// SPDX-License-Identifier: AGPL-3.0-only
import { Queue } from "bullmq"
import { createRedis } from "@ploydok/db"
import { env } from "../env"
import { assertTransactionalQueueRegistry } from "./queue-enqueue"

const connection = createRedis(env.REDIS_URL)

const deployDefaults = {
  removeOnComplete: 100,
  removeOnFail: 500,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
}

export const deployQueue = new Queue("deploy", {
  connection,
  defaultJobOptions: deployDefaults,
})
export const gcQueue = new Queue("gc.registry", { connection })
export const gcImagesQueue = new Queue("gc.images", { connection })
export const gcBuildCacheQueue = new Queue("gc.buildcache", { connection })
export const dockerCleanupQueue = new Queue("gc.docker", { connection })
export const imageScanQueue = new Queue("scan.image", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 10_000 },
  },
})
export const cleanupQueue = new Queue("cleanup.build", { connection })
export const appDeleteQueue = new Queue("app.delete", { connection })

const domainVerifyDefaults = {
  removeOnComplete: 50,
  removeOnFail: 200,
  // Poll every 30s, max 20 attempts = 10 min window
  attempts: 20,
  backoff: { type: "fixed" as const, delay: 30_000 },
}
export const domainVerifyQueue = new Queue("domain.verify", {
  connection,
  defaultJobOptions: domainVerifyDefaults,
})

const providerReposSyncDefaults = {
  removeOnComplete: 100,
  removeOnFail: 200,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
}
export const providerReposSyncQueue = new Queue("provider.repos.sync", {
  connection,
  defaultJobOptions: providerReposSyncDefaults,
})

const previewDefaults = {
  removeOnComplete: 100,
  removeOnFail: 200,
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
}
// Named exports kept identical to existing importers
// (apps-previews.ts, webhook-handlers/pull-request.ts, jobs/cleanup-previews.ts)
// which already wrote `previewDeploy.add(...)` / `previewTeardown.add(...)`
// before the queue declarations existed.
export const previewDeploy = new Queue("preview.deploy", {
  connection,
  defaultJobOptions: previewDefaults,
})
export const previewTeardown = new Queue("preview.teardown", {
  connection,
  defaultJobOptions: previewDefaults,
})

export const cveRefreshQueue = new Queue("cve.refresh", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 50,
    removeOnFail: 100,
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 30_000 },
  },
})

export const logArchiveQueue = new Queue("logs.archive", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
  },
})

/** Queues whose critical state transitions are projected through JOB-01. */
export const transactionalOutboxQueues = [
  deployQueue,
  gcQueue,
  gcImagesQueue,
  gcBuildCacheQueue,
  dockerCleanupQueue,
  appDeleteQueue,
] as const

assertTransactionalQueueRegistry(transactionalOutboxQueues)

export type QueueName =
  | "deploy"
  | "scan.image"
  | "gc.registry"
  | "gc.images"
  | "gc.buildcache"
  | "gc.docker"
  | "cleanup.build"
  | "app.delete"
  | "domain.verify"
  | "provider.repos.sync"
  | "preview.deploy"
  | "preview.teardown"
  | "cve.refresh"
  | "logs.archive"
