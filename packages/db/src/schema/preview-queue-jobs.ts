// SPDX-License-Identifier: AGPL-3.0-only
import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core"

// Immutable snapshots. Redis carries only this row's reference.
export const preview_queue_jobs = pgTable("preview_queue_jobs", {
  id: text("id").primaryKey(),
  app_id: text("app_id").notNull(),
  pr_number: integer("pr_number").notNull(),
  action: text("action", { enum: ["deploy", "teardown"] }).notNull(),
  head_sha: text("head_sha"),
  requested_by_user_id: text("requested_by_user_id"),
  source: text("source").notNull(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().$defaultFn(() => new Date()),
  completed_at: timestamp("completed_at", { withTimezone: true, mode: "date" }),
})
