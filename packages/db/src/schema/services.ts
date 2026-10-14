// SPDX-License-Identifier: AGPL-3.0-only
import { pgTable, text, timestamp, jsonb, boolean } from "drizzle-orm/pg-core"
import { projects } from "./projects"

export const services = pgTable("services", {
  id: text("id").primaryKey(),
  project_id: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  template_id: text("template_id").notNull(),
  template_version: text("template_version"),
  status: text("status", {
    enum: ["created", "pending", "running", "stopped", "failed", "deleting"],
  }).default("created"),
  runtime_mode: text("runtime_mode", { enum: ["docker", "swarm"] })
    .notNull()
    .default("swarm"),
  compose_raw: text("compose_raw").notNull(),
  generated_env: jsonb("generated_env").notNull().default({}),
  secrets_encrypted: boolean("secrets_encrypted").notNull().default(false),
  domain: text("domain"),
  container_ids: text("container_ids").array(),
  swarm_service_names: text("swarm_service_names").array(),
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
})

export type ServiceRow = typeof services.$inferSelect
export type ServiceInsert = typeof services.$inferInsert
