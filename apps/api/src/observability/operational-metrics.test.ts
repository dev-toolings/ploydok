// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test"
import {
  apps,
  app_volumes,
  backup_configs,
  backups,
  createDb,
  databases,
  projects,
  volume_backup_configs,
  volume_backups,
  type Db,
} from "@ploydok/db"
import type { HostStatsResponse } from "@ploydok/agent-proto"
import { sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import { renderMetrics } from "./metrics"
import {
  collectOperationalMetrics,
  recordDeploymentOutcome,
  recordInitialBuildClaim,
} from "./operational-metrics"

const hostStats: HostStatsResponse = {
  cpuPercent: 10,
  memTotalBytes: 1_000,
  memUsedBytes: 400,
  memAvailableBytes: 600,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  load1: 0,
  load5: 0,
  load15: 0,
  diskTotalBytes: 1_000,
  diskUsedBytes: 800,
  diskFreeBytes: 200,
  inodesTotal: 100,
  inodesUsed: 10,
  cpuCount: 2,
  uptimeSeconds: 60,
  error: "",
  gpuCount: 0,
  gpuUtilizationPct: 0,
  gpuMemUsedBytes: 0,
  gpuMemTotalBytes: 0,
  gpuName: "",
}

async function createBackupShadowTables(
  db: Db,
  tables: readonly string[]
): Promise<void> {
  for (const table of tables) {
    await db.execute(
      sql.raw(
        `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`
      )
    )
  }
}

describe("operational metrics", () => {
  test("publishes deployment, backup, queue, certificate, agent and disk gauges", async () => {
    const db = {
      execute: async () => [
        {
          deployments_total_15m: "10",
          deployments_failed_15m: "2",
          stuck_builds: "1",
          stuck_jobs: "3",
          backup_failures_24h: "3",
          stale_backup_resources: "2",
          outbox_pending: "4",
          outbox_stuck: "1",
          outbox_dead_lettered: "2",
          outbox_dead_lettered_15m: "1",
          certificates_expiring_30d: "3",
          certificates_expiring_7d: "2",
          certificates_expiring_1d: "1",
        },
      ],
    } as unknown as Db

    await collectOperationalMetrics(
      db,
      async () => hostStats,
      async () => ({
        ok: true,
        version: "test",
        components: {
          db: { status: "ok" },
          agent: { status: "ok" },
          caddy: { status: "ok" },
          ingress: {
            status: "ok",
            expected_http_routes: 0,
            missing_http_routes: [],
            expected_tcp_proxies: 0,
            missing_tcp_proxies: [],
          },
        },
      }),
      async () => ({
        configured: true,
        lastSuccessTimestampSeconds: 1_755_513_600,
        lastFailureTimestampSeconds: 1_755_427_200,
      })
    )
    const output = renderMetrics()

    expect(output).toContain("ploydok_deployments_total_15m 10")
    expect(output).toContain("ploydok_deployments_failed_15m 2")
    expect(output).toContain("ploydok_stuck_builds 1")
    expect(output).toContain("ploydok_stuck_jobs 3")
    expect(output).toContain("ploydok_backup_failures_24h 3")
    expect(output).toContain("ploydok_stale_backup_resources 2")
    expect(output).toContain(
      "ploydok_control_plane_backup_last_success_timestamp_seconds 1755513600"
    )
    expect(output).toContain("ploydok_control_plane_backup_configured 1")
    expect(output).toContain(
      "ploydok_control_plane_backup_last_failure_timestamp_seconds 1755427200"
    )
    expect(output).toContain("ploydok_outbox_stuck 1")
    expect(output).toContain("ploydok_outbox_dead_lettered_15m 1")
    expect(output).toContain('ploydok_certificates_expiring{within_days="7"} 2')
    expect(output).toContain("ploydok_agent_up 1")
    expect(output).toContain('ploydok_component_ready{component="caddy"} 1')
    expect(output).toContain("ploydok_host_disk_used_ratio 0.8")
    expect(output).toContain("ploydok_host_inodes_used_ratio 0.1")
    expect(output).toContain("ploydok_operational_metrics_error 0")
  })

  test("publishes durable SLI counters with an explicit failure classification", () => {
    recordDeploymentOutcome("succeeded")
    recordDeploymentOutcome("platform_failed")
    recordInitialBuildClaim(
      new Date("2026-08-18T10:00:00.000Z"),
      new Date("2026-08-18T10:04:00.000Z")
    )
    recordInitialBuildClaim(
      new Date("2026-08-18T10:00:00.000Z"),
      new Date("2026-08-18T10:06:00.000Z")
    )

    const output = renderMetrics()
    expect(output).toContain(
      'ploydok_deployment_outcomes_total{outcome="platform_failed"} 1'
    )
    expect(output).toContain(
      'ploydok_build_claims_total{within_slo="true"} 1'
    )
    expect(output).toContain(
      'ploydok_build_claims_total{within_slo="false"} 1'
    )
  })

  test("marks partial host stats as a collector error instead of exporting a false-zero disk", async () => {
    const db = {
      execute: async () => [
        {
          deployments_total_15m: 0,
          deployments_failed_15m: 0,
          stuck_builds: 0,
          stuck_jobs: 0,
          backup_failures_24h: 0,
          stale_backup_resources: 0,
          outbox_pending: 0,
          outbox_stuck: 0,
          outbox_dead_lettered: 0,
          outbox_dead_lettered_15m: 0,
          certificates_expiring_30d: 0,
          certificates_expiring_7d: 0,
          certificates_expiring_1d: 0,
        },
      ],
    } as unknown as Db

    await collectOperationalMetrics(
      db,
      async () => ({ ...hostStats, diskTotalBytes: 0, error: "disk:statvfs failed" }),
      async () => ({
        ok: true,
        version: "test",
        components: {
          db: { status: "ok" },
          agent: { status: "ok" },
          caddy: { status: "ok" },
          ingress: {
            status: "ok",
            expected_http_routes: 0,
            missing_http_routes: [],
            expected_tcp_proxies: 0,
            missing_tcp_proxies: [],
          },
        },
      })
    )

    const output = renderMetrics()
    expect(output).toContain("ploydok_agent_up 1")
    expect(output).toContain("ploydok_operational_metrics_error 1")
  })

  test("deduplicates freshness series when a config appears more than once", async () => {
    const suffix = nanoid(8)
    const databaseConfigId = `freshness-dedup-database-${suffix}`
    const volumeConfigId = `freshness-dedup-volume-${suffix}`
    const configuredAt = new Date("2026-10-10T03:00:00.000Z")
    const lastSuccessAt = new Date("2026-10-14T03:00:00.000Z")
    let executeCall = 0
    const counts = {
      deployments_total_15m: 0,
      deployments_failed_15m: 0,
      stuck_builds: 0,
      stuck_jobs: 0,
      backup_failures_24h: 0,
      stale_backup_resources: 0,
      outbox_pending: 0,
      outbox_stuck: 0,
      outbox_dead_lettered: 0,
      outbox_dead_lettered_15m: 0,
      certificates_expiring_30d: 0,
      certificates_expiring_7d: 0,
      certificates_expiring_1d: 0,
    }
    const db = {
      execute: async () => {
        executeCall += 1
        if (executeCall === 1) return [counts]
        return [
          {
            resource_type: "database",
            config_id: databaseConfigId,
            resource_id: `database-${suffix}`,
            schedule_cron: "0 3 * * *",
            configured_at: configuredAt,
            last_success_at: lastSuccessAt,
          },
          {
            resource_type: "database",
            config_id: databaseConfigId,
            resource_id: `database-${suffix}`,
            schedule_cron: "0 3 * * *",
            configured_at: configuredAt,
            last_success_at: lastSuccessAt,
          },
          {
            resource_type: "volume",
            config_id: volumeConfigId,
            resource_id: `volume-${suffix}`,
            schedule_cron: "0 3 * * *",
            configured_at: configuredAt,
            last_success_at: null,
          },
          {
            resource_type: "volume",
            config_id: volumeConfigId,
            resource_id: `volume-${suffix}`,
            schedule_cron: "0 3 * * *",
            configured_at: configuredAt,
            last_success_at: null,
          },
        ]
      },
    } as unknown as Db

    await collectOperationalMetrics(
      db,
      async () => hostStats,
      async () => ({
        ok: true,
        version: "test",
        components: {
          db: { status: "ok" },
          agent: { status: "ok" },
          caddy: { status: "ok" },
          ingress: {
            status: "ok",
            expected_http_routes: 0,
            missing_http_routes: [],
            expected_tcp_proxies: 0,
            missing_tcp_proxies: [],
          },
        },
      })
    )

    const lines = renderMetrics().split("\n")
    expect(
      lines.filter(
        (line) =>
          line.startsWith("ploydok_backup_age_seconds{") &&
          line.includes(`config_id=\"${databaseConfigId}\"`)
      )
    ).toHaveLength(1)
    expect(
      lines.filter(
        (line) =>
          line.startsWith("ploydok_backup_age_seconds{") &&
          line.includes(`config_id=\"${volumeConfigId}\"`)
      )
    ).toHaveLength(1)
  })

  test("keeps the scrape available and exposes collector failure", async () => {
    const db = {
      execute: async () => {
        throw new Error("database unavailable")
      },
    } as unknown as Db

    await collectOperationalMetrics(
      db,
      async () => {
        throw new Error("agent unavailable")
      },
      async () => {
        throw new Error("readiness unavailable")
      }
    )
    const output = renderMetrics()

    expect(output).toContain("ploydok_agent_up 0")
    expect(output).toContain('ploydok_component_ready{component="caddy"} 0')
    expect(output).toContain("ploydok_operational_metrics_error 1")
  })
})

const testPgUrl = Bun.env.PLOYDOK_TEST_PG_URL ?? Bun.env.DATABASE_URL
describe.skipIf(!testPgUrl)("operational metrics PostgreSQL contract", () => {
  test("executes the complete multi-table collector query", async () => {
    const db = createDb(testPgUrl!)
    try {
      await collectOperationalMetrics(
        db,
        async () => hostStats,
        async () => ({
          ok: true,
          version: "test",
          components: {
            db: { status: "ok" },
            agent: { status: "ok" },
            caddy: { status: "ok" },
            ingress: {
              status: "ok",
              expected_http_routes: 0,
              missing_http_routes: [],
              expected_tcp_proxies: 0,
              missing_tcp_proxies: [],
            },
          },
        }),
        async () => ({
          configured: false,
          lastSuccessTimestampSeconds: 0,
          lastFailureTimestampSeconds: 0,
        })
      )
      expect(renderMetrics()).toContain("ploydok_operational_metrics_error 0")
    } finally {
      await db.$client.end()
    }
  })

  test("alerts for stale database and volume backups, including never-successful configs", async () => {
    const db = createDb(testPgUrl!)
    const suffix = nanoid(8)
    const now = new Date()
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1_000)
    const recent = new Date(now.getTime() - 2 * 60 * 60 * 1_000)
    const userId = `backup-freshness-user-${suffix}`
    const projectId = `backup-freshness-project-${suffix}`
    const databaseId = `backup-freshness-database-${suffix}`
    const appId = `backup-freshness-app-${suffix}`
    const volumeId = `backup-freshness-volume-${suffix}`
    const healthyVolumeId = `backup-freshness-volume-healthy-${suffix}`
    const databaseStaleConfigId = `backup-freshness-db-stale-${suffix}`
    const databaseHealthyConfigId = `backup-freshness-db-healthy-${suffix}`
    const volumeStaleConfigId = `backup-freshness-volume-stale-${suffix}`
    const volumeHealthyConfigId = `backup-freshness-volume-healthy-${suffix}`

    try {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db
        await createBackupShadowTables(txDb, [
          "projects",
          "databases",
          "apps",
          "app_volumes",
          "backup_configs",
          "volume_backup_configs",
          "backups",
          "volume_backups",
        ])

      await txDb.insert(projects).values({
        id: projectId,
        owner_id: userId,
        name: "Backup freshness test",
        slug: `backup-freshness-${suffix}`,
        created_at: now,
      })
      await txDb.insert(databases).values({
        id: databaseId,
        project_id: projectId,
        kind: "postgres",
        version: "16",
        name: "Freshness database",
        plan: "small",
        management_mode: "managed",
        volume_name: `volume-${suffix}`,
        container_id: `container-${suffix}`,
        status: "running",
        health_status: "healthy",
        created_at: now,
      })
      await txDb.insert(apps).values({
        id: appId,
        project_id: projectId,
        name: "Freshness app",
        slug: `freshness-app-${suffix}`,
        created_at: now,
        updated_at: now,
      })
      await txDb.insert(app_volumes).values([
        {
          id: volumeId,
          app_id: appId,
          name: "data",
          mount_path: "/data",
          created_at: now,
        },
        {
          id: healthyVolumeId,
          app_id: appId,
          name: "healthy-data",
          mount_path: "/healthy-data",
          created_at: now,
        },
      ])

      await txDb.insert(backup_configs).values([
        {
          id: databaseStaleConfigId,
          database_id: databaseId,
          schedule_cron: "0 3 * * *",
          enabled: true,
          created_at: old,
        },
        {
          id: databaseHealthyConfigId,
          database_id: databaseId,
          schedule_cron: "0 3 * * *",
          enabled: true,
          created_at: old,
        },
      ])
      await txDb.insert(volume_backup_configs).values([
        {
          id: volumeStaleConfigId,
          app_id: appId,
          volume_id: volumeId,
          schedule_cron: "0 3 * * *",
          enabled: true,
          created_at: old,
        },
        {
          id: volumeHealthyConfigId,
          app_id: appId,
          volume_id: healthyVolumeId,
          schedule_cron: "0 3 * * *",
          enabled: true,
          created_at: old,
        },
      ])

      await txDb.insert(backups).values({
        id: `backup-freshness-db-${suffix}`,
        database_id: databaseId,
        config_id: databaseHealthyConfigId,
        destination_kind: "local",
        location: `/tmp/${databaseId}.dump`,
        size_bytes: 128,
        status: "succeeded",
        started_at: recent,
        finished_at: recent,
      })
      await txDb.insert(volume_backups).values({
        id: `backup-freshness-volume-${suffix}`,
        app_id: appId,
        volume_id: healthyVolumeId,
        config_id: volumeHealthyConfigId,
        destination_kind: "local",
        location: `/tmp/${volumeId}.tar`,
        size_bytes: 256,
        status: "succeeded",
        started_at: recent,
        finished_at: recent,
      })

      await collectOperationalMetrics(
        txDb,
        async () => hostStats,
        async () => ({
          ok: true,
          version: "test",
          components: {
            db: { status: "ok" },
            agent: { status: "ok" },
            caddy: { status: "ok" },
            ingress: {
              status: "ok",
              expected_http_routes: 0,
              missing_http_routes: [],
              expected_tcp_proxies: 0,
              missing_tcp_proxies: [],
            },
          },
        }),
        async () => ({
          configured: false,
          lastSuccessTimestampSeconds: 0,
          lastFailureTimestampSeconds: 0,
        })
      )

      const output = renderMetrics()
      expect(output).toContain("ploydok_stale_backup_resources 2")
      })
    } finally {
      await db.$client.end()
    }
  })
})
