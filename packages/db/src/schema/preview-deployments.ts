// SPDX-License-Identifier: AGPL-3.0-only
import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { apps } from "./apps"

/**
 * Preview deployments per Pull Request (Sprint 7 MF2).
 * Une row par (app, pr_number) — sur push successif, on update head_sha + container_id.
 */
export const preview_deployments = pgTable(
  "preview_deployments",
  {
    id: text("id").primaryKey(),
    app_id: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    pr_number: integer("pr_number").notNull(),
    head_sha: text("head_sha").notNull(),
    domain: text("domain").notNull(),
    container_id: text("container_id"),
    queue_job_id: text("queue_job_id"),
    status: text("status", {
      enum: ["pending", "building", "running", "tearing_down", "torn_down", "failed"],
    })
      .notNull()
      .default("pending"),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("preview_deployments_app_pr_unique").on(t.app_id, t.pr_number),
    index("preview_deployments_app_idx").on(t.app_id),
    index("preview_deployments_status_idx").on(t.status),
  ]
)

export type PreviewDeploymentRow = typeof preview_deployments.$inferSelect
export type PreviewDeploymentInsert = typeof preview_deployments.$inferInsert
