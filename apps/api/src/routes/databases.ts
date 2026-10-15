// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import { z } from "zod"
import { and, desc, eq, isNotNull, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  apps,
  databases,
  app_db_links,
  backup_configs,
  backups,
  projects,
  memberships,
} from "@ploydok/db"
import { createDb } from "@ploydok/db"
import type { DatabaseRow, Db } from "@ploydok/db"
import { env } from "../env"
import { requireTotpVerified } from "../auth/second-factor"
import {
  spawnDatabase,
  getConnectionString,
  getConnectionPassword,
  recreateDatabaseContainer,
  resumeDatabaseCreation,
  removeDatabasePublicProxy,
  startDatabaseContainer,
  stopDatabaseContainer,
} from "../databases/spawner"
import {
  rotatePassword,
  RotationInProgressError,
  RotationFailedError,
} from "../databases/rotation"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import type { AuthUser } from "../auth/middleware"
import { ensureDefaultOrganizationForUser } from "../services/organizations"
import { encryptSecret } from "../secrets/crypto"
import { normalizePostgresConnectionString } from "../databases/connection-strings"
import { createAdminerSession, isAdminerSupportedDatabase } from "../adminer"
import { requireScope } from "../auth/require-scope"
import { backupDeadlineTimestampSeconds } from "../backups/freshness"

const log = childLogger("databases.routes")

type AppEnv = { Variables: { user?: AuthUser } }

function getUser(c: { get: (k: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

function isUniqueConstraintError(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== "object") return false
  const record = err as Record<string, unknown>
  return (
    record["code"] === "23505" &&
    (record["constraint"] === constraint ||
      String(record["message"] ?? "").includes(constraint))
  )
}

async function findDatabaseByCreationKey(
  db: Db,
  projectId: string,
  key: string
): Promise<DatabaseRow | null> {
  const rows = await db
    .select({ db: databases })
    .from(databases)
    .where(
      and(
        eq(databases.project_id, projectId),
        eq(databases.creation_idempotency_key, key)
      )
    )
    .limit(1)
  return rows[0]?.db ?? null
}

const KindEnum = z.enum([
  "postgres",
  "mysql",
  "mariadb",
  "redis",
  "mongo",
  "libsql",
])
const PlanEnum = z.enum(["small", "medium", "large"])
const ExposureModeEnum = z.enum(["internal", "direct_port", "public_proxy"])
const IdempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/, "Invalid idempotency key")

const CreateDatabaseBody = z
  .object({
    organizationId: z.string().min(1).optional(),
    projectId: z.string().min(1),
    kind: KindEnum,
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
    plan: PlanEnum,
    exposureMode: ExposureModeEnum.optional(),
    publicEnabled: z.boolean().optional(),
    idempotencyKey: IdempotencyKey.optional(),
  })
  .or(
    z.object({
      organizationId: z.string().min(1),
      projectId: z.string().min(1).optional(),
      kind: KindEnum,
      name: z
        .string()
        .min(1)
        .max(64)
        .regex(
          /^[a-z0-9-]+$/,
          "Name must be lowercase alphanumeric with dashes"
        ),
      plan: PlanEnum,
      exposureMode: ExposureModeEnum.optional(),
      publicEnabled: z.boolean().optional(),
      idempotencyKey: IdempotencyKey.optional(),
    })
  )

const UpdateNetworkBody = z.object({
  exposureMode: ExposureModeEnum.default("internal"),
  publicEnabled: z.boolean().default(false),
})

const RegisterExternalPostgresBody = z.object({
  organizationId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with dashes"),
  connectionString: z.string().min(1).max(2_048),
})

function listShape(row: DatabaseRow) {
  return {
    id: row.id,
    // See serializeApp() in routes/apps.ts for the rationale on why
    // organization_id and project_id are both projections of projects.id.
    organization_id: row.project_id,
    project_id: row.project_id,
    kind: row.kind,
    version: row.version,
    name: row.name,
    plan: row.plan,
    management_mode: row.management_mode,
    status: row.status,
    health_status: row.health_status,
    host: row.host,
    port: row.port,
    internal_host: row.host,
    internal_port: row.port,
    exposure_mode: row.exposure_mode,
    public_enabled: row.public_enabled,
    public_host: row.public_host,
    public_port: row.public_port,
    public_url: row.public_url,
    rotation_schedule: row.rotation_schedule,
    rotation_in_progress: row.rotation_in_progress,
    password_rotated_at: row.password_rotated_at,
    last_started_at: row.last_started_at,
    created_at: row.created_at,
  }
}

type BackupSummary = {
  backup_enabled: boolean | null
  backup_schedule_cron: string | null
  backup_configured_at: Date | null
  latest_backup_status: "running" | "succeeded" | "failed" | null
  latest_backup_at: Date | null
  last_successful_backup_at: Date | null
  linked_apps: LinkedApp[] | null
}

type LinkedApp = {
  app_id: string
  app_name: string | null
  app_slug: string | null
  env_prefix: string
}

function listShapeWithBackupSummary(row: DatabaseRow, summary: BackupSummary) {
  const backupDeadline =
    summary.backup_schedule_cron === null
      ? null
      : backupDeadlineTimestampSeconds({
          schedule_cron: summary.backup_schedule_cron,
          configured_at: summary.backup_configured_at,
          last_success_at: summary.last_successful_backup_at,
        })

  return {
    ...listShape(row),
    backup_enabled: summary.backup_enabled ?? false,
    backup_deadline_at:
      backupDeadline === null
        ? null
        : new Date(backupDeadline * 1_000).toISOString(),
    latest_backup_status: summary.latest_backup_status,
    latest_backup_at: summary.latest_backup_at?.toISOString() ?? null,
    last_successful_backup_at:
      summary.last_successful_backup_at?.toISOString() ?? null,
    linked_apps: summary.linked_apps ?? [],
  }
}

function isExternalDatabase(row: DatabaseRow): boolean {
  return row.management_mode === "external"
}

function parseExternalPostgresConnectionString(input: string): {
  connectionString: string
  host: string
  port: number
} {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error("Connection string must be a valid PostgreSQL URL")
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Only PostgreSQL connection strings are supported")
  }
  if (!url.hostname) {
    throw new Error("Connection string must include a host")
  }
  if (!url.username) {
    throw new Error("Connection string must include a user")
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("Connection string must include a database name")
  }

  const rawPort = url.port || "5432"
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Connection string port is invalid")
  }

  return {
    connectionString: normalizePostgresConnectionString(input),
    host: url.hostname,
    port,
  }
}

