// SPDX-License-Identifier: AGPL-3.0-only
import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { apps } from "./apps"
import { app_volumes } from "./app-volumes"
import { secrets } from "./secrets"
import { storage_destinations } from "./storage-destinations"

export const volume_backup_configs = pgTable(
  "volume_backup_configs",
  {
    id: text("id").primaryKey(),
    app_id: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    volume_id: text("volume_id")
      .notNull()
      .references(() => app_volumes.id, { onDelete: "cascade" }),
    // See backup_configs.destination_id for the legacy fallback rationale.
    destination_id: text("destination_id").references(
      () => storage_destinations.id
    ),
    destination_kind: text("destination_kind", { enum: ["s3", "azure", "local"] })
      .notNull()
      .default("local"),
    s3_endpoint: text("s3_endpoint"),
    s3_bucket: text("s3_bucket"),
    s3_prefix: text("s3_prefix"),
    s3_region: text("s3_region"),
    s3_credentials_secret_id: text("s3_credentials_secret_id").references(
      () => secrets.id,
      { onDelete: "set null" }
    ),
    schedule_cron: text("schedule_cron").notNull().default("0 3 * * *"),
    retention_days: integer("retention_days").notNull().default(7),
    age_recipient_public_key: text("age_recipient_public_key"),
    enabled: boolean("enabled").notNull().default(true),
    last_scheduled_at: timestamp("last_scheduled_at", {
      withTimezone: true,
      mode: "date",
    }),
    last_run_at: timestamp("last_run_at", { withTimezone: true, mode: "date" }),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    volumeUnique: uniqueIndex("volume_backup_configs_volume_idx").on(
      table.volume_id
    ),
  })
)

export type VolumeBackupConfigRow = typeof volume_backup_configs.$inferSelect
export type VolumeBackupConfigInsert = typeof volume_backup_configs.$inferInsert
