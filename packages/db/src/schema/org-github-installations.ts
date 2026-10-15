// SPDX-License-Identifier: AGPL-3.0-only
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core"
import { projects } from "./projects"
import { provider_installations } from "./provider_repos"
import { users } from "./users"

/**
 * Explicit grants that make a GitHub App installation visible to a Ploydok
 * organization. A user link proves who completed the GitHub flow; it does not
 * grant the installation to every organization that user can enter.
 */
export const org_github_installations = pgTable(
  "org_github_installations",
  {
    org_id: text("org_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    installation_id: text("installation_id")
      .notNull()
      .references(() => provider_installations.id, { onDelete: "cascade" }),
    granted_by: text("granted_by").references(() => users.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.org_id, table.installation_id],
      name: "org_github_installations_pkey",
    }),
    byInstallation: index("org_github_installations_installation_idx").on(
      table.installation_id
    ),
  })
)

