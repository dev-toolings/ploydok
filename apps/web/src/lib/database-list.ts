// SPDX-License-Identifier: AGPL-3.0-only
import type { Database, DbKind, DbStatus } from "./databases"

export type DatabaseKindFilter = "all" | DbKind
export type DatabaseStatusFilter = "all" | DbStatus | "attention"
export type DatabaseProtectionFilter =
  "all" | "review" | "protected" | "unprotected" | "public"

export interface DatabaseListFilters {
  query: string
  kind: DatabaseKindFilter
  status: DatabaseStatusFilter
  protection: DatabaseProtectionFilter
}

export interface DatabaseOperationalSummary {
  total: number
  healthy: number
  attention: number
  runtimeAttention: number
  backupFailed: number
  public: number
  protected: number
  scheduled: number
  managed: number
}

export function databaseHasRuntimeIssue(database: Database): boolean {
  return (
    database.status === "failed" ||
    database.status === "degraded" ||
    database.health_status === "degraded" ||
    database.health_status === "unhealthy"
  )
}

export function isDatabaseBackupScheduled(database: Database): boolean {
  return (
    database.management_mode === "managed" && database.backup_enabled === true
  )
}

export function isDatabaseProtected(database: Database): boolean {
  if (!isDatabaseBackupScheduled(database)) return false
  if (!database.last_successful_backup_at) return false

  const lastSuccessfulBackup = Date.parse(database.last_successful_backup_at)
  const maxAgeSeconds = database.backup_max_age_seconds
  return (
    Number.isFinite(lastSuccessfulBackup) &&
    typeof maxAgeSeconds === "number" &&
    Number.isFinite(maxAgeSeconds) &&
    maxAgeSeconds >= 0 &&
    Date.now() - lastSuccessfulBackup <= maxAgeSeconds * 1000
  )
}

export function databaseNeedsAttention(database: Database): boolean {
  return (
    databaseHasRuntimeIssue(database) ||
    database.latest_backup_status === "failed"
  )
}

export function databaseNeedsReview(database: Database): boolean {
  return (
    databaseNeedsAttention(database) ||
    database.public_enabled ||
    (database.management_mode === "managed" &&
      !isDatabaseBackupScheduled(database))
  )
}

export function getDatabaseListRefreshInterval(
  databases: ReadonlyArray<Database> | undefined
): number {
  const needsFastRefresh = databases?.some(
    (database) =>
      database.status === "creating" ||
      database.status === "starting" ||
      database.status === "degraded" ||
      database.health_status === "starting" ||
      database.health_status === "degraded" ||
      database.health_status === "unhealthy" ||
      database.latest_backup_status === "running"
  )

  return needsFastRefresh ? 3_000 : 15_000
}

export function summarizeDatabases(
  databases: ReadonlyArray<Database>
): DatabaseOperationalSummary {
  const managed = databases.filter(
    (database) => database.management_mode === "managed"
  )

  return {
    total: databases.length,
    healthy: databases.filter(
      (database) =>
        database.status === "running" && database.health_status === "healthy"
    ).length,
    attention: databases.filter(databaseNeedsAttention).length,
    runtimeAttention: databases.filter(databaseHasRuntimeIssue).length,
    backupFailed: databases.filter(
      (database) => database.latest_backup_status === "failed"
    ).length,
    public: databases.filter((database) => database.public_enabled).length,
    protected: managed.filter(isDatabaseProtected).length,
    scheduled: managed.filter(isDatabaseBackupScheduled).length,
    managed: managed.length,
  }
}

export function filterDatabases(
  databases: ReadonlyArray<Database>,
  filters: DatabaseListFilters
): Array<Database> {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase()

  return databases.filter((database) => {
    if (filters.kind !== "all" && database.kind !== filters.kind) return false

    if (filters.status === "attention") {
      if (!databaseNeedsAttention(database)) return false
    } else if (filters.status !== "all" && database.status !== filters.status) {
      return false
    }

    if (filters.protection === "review" && !databaseNeedsReview(database)) {
      return false
    }
    if (filters.protection === "public" && !database.public_enabled)
      return false
    if (filters.protection === "protected" && !isDatabaseProtected(database)) {
      return false
    }
    if (
      filters.protection === "unprotected" &&
      (database.management_mode !== "managed" ||
        isDatabaseBackupScheduled(database))
    ) {
      return false
    }

    if (!normalizedQuery) return true

    const searchable = [
      database.name,
      database.kind,
      database.version,
      database.host,
      database.public_host,
      ...(database.linked_apps ?? []).flatMap((app) => [
        app.app_name,
        app.app_slug,
      ]),
    ]
      .filter((value): value is string => Boolean(value))
      .join(" ")
      .toLocaleLowerCase()

    return searchable.includes(normalizedQuery)
  })
}
