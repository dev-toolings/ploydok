// SPDX-License-Identifier: AGPL-3.0-only
import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  real,
  bigint,
  customType,
} from "drizzle-orm/pg-core"
import { projects } from "./projects"
import { registry_credentials } from "./registry_credentials"

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea"
  },
})

export const apps = pgTable("apps", {
  id: text("id").primaryKey(),
  project_id: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  status: text("status", {
    enum: [
      "created",
      "pending",
      "building",
      "running",
      "serving",
      "restarting",
      "stopped",
      "failed",
      "deleting",
    ],
  })
    .notNull()
    .default("created"),
  // Git source / image source.
  // `bitbucket` will be added in a later sprint; schema placeholder in docs only.
  git_provider: text("git_provider", { enum: ["github", "gitlab", "image"] }),
  repo_full_name: text("repo_full_name"),
  branch: text("branch"),
  github_installation_id: text("github_installation_id"),
  gitlab_project_id: integer("gitlab_project_id"),
  // Exact provider identity selected at creation time. Deploy workers must
  // never infer it from a repository owner/name.
  git_provider_installation_id: text("git_provider_installation_id"),
  gitlab_credential_user_id: text("gitlab_credential_user_id"),
  root_dir: text("root_dir"),
  dockerfile_path: text("dockerfile_path"),
  nixpacks_config_path: text("nixpacks_config_path"),
  node_version: text("node_version"),
  // Image source (git_provider = 'image').
  image_ref: text("image_ref"),
  image_pull_policy: text("image_pull_policy", {
    enum: ["always", "if_not_present"],
  }),
  registry_credential_id: text("registry_credential_id").references(
    () => registry_credentials.id,
    { onDelete: "set null" }
  ),
  // Auto-redeploy on new :latest digest (opt-in, checked by BullMQ repeat job).
  track_latest: boolean("track_latest").notNull().default(false),
  // Per-app dashboard metadata (cosmetic): theme-aware icon URL + quick links.
  icon_url: text("icon_url"),
  quick_links: text("quick_links"), // JSON array of { label, url }
  // Last registry manifest digest observed for image apps (auto-update watch).
  last_image_digest: text("last_image_digest"),
  // Digest reserved by an auto-update deploy that has not succeeded yet.
  pending_image_digest: text("pending_image_digest"),
  // Build overrides
  install_command: text("install_command"),
  build_command: text("build_command"),
  start_command: text("start_command"),
  // Explicit user selection is separate from the latest repository detection.
  // A null value means redeploy may detect again; a value is never replaced by
  // a later probe.
  framework_preset: text("framework_preset"),
  framework_detection: text("framework_detection"),
  watch_paths: text("watch_paths"), // JSON array
  build_method: text("build_method", {
    enum: [
      "auto",
      "docker",
      "dockerfile",
      "compose",
      "nixpacks",
      "railpack",
      "static",
    ],
  }),
  static_output_dir: text("static_output_dir").notNull().default("dist"),
  static_spa_fallback: boolean("static_spa_fallback").notNull().default(true),
  // CDN / edge delivery controls (Sprint 7 MF1).
  cdn_mode: text("cdn_mode", { enum: ["off", "internal", "external"] })
    .notNull()
    .default("off"),
  cdn_cache_ttl_s: integer("cdn_cache_ttl_s").default(300),
  cdn_cache_paths: text("cdn_cache_paths").array(),
  cdn_compression: boolean("cdn_compression").notNull().default(false),
  cdn_image_optim: boolean("cdn_image_optim").notNull().default(false),
  cdn_headers: text("cdn_headers"),
  cdn_external_provider: text("cdn_external_provider"),
  // Preview deployments (Sprint 7 MF2).
  preview_enabled: boolean("preview_enabled").notNull().default(false),
  preview_wildcard: text("preview_wildcard"),
  preview_ttl_days: integer("preview_ttl_days").notNull().default(7),
  // Runtime
  runtime_mode: text("runtime_mode", { enum: ["docker", "swarm"] })
    .notNull()
    .default("swarm"),
  container_id: text("container_id"),
  swarm_service_name: text("swarm_service_name"),
  swarm_service_names: text("swarm_service_names").array(),
  replicas: integer("replicas").notNull().default(1),
  update_order: text("update_order", {
    enum: ["start-first", "stop-first"],
  })
    .notNull()
    .default("start-first"),
  update_parallelism: integer("update_parallelism").notNull().default(1),
  update_delay_s: integer("update_delay_s").notNull().default(10),
  update_monitor_s: integer("update_monitor_s").notNull().default(30),
  failure_action: text("failure_action", {
    enum: ["rollback", "pause", "continue"],
  })
    .notNull()
    .default("rollback"),
  stop_grace_period_s: integer("stop_grace_period_s").notNull().default(10),
  runtime_port: integer("runtime_port"),
  restart_policy: text("restart_policy", {
    enum: ["no", "always", "unless-stopped", "on-failure"],
  })
    .notNull()
    .default("unless-stopped"),
  domain: text("domain"),
  domain_source: text("domain_source", {
    enum: ["generated", "custom"],
  })
    .notNull()
    .default("generated"),
  routing_status: text("routing_status", {
    enum: ["pending", "ready", "action_required"],
  })
    .notNull()
    .default("pending"),
  routing_error: text("routing_error"),
  routing_dns_status: text("routing_dns_status", {
    enum: ["valid", "missing", "mismatch", "error", "unknown"],
  }),
  routing_tls_status: text("routing_tls_status", {
    enum: ["issued", "pending", "failed", "not_required"],
  }),
  // Registry GC override (null → fall back to global default of 3).
  keep_per_repo: integer("keep_per_repo"),
  // Healthcheck (intervals in seconds to match migration)
  healthcheck_path: text("healthcheck_path"),
  healthcheck_port: integer("healthcheck_port"),
  healthcheck_interval_s: integer("healthcheck_interval_s"),
  healthcheck_timeout_s: integer("healthcheck_timeout_s"),
  healthcheck_retries: integer("healthcheck_retries"),
  healthcheck_start_period_s: integer("healthcheck_start_period_s"),
  // Runtime truth: Compose entrypoints may intentionally have no healthcheck;
  // normal Ploydok runtimes always receive an injected check.
  runtime_has_healthcheck: boolean("runtime_has_healthcheck"),
  // Quotas / plan. `custom` = no enforcement (back-compat for pre-sprint-3bis apps).
  plan: text("plan", { enum: ["nano", "small", "medium", "large", "custom"] })
    .notNull()
    .default("custom"),
  cpu_limit: real("cpu_limit"),
  mem_limit_bytes: bigint("mem_limit_bytes", { mode: "number" }),
  pids_limit: integer("pids_limit"),
  // Webhook / auto-deploy settings
  auto_deploy_enabled: boolean("auto_deploy_enabled").notNull().default(true),
  post_commit_status: boolean("post_commit_status").notNull().default(true),
  coalesce_pushes: boolean("coalesce_pushes").notNull().default(true),
  deploy_on_tag: boolean("deploy_on_tag").notNull().default(false),
  tag_pattern: text("tag_pattern"),
  // Per-app webhook secret (encrypted, distinct from the GitHub App global secret)
  webhook_secret: bytea("webhook_secret"),
  webhook_secret_old: bytea("webhook_secret_old"),
  webhook_secret_old_expires_at: timestamp("webhook_secret_old_expires_at", {
    withTimezone: true,
    mode: "date",
  }),
  // Protection — Caddy per-app middlewares (Wave 4)
  protection_basic_auth_enabled: boolean("protection_basic_auth_enabled")
    .notNull()
    .default(false),
  protection_basic_auth_user_enc: bytea("protection_basic_auth_user_enc"),
  protection_basic_auth_user_nonce: bytea("protection_basic_auth_user_nonce"),
  protection_basic_auth_pass_enc: bytea("protection_basic_auth_pass_enc"),
  protection_basic_auth_pass_nonce: bytea("protection_basic_auth_pass_nonce"),
  protection_ip_allowlist: text("protection_ip_allowlist").array(),
  protection_rate_limit_rps: integer("protection_rate_limit_rps"),
  // Custom Caddy handlers (Wave 4)
  caddy_extra_handlers: text("caddy_extra_handlers"),
  // Hooks placeholders — Wave 5 will implement; defined here to avoid extra migration
  hooks_pre_deploy: text("hooks_pre_deploy"),
  hooks_post_deploy: text("hooks_post_deploy"),
  hooks_timeout_s: integer("hooks_timeout_s").default(300),
  // Client-supplied idempotency key for create flows. Prevents double-clicks or
  // browser retries from creating duplicate apps.
  creation_idempotency_key: text("creation_idempotency_key"),
  // Timestamps
  created_at: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .$defaultFn(() => new Date()),
})
