// SPDX-License-Identifier: AGPL-3.0-only
import { DelayedError } from "bullmq"
import type { Db } from "@ploydok/db"
import {
  DeployDeferredError,
  withAppDeployLease,
  type DeployLeaseOptions,
} from "./app-deploy-lock"

/** Keep the same live job, independently of its configured failure attempts. */
export async function runQueuedDeployWithLease(
  db: Db,
  appId: string,
  buildId: string,
  task: () => Promise<void>,
  job: { moveToDelayed(timestamp: number, token?: string): Promise<void> },
  token: string | undefined,
  leaseOptions: Omit<DeployLeaseOptions, "purpose"> = {}
): Promise<void> {
  try {
    await withAppDeployLease(db, appId, buildId, task, {
      ...leaseOptions,
      purpose: "deploy",
    })
  } catch (error) {
    if (!(error instanceof DeployDeferredError)) throw error
    await job.moveToDelayed(Date.now() + 5_000, token)
    // BullMQ recognizes this control signal and skips moveToFailed entirely.
    throw new DelayedError()
  }
}
