// SPDX-License-Identifier: AGPL-3.0-only
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  index,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core"
import { github_app } from "./github_app"

export const provider_installations = pgTable(
  "provider_installations",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    external_id: text("external_id").notNull(),
    account_login: text("account_login").notNull(),
    account_type: text("account_type"),
    repository_selection: text("repository_selection"),
    suspended_at: timestamp("suspended_at", {
      withTimezone: true,
      mode: "date",
    }),
    html_url: text("html_url"),
    avatar_url: text("avatar_url"),
    repository_count: integer("repository_count"),
    // GitHub only: the App whose credentials sign this installation's tokens.
    github_app_id: text("github_app_id").references(() => github_app.id, {
      onDelete: "cascade",
    }),
    last_synced_at: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    uniqueProviderExternalId: unique(
      "uq_provider_installations_provider_external_id"
    ).on(t.provider, t.external_id),
  })
)

export const provider_repos = pgTable(
  "provider_repos",
  {
    id: text("id").notNull(),
    installation_id: text("installation_id")
      .notNull()
      .references(() => provider_installations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    full_name: text("full_name").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    default_branch: text("default_branch"),
    private: boolean("private").notNull().default(false),
    html_url: text("html_url"),
    pushed_at: timestamp("pushed_at", { withTimezone: true, mode: "date" }),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" }),
    last_synced_at: timestamp("last_synced_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
  },
  (t) => ({
    primaryKey: primaryKey({
      name: "provider_repos_pkey",
      columns: [t.installation_id, t.id],
    }),
    byInstallation: index("idx_provider_repos_install").on(t.installation_id),
    byFullName: index("idx_provider_repos_fullname").on(
      t.provider,
      t.full_name
    ),
    searchIdx: index("idx_provider_repos_search").on(t.full_name),
  })
)
