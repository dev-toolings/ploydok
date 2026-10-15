// SPDX-License-Identifier: AGPL-3.0-only
import {
  pgTable,
  text,
  bigint,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core"
import { apps } from "./apps"
import { app_volumes } from "./app-volumes"
import { volume_backup_configs } from "./volume_backup_configs"

export const volume_backups = pgTable(
  "volume_backups",
  {
    id: text("id").primaryKey(),
    app_id: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    volume_id: text("volume_id")
      .notNull()
      .references(() => app_volumes.id, { onDelete: "cascade" }),
    config_id: text("config_id").references(() => volume_backup_configs.id, {
      onDelete: "set null",
    }),
    destination_kind: text("destination_kind", { enum: ["s3", "azure", "local"] }),
    location: text("location").notNull(),
    size_bytes: bigint("size_bytes", { mode: "number" }),
    age_encrypted: boolean("age_encrypted").notNull().default(false),
    status: text("status", { enum: ["running", "succeeded", "failed"] })
      .notNull()
      .default("running"),
    error: text("error"),
    started_at: timestamp("started_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    finished_at: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    appVolumeStartedIdx: index("volume_backups_app_volume_started_idx").on(
      table.app_id,
      table.volume_id,
      table.started_at
    ),
  })
)

export type VolumeBackupRow = typeof volume_backups.$inferSelect
export type VolumeBackupInsert = typeof volume_backups.$inferInsert
