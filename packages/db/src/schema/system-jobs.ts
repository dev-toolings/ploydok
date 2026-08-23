// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm"
import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { users } from "./users"

export const system_jobs = pgTable(
  "system_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: ["gc.registry", "gc.images", "gc.buildcache", "gc.docker"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("pending"),
    requested_by_user_id: text("requested_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    source: text("source", {
      enum: ["api", "auto:deploy", "cron:gc", "system"],
    })
      .notNull()
      .default("api"),
    options: jsonb("options")
      .notNull()
      .default(sql`'{}'::jsonb`),
    queued_at: timestamp("queued_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    claimed_at: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    finished_at: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    error_message: text("error_message"),
    result: jsonb("result"),
  },
  (t) => [
    index("system_jobs_kind_status_idx").on(t.kind, t.status),
    index("system_jobs_status_idx").on(t.status),
  ]
)

export type SystemJobRow = typeof system_jobs.$inferSelect
export type SystemJobInsert = typeof system_jobs.$inferInsert
