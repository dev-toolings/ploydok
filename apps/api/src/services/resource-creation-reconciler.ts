// SPDX-License-Identifier: AGPL-3.0-only
import { apps, builds, databases, queue_outbox_events } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import {
  beginClaimedCreationSagaCompensation,
  claimCreationSaga,
  completeClaimedCreationSaga,
  completeClaimedCreationSagaCompensation,
  fenceCreationSaga,
  listIncompleteCreationSagas,
  recordClaimedCreationSagaStep,
  retryClaimedCreationSaga,
} from "@ploydok/db/queries"
import { and, eq, inArray } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  compensateDatabaseCreation,
  resumeDatabaseCreation,
} from "../databases/spawner"
import { deployQueue } from "../worker/queues"
import { enqueueWithDbRow } from "../worker/queue-enqueue"
import {
  compensateApplicationCreation,
  resumeApplicationConfiguration,
} from "./application-creation-saga"
import { resumeServiceCreation } from "./marketplace-orchestrator"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"

const log = childLogger("resource-creation-reconciler")

export interface ResourceCreationReconcileResult {
  scanned: number
  completed: number
  failed: number
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null
let reconcileRunning: Promise<unknown> | null = null

export function startResourceCreationReconciler(db: Db): void {
  if (reconcileTimer) return
  const tick = () => {
    if (reconcileRunning) return
    reconcileRunning = reconcileResourceCreations(db)
      .catch((err) => {
        log.warn({ err }, "resource creation reconciliation poll failed")
      })
      .finally(() => {
        reconcileRunning = null
      })
  }
  tick()
  reconcileTimer = setInterval(tick, 5_000)
}

export async function stopResourceCreationReconciler(): Promise<void> {
  if (reconcileTimer) clearInterval(reconcileTimer)
  reconcileTimer = null
  await reconcileRunning
}

export async function reconcileResourceCreations(
  db: Db
): Promise<ResourceCreationReconcileResult> {
  const sagas = await listIncompleteCreationSagas(db)
  const result = { scanned: sagas.length, completed: 0, failed: 0 }

  for (const saga of sagas) {
    let claim: Awaited<ReturnType<typeof claimCreationSaga>> = null
    try {
      if (saga.resource_type === "service") {
        if (await resumeServiceCreation({ db, agent: getSharedAgent() }, saga.resource_id)) result.completed += 1
        continue
      }
      if (saga.resource_type === "database") {
        claim = await claimCreationSaga(db, "database", saga.resource_id)
        if (!claim) continue
        const rows = await db
          .select()
          .from(databases)
          .where(eq(databases.id, saga.resource_id))
          .limit(1)
        const row = rows[0]
        if (!row) {
          if (
            !(await beginClaimedCreationSagaCompensation(
              db,
              "database",
              saga.resource_id,
              claim.token
            ))
          ) {
            continue
          }
          if (
            !(await completeClaimedCreationSagaCompensation(
              db,
              "database",
              saga.resource_id,
              claim.token,
              "database row no longer exists"
            ))
          ) {
            throw new Error("database creation saga lease lost at terminalization")
          }
        } else if (
          claim.saga.state === "compensating" ||
          !claim.saga.requested_by_user_id ||
          claim.saga.attempt_count >= claim.saga.max_attempts
        ) {
          await compensateDatabaseCreation(
            db,
            row,
            claim.token,
            claim.saga.requested_by_user_id
              ? `creation remained incomplete after ${claim.saga.max_attempts} attempts`
              : "creation actor no longer exists"
          )
        } else {
          const requestedBy = claim.saga.requested_by_user_id
          // resumeDatabaseCreation acquires its own lease, so release this
          // discovery claim as an immediately available retry first.
          await retryClaimedCreationSaga(
            db,
            "database",
            saga.resource_id,
            claim.token,
            "resume delegated",
            new Date()
          )
          claim = null
          await resumeDatabaseCreation(db, row, requestedBy)
        }
      } else {
        claim = await claimCreationSaga(db, "application", saga.resource_id)
        if (!claim) continue
        const appRows = await db
          .select({ id: apps.id })
          .from(apps)
          .where(eq(apps.id, saga.resource_id))
          .limit(1)
        if (
          !appRows[0] ||
          !claim.saga.requested_by_user_id ||
          claim.saga.state === "compensating" ||
          claim.saga.attempt_count >= claim.saga.max_attempts
        ) {
          if (
            !(await beginClaimedCreationSagaCompensation(
              db,
              "application",
              saga.resource_id,
              claim.token
            ))
          ) {
            continue
          }
          await compensateApplicationCreation(
            db,
            claim.saga,
            claim.token,
            !appRows[0]
              ? "application row no longer exists"
              : claim.saga.requested_by_user_id
                ? `creation remained incomplete after ${claim.saga.max_attempts} attempts`
                : "creation actor no longer exists"
          )
          result.completed += 1
          continue
        }

        const requestedByUserId = claim.saga.requested_by_user_id
        const durableJobId = claim.saga.owned_resources.jobId
        const durableBuildRows = await db
          .select({ id: builds.id, outboxId: queue_outbox_events.id })
          .from(builds)
          .innerJoin(
            queue_outbox_events,
            and(
              eq(queue_outbox_events.source_row_id, builds.id),
              eq(queue_outbox_events.queue_name, "deploy"),
              eq(queue_outbox_events.job_name, "deploy.requested")
            )
          )
          .where(
            durableJobId
              ? and(
                  eq(builds.id, durableJobId),
                  eq(builds.app_id, saga.resource_id)
                )
              : and(
                  eq(builds.app_id, saga.resource_id),
                  inArray(builds.source, ["api", "reconcile"])
                )
          )
          .limit(2)
        if (durableBuildRows.length > 1) {
          throw new Error("application creation saga has ambiguous durable builds")
        }
        if (durableJobId && durableBuildRows.length === 0) {
          throw new Error("application creation saga durable build/outbox is missing")
        }
        if (durableBuildRows[0]) {
          if (!durableJobId) {
            const recorded = await recordClaimedCreationSagaStep(
              db,
              "application",
              saga.resource_id,
              claim.token,
              "deploy_job_persisted",
              { jobId: durableBuildRows[0].id }
            )
            if (!recorded) {
              throw new Error("application creation saga lease lost at recovery")
            }
          }
          if (
            !(await completeClaimedCreationSaga(
              db,
              "application",
              saga.resource_id,
              claim.token
            ))
          ) {
            throw new Error("application creation saga lease lost at recovery")
          }
          result.completed += 1
          continue
        }
        await resumeApplicationConfiguration(db, claim.saga, claim.token)
        if (
          !(await fenceCreationSaga(
            db,
            "application",
            saga.resource_id,
            claim.token
          ))
        ) {
          throw new Error("application creation saga lease lost")
        }
        const accepted = await enqueueWithDbRow({
          db,
          queue: deployQueue,
          jobName: "deploy.requested",
          insertRow: async (tx) => {
            await tx
              .update(apps)
              .set({ status: "pending", updated_at: new Date() })
              .where(eq(apps.id, saga.resource_id))
            const row = await tx
              .insert(builds)
              .values({
                id: nanoid(),
                app_id: saga.resource_id,
                requested_by_user_id: requestedByUserId,
                source: "reconcile",
              })
              .returning()
              .then((rows: (typeof builds.$inferSelect)[]) => rows[0]!)
            if (
              !(await recordClaimedCreationSagaStep(
                tx,
                "application",
                saga.resource_id,
                claim!.token,
                "deploy_job_persisted",
                { jobId: row.id }
              ))
            ) {
              throw new Error("application creation saga lease lost before outbox")
            }
            return row
          },
          buildPayload: (row) => ({ buildId: row.id }),
          jobOptions: { attempts: 1 },
        })
        if (
          accepted.jobId !== accepted.row.id ||
          !(await completeClaimedCreationSaga(
            db,
            "application",
            saga.resource_id,
            claim.token
          ))
        ) {
          throw new Error("application creation saga lease lost at completion")
        }
      }
      result.completed += 1
    } catch (error) {
      if (claim) {
        const retryAt = new Date(
          Date.now() +
            Math.min(60_000, 1_000 * 2 ** Math.min(claim.saga.attempt_count, 6))
        )
        await retryClaimedCreationSaga(
          db,
          claim.saga.resource_type,
          claim.saga.resource_id,
          claim.token,
          error,
          retryAt
        ).catch(() => false)
      }
      result.failed += 1
    }
  }
  return result
}
