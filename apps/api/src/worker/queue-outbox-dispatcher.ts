// SPDX-License-Identifier: AGPL-3.0-only
import type { JobsOptions } from "bullmq"
import type { Db, QueueOutboxEventRow } from "@ploydok/db"
import {
  claimQueueOutboxEvent,
  completeQueueOutboxEvent,
  retryQueueOutboxEvent,
} from "@ploydok/db/queries"
import { auditEnqueued } from "./queue-audit"
import { workerLog } from "./logger"
import type { QueuePublisher } from "./queue-enqueue"
import { reconcileOrphanedPendingDeploys } from "./queue-deploy-reconciliation"

const log = workerLog.child({ subsystem: "queue-outbox" })
const POLL_MS = 2_000
const QUEUE_ADD_TIMEOUT_MS = 10_000
let timer: ReturnType<typeof setInterval> | null = null
let running: Promise<void> | null = null
let deployReconciliation: Promise<void> | null = null

export type QueueOutboxDispatchResult =
  "idle" | "dispatched" | "retry" | "lease-lost"

interface QueueOutboxDispatcherDeps {
  claim?: typeof claimQueueOutboxEvent
  complete?: typeof completeQueueOutboxEvent
  retry?: typeof retryQueueOutboxEvent
  audit?: typeof auditEnqueued
  addTimeoutMs?: number
}

async function publishClaim(
  db: Db,
  queue: QueuePublisher,
  event: QueueOutboxEventRow,
  leaseToken: string,
  now = new Date(),
  deps: QueueOutboxDispatcherDeps = {}
): Promise<QueueOutboxDispatchResult> {
  try {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`BullMQ add timed out for ${event.queue_name}`)),
        deps.addTimeoutMs ?? QUEUE_ADD_TIMEOUT_MS
      )
    })
    const job = await Promise.race([
      queue.add(event.job_name, event.payload, {
        ...(event.job_options as JobsOptions),
        jobId: event.job_id,
      }),
      timedOut,
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    if (job.id !== event.job_id) {
      throw new Error(
        `BullMQ returned unexpected job ID for ${event.queue_name}: ${job.id ?? "missing"}`
      )
    }
    const complete = deps.complete ?? completeQueueOutboxEvent
    const completed = await complete(db, event.id, leaseToken, now)
    if (!completed) return "lease-lost"
    const audit = deps.audit ?? auditEnqueued
    audit({
      jobName: event.job_name,
      jobId: event.job_id,
      rowId: event.source_row_id,
      actor: event.actor_user_id,
      source: event.source,
    })
    return "dispatched"
  } catch (error) {
    const delayMs = Math.min(
      60 * 60 * 1_000,
      1_000 * 2 ** Math.min(event.attempt_count - 1, 11)
    )
    const retry = deps.retry ?? retryQueueOutboxEvent
    const released = await retry(
      db,
      event.id,
      leaseToken,
      error instanceof Error ? error.message : String(error),
      new Date(now.getTime() + delayMs),
      now
    )
    if (!released) return "lease-lost"
    log.warn(
      { eventId: event.id, queue: event.queue_name, error },
      "queue outbox dispatch deferred"
    )
    return "retry"
  }
}

export async function dispatchQueueOutboxEventById(
  db: Db,
  queue: QueuePublisher,
  eventId: string,
  now = new Date(),
  deps: QueueOutboxDispatcherDeps = {}
): Promise<QueueOutboxDispatchResult> {
  const claimEvent = deps.claim ?? claimQueueOutboxEvent
  const claim = await claimEvent(db, { id: eventId, now })
  if (!claim) return "idle"
  if (claim.event.queue_name !== queue.name) {
    const retry = deps.retry ?? retryQueueOutboxEvent
    await retry(
      db,
      claim.event.id,
      claim.leaseToken,
      `Queue mismatch: expected ${claim.event.queue_name}, received ${queue.name}`,
      new Date(now.getTime() + 60_000),
      now
    )
    return "retry"
  }
  return publishClaim(db, queue, claim.event, claim.leaseToken, now, deps)
}

export async function dispatchNextQueueOutboxEvent(
  db: Db,
  queues: ReadonlyMap<string, QueuePublisher>,
  now = new Date(),
  deps: QueueOutboxDispatcherDeps = {}
): Promise<QueueOutboxDispatchResult> {
  const claimEvent = deps.claim ?? claimQueueOutboxEvent
  const claim = await claimEvent(db, { now })
  if (!claim) return "idle"
  const queue = queues.get(claim.event.queue_name)
  if (!queue) {
    const retry = deps.retry ?? retryQueueOutboxEvent
    await retry(
      db,
      claim.event.id,
      claim.leaseToken,
      `Unknown BullMQ queue: ${claim.event.queue_name}`,
      new Date(now.getTime() + 60_000),
      now
    )
    return "retry"
  }
  return publishClaim(db, queue, claim.event, claim.leaseToken, now, deps)
}

export function startQueueOutboxDispatcher(
  db: Db,
  queues: readonly QueuePublisher[]
): void {
  if (timer) return
  const byName = new Map(queues.map((queue) => [queue.name, queue]))
  let nextDeployReconciliation = 0
  const tick = () => {
    const deploy = byName.get("deploy")
    // Inspect Redis independently so a slow scan cannot delay outbox delivery.
    if (deploy?.getJob && !deployReconciliation && Date.now() >= nextDeployReconciliation) {
      nextDeployReconciliation = Date.now() + 60_000
      deployReconciliation = reconcileOrphanedPendingDeploys(db, {
        getJob: (id) => deploy.getJob!(id),
      }).then((resolved) => {
        if (resolved) log.warn({ resolved }, "orphaned pending deployments resolved")
      }).catch((error) => {
        log.warn({ error }, "pending deployment reconciliation failed")
      }).finally(() => {
        deployReconciliation = null
      })
    }
    if (running) return
    running = (async () => {
      try {
        while ((await dispatchNextQueueOutboxEvent(db, byName)) !== "idle") {
          // Drain all available intents before sleeping.
        }
      } catch (error) {
        log.warn({ error }, "queue outbox reconciliation failed")
      } finally {
        running = null
      }
    })()
  }
  tick()
  timer = setInterval(tick, POLL_MS)
}

export async function stopQueueOutboxDispatcher(): Promise<void> {
  if (timer) clearInterval(timer)
  timer = null
  await Promise.all([running, deployReconciliation])
}
