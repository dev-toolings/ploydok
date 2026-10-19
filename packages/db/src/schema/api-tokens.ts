// SPDX-License-Identifier: AGPL-3.0-only
import {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  jsonb,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { users } from "./users"
import { projects } from "./projects"

export const api_tokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    token_hash: text("token_hash").notNull(),
    /**
     * bcrypt hash du token complet — défense-in-depth si la DB fuit.
     * NULL = token legacy (créé avant Sprint 6.5-bis Vague 2), authentifié par
     * lookup SHA-256 seul. Tokens créés à partir de la Vague 2 ont bcrypt_hash
     * non-NULL et le verify bcrypt est obligatoire en plus du lookup.
     */
    bcrypt_hash: text("bcrypt_hash"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["admin:*"]),
    last_used_at: timestamp("last_used_at", {
      withTimezone: true,
      mode: "date",
    }),
    created_at: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revoked_at: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    /** `mcp` tokens authenticate only on /mcp and are bound to `org_id`. */
    kind: text("kind").$type<"api" | "mcp">().notNull().default("api"),
    org_id: text("org_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    /** NULL = every app of `org_id`. */
    app_ids: jsonb("app_ids").$type<string[]>(),
  },
  (table) => [
    uniqueIndex("api_tokens_token_hash_unique").on(table.token_hash),
    check(
      "api_tokens_kind_check",
      sql`${table.kind} IN ('api', 'mcp') AND (${table.kind} = 'api' OR ${table.org_id} IS NOT NULL)`
    ),
  ]
)

export type ApiTokenRow = typeof api_tokens.$inferSelect
export type ApiTokenInsert = typeof api_tokens.$inferInsert
