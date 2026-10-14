// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, lte, inArray } from "drizzle-orm"
import type { Db } from "../client"
import {
  preview_deployments,
  type PreviewDeploymentInsert,
} from "../schema/preview-deployments"

/**
 * Insert a new preview deployment record.
 */
export async function insertPreviewDeployment(
  db: Db,
  data: PreviewDeploymentInsert
): Promise<void> {
  await db.insert(preview_deployments).values(data)
}

/**
 * Update a preview deployment (upsert pattern with catch on insert).
 */
export async function updatePreviewDeployment(
  db: Db,
  id: string,
  updates: Partial<PreviewDeploymentInsert>
): Promise<void> {
  await db
    .update(preview_deployments)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(preview_deployments.id, id))
}

/**
 * Update only the status field of a preview deployment.
 */
export async function updatePreviewDeploymentStatus(
  db: Db,
  id: string,
  status: "pending" | "building" | "running" | "tearing_down" | "torn_down" | "failed"
): Promise<void> {
  await db
    .update(preview_deployments)
    .set({ status, updated_at: new Date() })
    .where(eq(preview_deployments.id, id))
}

/**
 * Get a single preview deployment by ID.
 */
export async function getPreviewDeployment(
  db: Db,
  id: string
): Promise<typeof preview_deployments.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(preview_deployments)
    .where(eq(preview_deployments.id, id))
    .limit(1)
  return row
}

/**
 * Get all preview deployments for an app + PR.
 */
export async function getPreviewDeploymentByAppAndPr(
  db: Db,
  appId: string,
  prNumber: number
): Promise<typeof preview_deployments.$inferSelect | undefined> {
  const [row] = await db
    .select()
    .from(preview_deployments)
    .where(
      and(
        eq(preview_deployments.app_id, appId),
        eq(preview_deployments.pr_number, prNumber)
      )
    )
    .limit(1)
  return row
}

/**
 * List all non-torn-down preview deployments for an app.
 */
export async function listPreviewDeploymentsForApp(
  db: Db,
  appId: string
): Promise<Array<typeof preview_deployments.$inferSelect>> {
  return db
    .select()
    .from(preview_deployments)
    .where(
      and(
        eq(preview_deployments.app_id, appId),
        inArray(preview_deployments.status, ["running", "tearing_down"])
      )
    )
}

/**
 * List all expired preview deployments (expires_at < now).
 */
export async function listExpiredPreviews(
  db: Db
): Promise<Array<typeof preview_deployments.$inferSelect>> {
  const now = new Date()
  return db
    .select()
    .from(preview_deployments)
    .where(
      and(
        lte(preview_deployments.expires_at, now),
        inArray(preview_deployments.status, ["running", "tearing_down"])
      )
    )
}
