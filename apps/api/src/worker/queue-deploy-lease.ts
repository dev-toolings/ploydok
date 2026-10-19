// SPDX-License-Identifier: AGPL-3.0-only
import { DelayedError } from "bullmq"
import type { Db } from "@ploydok/db"
import { DeployDeferredError, withAppDeployLease } from "./app-deploy-lock"

/** Keep the same live job, independently of its configured failure attempts. */
export async function runQueuedDeployWithLease(
  db: Db,
  appId: string,
  buildId: string,
  task: () => Promise<void>,
  job: { moveToDelayed(timestamp: number, token?: string): Promise<void> },
  token: string | undefined,
  leaseOptions: Parameters<typeof withAppDeployLease>[4] = {}
): Promise<void> {
  try {
    await withAppDeployLease(db, appId, buildId, task, leaseOptions)
  } catch (error) {
    if (!(error instanceof DeployDeferredError)) throw error
    await job.moveToDelayed(Date.now() + 5_000, token)
    // BullMQ recognizes this control signal and skips moveToFailed entirely.
    throw new DelayedError()
  }
}
