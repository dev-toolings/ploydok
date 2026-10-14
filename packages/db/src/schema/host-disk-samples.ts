// SPDX-License-Identifier: AGPL-3.0-only
import {
  bigint,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"

export const host_disk_samples = pgTable(
  "host_disk_samples",
  {
    host_key: text("host_key").notNull(),
    bucket_at: timestamp("bucket_at", { withTimezone: true }).notNull(),
    measured_at: timestamp("measured_at", { withTimezone: true }).notNull(),
    used_bytes: bigint("used_bytes", { mode: "number" }).notNull(),
    total_bytes: bigint("total_bytes", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.host_key, table.bucket_at] })]
)

export type HostDiskSample = typeof host_disk_samples.$inferSelect