async function getDbForUser(db: Db, dbId: string, userId: string) {
  const rows = await db
    .select({ db: databases })
    .from(databases)
    .innerJoin(projects, eq(databases.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(databases.id, dbId))
    .limit(1)
  return rows[0]?.db ?? null
}

async function getDbForOwner(db: Db, dbId: string, userId: string) {
  const rows = await db
    .select({ id: databases.id })
    .from(databases)
    .innerJoin(projects, eq(databases.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        eq(memberships.role, "owner"),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(databases.id, dbId))
    .limit(1)
  return Boolean(rows[0])
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDatabasesRouter(db: Db): Hono<any, any, any> {
  const router = new Hono<AppEnv>()
  const totpMiddleware = requireTotpVerified(db)
  const databasesRead = requireScope("databases:read")
  const databasesWrite = requireScope("databases:write")
  const ownerOnly: MiddlewareHandler = async (c, next) => {
    const user = getUser(c)
    if (!(await getDbForOwner(db, c.req.param("id")!, user.id))) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    await next()
  }

  // POST /databases — spawn a new managed database
  router.post("/", databasesWrite, async (c) => {
    const user = getUser(c)
    const body = await c.req.json().catch(() => null)
    const parsed = CreateDatabaseBody.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        400
      )
    }
    const { kind, name, plan } = parsed.data
    const exposureMode = parsed.data.exposureMode ?? "internal"
    const publicEnabled = parsed.data.publicEnabled ?? false
    const requestedOrganizationId =
      parsed.data.organizationId ?? parsed.data.projectId
    const projectId = requestedOrganizationId
      ? requestedOrganizationId
      : (await ensureDefaultOrganizationForUser(db, user.id, user.display_name))
          .id

    const projectRows = await db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(
        memberships,
        and(
          eq(memberships.org_id, projects.id),
          eq(memberships.user_id, user.id),
          eq(memberships.role, "owner"),
          isNotNull(memberships.accepted_at)
        )
      )
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!projectRows[0]) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Project not found" } },
        404
      )
    }

    const creationKey = parsed.data.idempotencyKey ?? null
    if (creationKey) {
      const existing = await findDatabaseByCreationKey(
        db,
        projectId,
        creationKey
      )
      if (existing) {
        try {
          if (existing.status !== "running") {
            await resumeDatabaseCreation(db, existing, user.id)
          }
          return c.json({ id: existing.id }, 200)
        } catch (err) {
          log.error(
            { err, databaseId: existing.id },
            "database creation resume failed"
          )
          return c.json(
            {
              error: {
                code: "SPAWN_ERROR",
                message: "Failed to resume database creation",
              },
            },
            500
          )
        }
      }
    }

    try {
      const result = await spawnDatabase(db, {
        projectId,
        ownerId: user.id,
        kind,
        name,
        plan,
        exposureMode,
        publicEnabled,
        creationIdempotencyKey: creationKey,
      })
      return c.json({ id: result.id }, 201)
    } catch (err) {
      if (
        creationKey &&
        isUniqueConstraintError(
          err,
          "databases_project_creation_idempotency_key_unique"
        )
      ) {
        const existing = await findDatabaseByCreationKey(
          db,
          projectId,
          creationKey
        )
        if (existing) {
          await resumeDatabaseCreation(db, existing, user.id)
          return c.json({ id: existing.id }, 200)
        }
      }
      log.error({ err, projectId, kind, name }, "database spawn failed")
      return c.json(
        { error: { code: "SPAWN_ERROR", message: "Failed to spawn database" } },
        500
      )
    }
  })

  // POST /databases/external — register an existing PostgreSQL endpoint
  router.post("/external", databasesWrite, async (c) => {
    const user = getUser(c)
    const body = await c.req.json().catch(() => null)
    const parsed = RegisterExternalPostgresBody.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        400
      )
    }

    const requestedOrganizationId =
      parsed.data.organizationId ?? parsed.data.projectId
    const projectId = requestedOrganizationId
      ? requestedOrganizationId
      : (await ensureDefaultOrganizationForUser(db, user.id, user.display_name))
          .id

    const projectRows = await db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(
        memberships,
        and(
          eq(memberships.org_id, projects.id),
          eq(memberships.user_id, user.id),
          eq(memberships.role, "owner"),
          isNotNull(memberships.accepted_at)
        )
      )
      .where(eq(projects.id, projectId))
      .limit(1)
    if (!projectRows[0]) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Project not found" } },
        404
      )
    }

    let external: ReturnType<typeof parseExternalPostgresConnectionString>
    try {
      external = parseExternalPostgresConnectionString(
        parsed.data.connectionString
      )
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Invalid connection string"
      return c.json({ error: { code: "VALIDATION_ERROR", message } }, 400)
    }

    const id = nanoid()
    const { enc, nonce } = await encryptSecret(external.connectionString)

    await db.insert(databases).values({
      id,
      project_id: projectId,
      kind: "postgres",
      version: "external",
      name: parsed.data.name,
      plan: "small",
      management_mode: "external",
      volume_name: `external-${id}`,
      connection_string_enc: enc,
      connection_string_nonce: nonce,
      status: "running",
      health_status: "unknown",
      host: external.host,
      port: external.port,
      exposure_mode: "internal",
      public_enabled: false,
      public_port: null,
      public_host: null,
      public_url: null,
      last_started_at: null,
    })

    log.info(
      { dbId: id, projectId, host: external.host, port: external.port },
      "external postgres database registered"
    )

    return c.json({ id }, 201)
  })

  // GET /databases?projectId=... — list databases without connection strings
  router.get("/", databasesRead, async (c) => {
    const user = getUser(c)
    const projectId = c.req.query("projectId") ?? c.req.query("organizationId")

    // Every summary is joined into this list query. The lateral subqueries only
    // inspect rows belonging to an accessible database, avoiding N+1 requests
    // and a full backups-table DISTINCT ON scan on every UI poll.
    const backupProtection = db
      .select({
        backup_enabled: sql<boolean>`bool_or(${backup_configs.enabled})`.as(
          "backup_enabled"
        ),
        backup_config_id: sql<string | null>`(
          array_agg(
            ${backup_configs.id}
            ORDER BY ${backup_configs.created_at} DESC, ${backup_configs.id} DESC
          ) FILTER (WHERE ${backup_configs.enabled})
        )[1]`.as("backup_config_id"),
        backup_schedule_cron: sql<string | null>`(
          array_agg(
            ${backup_configs.schedule_cron}
            ORDER BY ${backup_configs.created_at} DESC, ${backup_configs.id} DESC
          ) FILTER (WHERE ${backup_configs.enabled})
        )[1]`.as("backup_schedule_cron"),
        backup_configured_at: sql<Date | null>`(
          array_agg(
            ${backup_configs.created_at}
            ORDER BY ${backup_configs.created_at} DESC, ${backup_configs.id} DESC
          ) FILTER (WHERE ${backup_configs.enabled})
        )[1]`.as("backup_configured_at"),
      })
      .from(backup_configs)
      .where(eq(backup_configs.database_id, databases.id))
      .as("backup_protection")

    const latestBackup = db
      .select({
        status: backups.status,
        started_at: backups.started_at,
      })
      .from(backups)
      .where(
        and(
          eq(backups.database_id, databases.id),
          eq(backups.config_id, backupProtection.backup_config_id)
        )
      )
      .orderBy(desc(backups.started_at), desc(backups.id))
      .limit(1)
      .as("latest_backup")

    const lastSuccessfulBackup = db
      .select({
        finished_at: backups.finished_at,
      })
      .from(backups)
      .where(
        and(
          eq(backups.database_id, databases.id),
          eq(backups.config_id, backupProtection.backup_config_id),
          eq(backups.status, "succeeded"),
          isNotNull(backups.finished_at)
        )
      )
      .orderBy(desc(backups.finished_at), desc(backups.id))
      .limit(1)
      .as("last_successful_backup")

    const linkedApps = db
      .select({
        linked_apps: sql<LinkedApp[]>`
          coalesce(
            json_agg(
              json_build_object(
                'app_id', ${app_db_links.app_id},
                'app_name', ${apps.name},
                'app_slug', ${apps.slug},
                'env_prefix', ${app_db_links.env_prefix}
              )
              order by ${app_db_links.app_id}, ${app_db_links.env_prefix}
            ),
            '[]'::json
          )
        `.as("linked_apps"),
      })
      .from(app_db_links)
      .innerJoin(
        apps,
        and(
          eq(app_db_links.app_id, apps.id),
          eq(apps.project_id, databases.project_id)
        )
      )
      .where(eq(app_db_links.database_id, databases.id))
      .as("linked_apps")

    let query = db
      .select({
        db: databases,
        backup_enabled: backupProtection.backup_enabled,
        backup_schedule_cron: backupProtection.backup_schedule_cron,
        backup_configured_at: backupProtection.backup_configured_at,
        latest_backup_status: latestBackup.status,
        latest_backup_at: latestBackup.started_at,
        last_successful_backup_at: lastSuccessfulBackup.finished_at,
        linked_apps: linkedApps.linked_apps,
      })
      .from(databases)
      .innerJoin(projects, eq(databases.project_id, projects.id))
      .innerJoin(
        memberships,
        and(
          eq(memberships.org_id, projects.id),
          eq(memberships.user_id, user.id),
          isNotNull(memberships.accepted_at)
        )
      )
      .leftJoinLateral(backupProtection, sql`true`)
      .leftJoinLateral(latestBackup, sql`true`)
      .leftJoinLateral(lastSuccessfulBackup, sql`true`)
      .leftJoinLateral(linkedApps, sql`true`)

    if (projectId) {
      query = query.where(eq(databases.project_id, projectId)) as typeof query
    }

    const rows = await query

    return c.json(
      rows.map((row) =>
        listShapeWithBackupSummary(row.db, {
          backup_enabled: row.backup_enabled,
          backup_schedule_cron: row.backup_schedule_cron,
          backup_configured_at: row.backup_configured_at,
          latest_backup_status: row.latest_backup_status,
          latest_backup_at: row.latest_backup_at,
          last_successful_backup_at: row.last_successful_backup_at,
          linked_apps: row.linked_apps,
        })
      )
    )
  })

  // GET /databases/:id — detail without connection string plaintext
  router.get("/:id", databasesRead, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")!

    const row = await getDbForUser(db, dbId, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }

    const links = await db
      .select({
        app_id: app_db_links.app_id,
        app_name: apps.name,
        app_slug: apps.slug,
        env_prefix: app_db_links.env_prefix,
      })
      .from(app_db_links)
      .leftJoin(
        apps,
        and(
          eq(app_db_links.app_id, apps.id),
          eq(apps.project_id, row.project_id)
        )
      )
      .where(eq(app_db_links.database_id, dbId))

    return c.json({
      ...listShape(row),
      linked_apps: links,
      connections: {
        internal: {
          host: row.host,
          port: row.port,
        },
        public: row.public_enabled
          ? {
              exposure_mode: row.exposure_mode,
              host: row.public_host,
              port: row.public_port,
              url: row.public_url,
            }
          : null,
      },
    })
  })

  // POST /databases/:id/reveal — returns connection string (client-side confirmation only)
  router.post("/:id/reveal", databasesRead, ownerOnly, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")

    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    try {
      const [connectionString, password] = await Promise.all([
        getConnectionString(row),
        getConnectionPassword(row),
      ])
      return c.json({ connection_string: connectionString, password })
    } catch {
      return c.json(
        {
          error: {
            code: "UNAVAILABLE",
            message: "Connection string not available",
          },
        },
        503
      )
    }
  })

  router.post(
    "/:id/adminer/session",
    databasesRead,
    ownerOnly,
    totpMiddleware,
    async (c) => {
      const user = getUser(c)
      const dbId = c.req.param("id")

      const row = await getDbForUser(db, dbId!, user.id)
      if (!row) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Database not found" } },
          404
        )
      }
      if (!isAdminerSupportedDatabase(row)) {
        return c.json(
          {
            error: {
              code: "UNSUPPORTED_DATABASE_KIND",
              message: "Adminer is only available for managed SQL databases",
            },
          },
          400
        )
      }
      if (row.status !== "running") {
        return c.json(
          {
            error: {
              code: "DATABASE_NOT_RUNNING",
              message: "Database must be running before opening Adminer",
            },
          },
          409
        )
      }

      try {
        const session = await createAdminerSession(db, row, user.id)
        return c.json(session, 201)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn({ err, dbId: row.id }, "adminer session creation failed")
        return c.json(
          { error: { code: "ADMINER_SESSION_FAILED", message } },
          500
        )
      }
    }
  )

  // Statuses in which a mutation (start/stop/restart/network-change) is
  // already in flight. A second mutation kicked off from a double-click would
  // race with the first inside the spawner, double-calling containerStart /
  // containerCreate on the same db. Reject as CONFLICT; the client retries
  // once it sees the status settle.
  const BUSY_STATUSES = new Set<string>(["creating", "starting"])

  router.post("/:id/start", databasesWrite, ownerOnly, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")
    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    if (isExternalDatabase(row)) {
      return c.json(
        {
          error: {
            code: "UNSUPPORTED_DATABASE_MODE",
            message: "External databases are not started by Ploydok",
          },
        },
        400
      )
    }
    if (BUSY_STATUSES.has(row.status)) {
      return c.json(
        { error: { code: "CONFLICT", message: "Database is busy" } },
        409
      )
    }

    try {
      await startDatabaseContainer(db, row, { ownerId: user.id })
      return c.json({ ok: true })
    } catch (err) {
      log.error({ err, dbId: row.id }, "start database failed")
      return c.json(
        { error: { code: "START_FAILED", message: "Start failed" } },
        500
      )
    }
  })

  router.post("/:id/stop", databasesWrite, ownerOnly, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")
    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    if (isExternalDatabase(row)) {
      return c.json(
        {
          error: {
            code: "UNSUPPORTED_DATABASE_MODE",
            message: "External databases are not stopped by Ploydok",
          },
        },
        400
      )
    }
    if (BUSY_STATUSES.has(row.status)) {
      return c.json(
        { error: { code: "CONFLICT", message: "Database is busy" } },
        409
      )
    }

    try {
      await stopDatabaseContainer(db, row)
      return c.json({ ok: true })
    } catch (err) {
      log.error({ err, dbId: row.id }, "stop database failed")
      return c.json(
        { error: { code: "STOP_FAILED", message: "Stop failed" } },
        500
      )
    }
  })

  router.post("/:id/restart", databasesWrite, ownerOnly, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")
    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    if (isExternalDatabase(row)) {
      return c.json(
        {
          error: {
            code: "UNSUPPORTED_DATABASE_MODE",
            message: "External databases are not restarted by Ploydok",
          },
        },
        400
      )
    }
    if (BUSY_STATUSES.has(row.status)) {
      return c.json(
        { error: { code: "CONFLICT", message: "Database is busy" } },
        409
      )
    }

    try {
      await recreateDatabaseContainer(db, row, {
        exposureMode: row.exposure_mode as
          "internal" | "direct_port" | "public_proxy",
        publicEnabled: row.public_enabled,
        ownerId: user.id,
      })
      return c.json({ ok: true })
    } catch (err) {
      log.error({ err, dbId: row.id }, "restart database failed")
      return c.json(
        { error: { code: "RESTART_FAILED", message: "Restart failed" } },
        500
      )
    }
  })

  router.patch("/:id/network", databasesWrite, ownerOnly, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")
    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    if (isExternalDatabase(row)) {
      return c.json(
        {
          error: {
            code: "UNSUPPORTED_DATABASE_MODE",
            message: "External database network is managed outside Ploydok",
          },
        },
        400
      )
    }
    if (BUSY_STATUSES.has(row.status)) {
      return c.json(
        { error: { code: "CONFLICT", message: "Database is busy" } },
        409
      )
    }

    const body = await c.req.json().catch(() => null)
    const parsed = UpdateNetworkBody.safeParse(body)
    if (!parsed.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parsed.error.message } },
        400
      )
    }
    const nextNetwork = parsed.data

    try {
      const nextRow = await recreateDatabaseContainer(db, row, {
        exposureMode: nextNetwork.exposureMode,
        publicEnabled:
          nextNetwork.publicEnabled && nextNetwork.exposureMode !== "internal",
        ownerId: user.id,
      })
      return c.json({ ok: true, database: listShape(nextRow) })
    } catch (err) {
      log.error({ err, dbId: row.id }, "network update failed")
      return c.json(
        {
          error: {
            code: "NETWORK_UPDATE_FAILED",
            message: "Network update failed",
          },
        },
        500
      )
    }
  })

  router.get("/:id/logs", databasesRead, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")
    const tailRaw = Number(c.req.query("tail") ?? 200)
    const tail = Number.isFinite(tailRaw)
      ? Math.max(1, Math.min(Math.floor(tailRaw), 1_000))
      : 200
    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    if (!row.container_id) {
      return c.json({ lines: [], containerFound: false })
    }

    try {
      const agent = getSharedAgent()
      const lines: Array<{
        t: number
        line: string
        stream?: "stdout" | "stderr"
      }> = []
      for await (const line of agent.containerLogs({
        containerId: row.container_id,
        follow: false,
        sinceUnix: 0,
        tail,
      })) {
        const entry: { t: number; line: string; stream?: "stdout" | "stderr" } =
          {
            t: Date.parse(line.timestamp) || Date.now(),
            line: line.line,
          }
        if (line.stream === "stdout" || line.stream === "stderr")
          entry.stream = line.stream
        lines.push(entry)
      }
      return c.json({ lines, containerFound: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "RUNTIME_LOGS_ERROR", message } }, 500)
    }
  })

  router.get("/:id/stats", databasesRead, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")
    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }
    if (!row.container_id) {
      return c.json({ containerFound: false })
    }

    try {
      const agent = getSharedAgent()
      for await (const frame of agent.containerStats({
        containerId: row.container_id,
        stream: false,
      })) {
        return c.json({
          containerFound: true,
          stats: {
            cpu_percent: frame.cpuPercent,
            memory_bytes: frame.memoryBytes,
            memory_limit_bytes: frame.memoryLimitBytes,
            net_rx_bytes: frame.netRxBytes,
            net_tx_bytes: frame.netTxBytes,
            timestamp_ns: frame.timestampNs,
          },
        })
      }
      return c.json({ containerFound: true, stats: null })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "RUNTIME_STATS_ERROR", message } }, 500)
    }
  })

  // POST /databases/:id/rotate — TOTP required, triggers password rotation
  router.post(
    "/:id/rotate",
    databasesWrite,
    ownerOnly,
    totpMiddleware,
    async (c) => {
      const user = getUser(c)
      const dbId = c.req.param("id")

      const row = await getDbForUser(db, dbId!, user.id)
      if (!row) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Database not found" } },
          404
        )
      }
      if (row.kind === "libsql") {
        return c.json(
          {
            error: {
              code: "UNSUPPORTED_DATABASE_KIND",
              message: "Password rotation is not supported for libSQL yet",
            },
          },
          400
        )
      }
      if (isExternalDatabase(row)) {
        return c.json(
          {
            error: {
              code: "UNSUPPORTED_DATABASE_MODE",
              message:
                "External database passwords are managed outside Ploydok",
            },
          },
          400
        )
      }

      try {
        const result = await rotatePassword(db, row.id, { reason: "manual" })
        log.info(
          {
            dbId: row.id,
            userId: user.id,
            appsRedeployed: result.appsRedeployed,
          },
          "manual rotation triggered"
        )
        return c.json({
          ok: true,
          rotatedAt: result.rotatedAt.toISOString(),
          appsRedeployed: result.appsRedeployed,
        })
      } catch (err) {
        if (err instanceof RotationInProgressError) {
          return c.json(
            {
              error: {
                code: "CONFLICT",
                message: "Rotation already in progress",
              },
            },
            409
          )
        }
        if (err instanceof RotationFailedError) {
          log.error({ err, dbId: row.id }, "rotation failed — rolled back")
          return c.json(
            {
              error: {
                code: "ROTATION_FAILED",
                message: "Rotation failed — rolled back to previous password",
              },
            },
            500
          )
        }
        const msg = err instanceof Error ? err.message : String(err)
        log.error({ err, dbId: row.id }, "unexpected rotation error")
        return c.json({ error: { code: "INTERNAL", message: msg } }, 500)
      }
    }
  )

  // DELETE /databases/:id — confirm challenge
  router.delete("/:id", databasesWrite, ownerOnly, async (c) => {
    const user = getUser(c)
    const dbId = c.req.param("id")

    const row = await getDbForUser(db, dbId!, user.id)
    if (!row) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Database not found" } },
        404
      )
    }

    const body = await c.req.json().catch(() => null)
    const confirm = body?.confirm
    if (confirm !== `delete ${row.name}`) {
      return c.json(
        {
          error: {
            code: "CONFIRM_REQUIRED",
            message: `Send { "confirm": "delete ${row.name}" } to confirm deletion`,
          },
        },
        400
      )
    }

    const agent = getSharedAgent()

    if (row.container_id) {
      try {
        await agent.containerStop({
          containerId: row.container_id,
          timeoutSeconds: 10,
        })
        await agent.containerRemove({
          containerId: row.container_id,
          force: false,
          removeVolumes: false,
        })
      } catch (err) {
        log.warn(
          { err, dbId, containerId: row.container_id },
          "container stop/remove warning"
        )
      }
    }

    await removeDatabasePublicProxy(row)

    await db.delete(databases).where(eq(databases.id, dbId!))

    log.info({ dbId, name: row.name, userId: user.id }, "database deleted")
    return c.json({ ok: true })
  })

  return router
}

export function databasesRouterFactory() {
  const db = createDb(env.DATABASE_URL)
  return createDatabasesRouter(db)
}
