// SPDX-License-Identifier: AGPL-3.0-only
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core"
import { apps } from "./apps"
import { users } from "./users"

export const builds = pgTable(
  "builds",
  {
    id: text("id").primaryKey(),
    app_id: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: [
        "pending",
        "running",
        "succeeded",
        "succeeded_with_warning",
        "failed",
        "cancelled",
      ],
    })
      .notNull()
      .default("pending"),
    build_method: text("build_method", {
      enum: [
        "docker",
        "dockerfile",
        "compose",
        "nixpacks",
        "railpack",
        "static",
      ],
    }),
    image_tag: text("image_tag"),
    image_update_from_digest: text("image_update_from_digest"),
    image_update_to_digest: text("image_update_to_digest"),
    image_update_previous_status: text("image_update_previous_status", {
      enum: ["running", "serving"],
    }),
    container_id: text("container_id"),
    runtime_ref: text("runtime_ref"),
    commit_sha: text("commit_sha"),
    commit_message: text("commit_message"),
    log_path: text("log_path"),
    log_archive: text("log_archive"),
    log_archive_raw_size: integer("log_archive_raw_size"),
    log_archive_compressed_size: integer("log_archive_compressed_size"),
    log_archived_at: timestamp("log_archived_at", {
      withTimezone: true,
      mode: "date",
    }),
    log_purged_at: timestamp("log_purged_at", {
      withTimezone: true,
      mode: "date",
    }),
    error_message: text("error_message"),
    // Set when post-deploy hook fails (build is still considered succeeded)
    post_deploy_error: text("post_deploy_error"),
    // Primary hostname selected for this healthy build, including DNS/TLS
    // actions still required. Restored with the runtime during rollback.
    routing_domain: text("routing_domain"),
    started_at: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finished_at: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    requested_by_user_id: text("requested_by_user_id").references(
      () => users.id
    ),
    source: text("source", {
      enum: [
        "api",
        "webhook:github",
        "webhook:gitlab",
        "cron:gc",
        "cron:cleanup",
        "auto:push",
        "auto:tag",
        "reconcile",
        "system",
      ],
    })
      .notNull()
      .default("api"),
    queued_at: timestamp("queued_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    claimed_at: timestamp("claimed_at", { withTimezone: true, mode: "date" }),
    cancel_requested_at: timestamp("cancel_requested_at", {
      withTimezone: true,
      mode: "date",
    }),
    cancel_requested_by_user_id: text("cancel_requested_by_user_id").references(
      () => users.id
    ),
  },
  (t) => [
    index("builds_app_id_idx").on(t.app_id),
    index("builds_status_idx").on(t.status),
    index("builds_finished_at_idx").on(t.finished_at),
  ]
)
