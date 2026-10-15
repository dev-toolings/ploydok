// SPDX-License-Identifier: AGPL-3.0-only
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core"
import { users } from "./users"

/**
 * One-time markers for GitHub installation links that predate the provider
 * installation cache. New links are never inserted here, so a later sync
 * cannot turn a new personal connection into an implicit organization grant.
 */
export const github_installation_legacy_backfill = pgTable(
  "github_installation_legacy_backfill",
  {
    installation_id: text("installation_id").notNull(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    consumed_at: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.installation_id, table.user_id],
      name: "github_installation_legacy_backfill_pkey",
    }),
  })
)
