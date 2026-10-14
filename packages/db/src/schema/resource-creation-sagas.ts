// SPDX-License-Identifier: AGPL-3.0-only
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  customType,
} from "drizzle-orm/pg-core"
import { projects } from "./projects"
import { users } from "./users"

export type CreationSagaResourceType = "application" | "database" | "service"
export type CreationSagaState =
  | "initializing"
  | "provisioning"
  | "compensating"
  | "failed"
  | "complete"
  | "compensated"

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea"
  },
})

export interface CreationSagaOwnedResources {
  containerIds?: string[]
  swarmServiceNames?: string[]
  containerId?: string
  containerName?: string
  networkName?: string
  routeId?: string
  volumeName?: string
  jobId?: string
}

export const resource_creation_sagas = pgTable(
  "resource_creation_sagas",
  {
    id: text("id").primaryKey(),
    resource_type: text("resource_type", {
      enum: ["application", "database", "service"],
    }).notNull(),
    resource_id: text("resource_id").notNull(),
    project_id: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    requested_by_user_id: text("requested_by_user_id").references(
      () => users.id,
      { onDelete: "set null" }
    ),
    state: text("state", {
      enum: [
        "initializing",
        "provisioning",
        "compensating",
        "failed",
        "complete",
        "compensated",
      ],
    })
      .notNull()
      .default("initializing"),
    completed_steps: text("completed_steps").array().notNull().default([]),
    owned_resources: jsonb("owned_resources")
      .$type<CreationSagaOwnedResources>()
      .notNull()
      .default({}),
    input_ciphertext: bytea("input_ciphertext"),
    input_nonce: bytea("input_nonce"),
    input_digest: text("input_digest"),
    lease_token: text("lease_token"),
    lease_until: timestamp("lease_until", {
      withTimezone: true,
      mode: "date",
    }),
    next_retry_at: timestamp("next_retry_at", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .$defaultFn(() => new Date()),
    max_attempts: integer("max_attempts").notNull().default(8),
    attempt_count: integer("attempt_count").notNull().default(0),
    last_error: text("last_error"),
    created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .$defaultFn(() => new Date()),
    completed_at: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    unique("resource_creation_sagas_resource_unique").on(
      table.resource_type,
      table.resource_id
    ),
    index("resource_creation_sagas_incomplete_idx").on(
      table.state,
      table.updated_at
    ),
  ]
)

export type ResourceCreationSagaRow =
  typeof resource_creation_sagas.$inferSelect
