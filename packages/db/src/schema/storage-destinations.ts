// SPDX-License-Identifier: AGPL-3.0-only
import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import { projects } from "./projects"
import { secrets } from "./secrets"

/**
 * A reusable workspace backup destination. The credentials themselves live in
 * the encrypted secrets table; this row only stores the reference.
 */
export const storage_destinations = pgTable(
  "storage_destinations",
  {
    id: text("id").primaryKey(),
    org_id: text("org_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["s3", "azure", "local"] }).notNull(),
    /** Preset used to build the form; null for rows created before presets. */
    provider: text("provider"),
    // The s3_* columns predate Azure: for an Azure destination they hold the
    // blob endpoint and the container name.
    s3_endpoint: text("s3_endpoint"),
    s3_bucket: text("s3_bucket"),
    s3_region: text("s3_region"),
    /** Folder of a local destination under <storage root>/<org_id>/; fixed. */
    local_folder: text("local_folder"),
    credentials_secret_id: text("credentials_secret_id").references(
      () => secrets.id,
      { onDelete: "set null" }
    ),
    last_test_at: timestamp("last_test_at", {
      withTimezone: true,
      mode: "date",
    }),
    last_test_status: text("last_test_status", {
      enum: ["success", "failure"],
    }),
    last_test_error: text("last_test_error"),
    created_at: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .$defaultFn(() => new Date()),
    updated_at: timestamp("updated_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("storage_destinations_org_id_idx").on(table.org_id),
    uniqueIndex("storage_destinations_org_local_folder_uniq").on(
      table.org_id,
      table.local_folder
    ),
  ]
)

export type StorageDestinationRow = typeof storage_destinations.$inferSelect
export type StorageDestinationInsert = typeof storage_destinations.$inferInsert
