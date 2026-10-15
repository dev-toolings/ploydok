// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test"
import {
  databaseNeedsAttention,
  databaseNeedsReview,
  filterDatabases,
  getDatabaseListRefreshInterval,
  isDatabaseBackupScheduled,
  isDatabaseProtected,
  summarizeDatabases,
} from "../../lib/database-list"
import type { Database } from "../../lib/databases"

function database(overrides: Partial<Database> = {}): Database {
  return {
    id: "db-1",
    project_id: "org-1",
    kind: "postgres",
    version: "16",
    name: "orders",
    plan: "small",
    management_mode: "managed",
    status: "running",
    health_status: "healthy",
    host: "ploydok-db-orders",
    port: 5432,
    internal_host: "ploydok-db-orders",
    internal_port: 5432,
    exposure_mode: "internal",
    public_enabled: false,
    public_host: null,
    public_port: null,
    public_url: null,
    rotation_schedule: "manual",
    rotation_in_progress: false,
    password_rotated_at: null,
    last_started_at: "2026-08-17T08:00:00.000Z",
    created_at: "2026-08-17T08:00:00.000Z",
    linked_apps: [],
    backup_enabled: true,
    backup_max_age_seconds: 24 * 60 * 60,
    latest_backup_status: "succeeded",
    latest_backup_at: "2026-08-17T09:00:00.000Z",
    last_successful_backup_at: new Date(
      Date.now() - 60 * 60 * 1000
    ).toISOString(),
    ...overrides,
  }
}

describe("database operational list", () => {
  test("summarizes health, exposure, and backup protection", () => {
    const databases = [
      database(),
      database({
        id: "db-2",
        name: "cache",
        kind: "redis",
        status: "degraded",
        health_status: "unhealthy",
        public_enabled: true,
        backup_enabled: false,
      }),
      database({
        id: "db-3",
        name: "warehouse",
        management_mode: "external",
        backup_enabled: false,
      }),
    ]

    expect(summarizeDatabases(databases)).toEqual({
      total: 3,
      healthy: 2,
      attention: 1,
      runtimeAttention: 1,
      backupFailed: 0,
      public: 1,
      protected: 1,
      scheduled: 1,
      managed: 2,
    })
  })

  test("treats failed runtime and degraded health as attention", () => {
    expect(databaseNeedsAttention(database())).toBe(false)
    expect(databaseNeedsAttention(database({ status: "failed" }))).toBe(true)
    expect(
      databaseNeedsAttention(database({ health_status: "degraded" }))
    ).toBe(true)
    expect(
      databaseNeedsAttention(database({ latest_backup_status: "failed" }))
    ).toBe(true)
  })

  test("does not claim external databases are protected by Ploydok", () => {
    expect(isDatabaseBackupScheduled(database())).toBe(true)
    expect(isDatabaseProtected(database())).toBe(true)
    expect(
      isDatabaseProtected(database({ latest_backup_status: "failed" }))
    ).toBe(true)
    expect(
      isDatabaseProtected(
        database({ management_mode: "external", backup_enabled: true })
      )
    ).toBe(false)
    expect(
      isDatabaseProtected(database({ backup_max_age_seconds: 30 * 60 }))
    ).toBe(false)
  })

  test("combines runtime, exposure, and missing schedules in the review filter", () => {
    expect(databaseNeedsReview(database())).toBe(false)
    expect(databaseNeedsReview(database({ public_enabled: true }))).toBe(true)
    expect(databaseNeedsReview(database({ backup_enabled: false }))).toBe(true)
    expect(
      databaseNeedsReview(database({ latest_backup_status: "failed" }))
    ).toBe(true)
  })

  test("refreshes quickly while runtime health or a backup is unsettled", () => {
    expect(getDatabaseListRefreshInterval([database()])).toBe(15_000)
    expect(
      getDatabaseListRefreshInterval([database({ status: "degraded" })])
    ).toBe(3_000)
    expect(
      getDatabaseListRefreshInterval([
        database({ status: "running", health_status: "unhealthy" }),
      ])
    ).toBe(3_000)
    expect(
      getDatabaseListRefreshInterval([
        database({ latest_backup_status: "running" }),
      ])
    ).toBe(3_000)
  })

  test("filters by search, engine, status, exposure, and protection", () => {
    const databases = [
      database({
        linked_apps: [
          {
            app_id: "app-1",
            app_name: "Checkout",
            app_slug: "checkout",
            env_prefix: "DATABASE",
          },
        ],
      }),
      database({
        id: "db-2",
        name: "public-cache",
        kind: "redis",
        status: "failed",
        public_enabled: true,
        backup_enabled: false,
      }),
    ]

    expect(
      filterDatabases(databases, {
        query: "checkout",
        kind: "postgres",
        status: "running",
        protection: "protected",
      }).map((item) => item.id)
    ).toEqual(["db-1"])

    expect(
      filterDatabases(databases, {
        query: "",
        kind: "all",
        status: "attention",
        protection: "public",
      }).map((item) => item.id)
    ).toEqual(["db-2"])

    expect(
      filterDatabases(databases, {
        query: "",
        kind: "all",
        status: "all",
        protection: "review",
      }).map((item) => item.id)
    ).toEqual(["db-2"])

    expect(
      filterDatabases(databases, {
        query: "",
        kind: "all",
        status: "all",
        protection: "unprotected",
      }).map((item) => item.id)
    ).toEqual(["db-2"])
  })
})
