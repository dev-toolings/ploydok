// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test, mock } from "bun:test"
import type { Db } from "@ploydok/db"
import { eq, sql } from "drizzle-orm"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

const staleRedisKeys = new Set<string>()
const staleDispatch = mock(async (..._args: unknown[]) => undefined)
const staleRedisSet = mock(
  async (key: string, ..._args: unknown[]): Promise<"OK" | null> =>
    staleRedisKeys.has(key) ? null : (staleRedisKeys.add(key), "OK")
)
const staleRedis = {
  set: staleRedisSet,
  disconnect: mock(() => undefined),
}

mock.module("ioredis", () => ({
  default: class MockRedis {
    set(key: string, ..._args: unknown[]): Promise<"OK" | null> {
      return staleRedisSet(key)
    }

    disconnect(): void {
      staleRedis.disconnect()
    }
  },
}))

const realDb = await import("@ploydok/db")
const {
  apps,
  app_volumes,
  backup_configs,
  backups,
  createDb,
  databases,
  notification_channels,
  projects,
  users,
  volume_backup_configs,
  volume_backups,
} = realDb
mock.module("../../notify/index", () => ({ dispatch: staleDispatch }))
mock.module("../../databases/backup", () => ({
  runBackupOnce: mock(async () => ({
    backupId: "mock-database-backup",
    status: "succeeded" as const,
    sizeBytes: 1,
    location: "/mock/database.dump",
  })),
}))
mock.module("../../backups/volume", () => ({
  runVolumeBackupOnce: mock(async () => ({
    backupId: "mock-volume-backup",
    status: "succeeded" as const,
    sizeBytes: 1,
    location: "/mock/volume.tar",
  })),
}))

const {
  latestBackupOccurrence,
  runScheduledBackupConfig,
  runScheduledBackups,
} = await import("./backup-databases")

const createdAt = new Date("2026-10-01T00:00:00Z")
const now = new Date("2026-10-14T03:20:00Z")
const due = new Date("2026-10-14T03:00:00Z")
const result = {
  backupId: "backup-1",
  status: "succeeded" as const,
  sizeBytes: 1,
  location: "/backup",
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

function fixture(kind: "database" | "volume", locked = true) {
  const config = {
    id: "config-1",
    enabled: true,
    schedule_cron: "0 3 * * *",
    created_at: createdAt,
    last_scheduled_at: null as Date | null,
  }
  const tx = {
    execute: mock(async () => [{ locked }]),
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ ...config }] }) }),
    }),
    update: () => ({
      set: (patch: Partial<typeof config>) => ({
        where: async () => Object.assign(config, patch),
      }),
    }),
  }
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = { ...config }
      try {
        return await fn(tx)
      } catch (err) {
        Object.assign(config, snapshot)
        throw err
      }
    },
  } as unknown as Db
  return {
    config,
    tx,
    run: (fn: (tx: Db, due: Date) => Promise<typeof result>) =>
      runScheduledBackupConfig(db, kind, config.id, now, fn),
  }
}

describe("scheduled backups", () => {
  test("the default cron executes exactly once per day even when scanned at :20", () => {
    let cursor: Date | null = null
    const occurrences: Date[] = []
    for (let hour = 0; hour < 24; hour++) {
      const occurrence = latestBackupOccurrence(
        "0 3 * * *",
        new Date("2026-10-14T00:00:00Z"),
        cursor,
        new Date(Date.UTC(2026, 9, 14, hour, 20))
      )
      if (occurrence) {
        occurrences.push(occurrence)
        cursor = occurrence
      }
    }
    expect(occurrences).toEqual([due])
    expect(latestBackupOccurrence("0 3 * * *", createdAt, null, due)).toEqual(
      due
    )
  })

  test("coalesces restart backlog and supports full UTC cron expressions", () => {
    expect(
      latestBackupOccurrence(
        "0 3 * * *",
        createdAt,
        new Date("2026-10-02T03:00:00Z"),
        now
      )
    ).toEqual(due)
    expect(
      latestBackupOccurrence("*/15 * * * *", createdAt, null, now)
    ).toEqual(new Date("2026-10-14T03:15:00Z"))
    expect(latestBackupOccurrence("0 3 * * 1", createdAt, null, now)).toEqual(
      new Date("2026-10-12T03:00:00Z")
    )
    expect(latestBackupOccurrence("0 3 * * *", now, null, now)).toBeNull()
  })

  test.each(["database", "volume"] as const)(
    "persists the %s occurrence and never repeats it after restart",
    async (kind) => {
      const f = fixture(kind)
      const run = mock(async (_tx: Db, scheduled: Date) => {
        expect(scheduled).toEqual(due)
        return result
      })
      expect(await f.run(run)).toEqual(result)
      expect(f.config.last_scheduled_at).toEqual(due)
      expect(await f.run(run)).toBeNull()
      expect(run).toHaveBeenCalledTimes(1)
    }
  )

  test("an interrupted execution leaves the occurrence due; another holder prevents duplicates", async () => {
    const f = fixture("database")
    await expect(
      f.run(async () => {
        throw new Error("interrupted")
      })
    ).rejects.toThrow("interrupted")
    expect(f.config.last_scheduled_at).toBeNull()
    expect(await f.run(async () => result)).toEqual(result)
    const busy = fixture("database", false)
    const run = mock(async () => result)
    expect(await busy.run(run)).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  test("freshness paging is enabled independently of backup job failures", () => {
    const rules = parse(
      readFileSync(
        new URL(
          "../../../../../installer/templates/ploydok-alerts.yml",
          import.meta.url
        ),
        "utf8"
      )
    )
    const alert = rules.groups
      .flatMap(
        (g: { rules: Array<{ alert: string; expr: string }> }) => g.rules
      )
      .find((r: { alert: string }) => r.alert === "BackupFailureOrStale")
    expect(alert.expr).toContain("or ploydok_stale_backup_resources > 0")
  })
})

// Temporary tables isolate this regression check from every real backup config.
test.skipIf(!process.env.DATABASE_URL)(
  "PostgreSQL commits the cursor with the result and excludes concurrent runners",
  async () => {
    const { createDb } = await import("@ploydok/db")
    const { sql } = await import("drizzle-orm")
    const db = createDb(process.env.DATABASE_URL!)
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`CREATE TEMP TABLE backup_configs (LIKE public.backup_configs INCLUDING DEFAULTS) ON COMMIT DROP`
        )
        await tx.execute(
          sql`INSERT INTO pg_temp.backup_configs (id, database_id, created_at) VALUES ('schedule-regression', 'fixture', ${createdAt.toISOString()})`
        )
        const txDb = tx as unknown as Db
        const run = mock(async () => result)
        await expect(
          runScheduledBackupConfig(
            txDb,
            "database",
            "schedule-regression",
            now,
            async () => {
              throw new Error("crash")
            }
          )
        ).rejects.toThrow("crash")
        const rows = await tx.execute<{
          last_scheduled_at: string | null
        }>(sql`SELECT last_scheduled_at FROM pg_temp.backup_configs`)
        expect(rows[0]?.last_scheduled_at).toBeNull()
        expect(
          await runScheduledBackupConfig(
            txDb,
            "database",
            "schedule-regression",
            now,
            async () => {
              expect(
                await runScheduledBackupConfig(
                  db,
                  "database",
                  "schedule-regression",
                  now,
                  run
                )
              ).toBeNull()
              return result
            }
          )
        ).toEqual(result)
        expect(
          await runScheduledBackupConfig(
            txDb,
            "database",
            "schedule-regression",
            now,
            run
          )
        ).toBeNull()
        expect(run).not.toHaveBeenCalled()
      })
    } finally {
      await db.$client.end()
    }
  }
)

test.skipIf(!process.env.DATABASE_URL)(
  "notifies stale database and volume configs once with owner and project scope",
  async () => {
    const db = createDb(process.env.DATABASE_URL!)
    const suffix = `stale-${Date.now().toString(36)}`
    const scanAt = new Date("2026-10-15T12:00:00.000Z")
    const configuredAt = new Date("2026-10-12T12:00:00.000Z")
    const recentSuccessAt = new Date("2026-10-15T11:00:00.000Z")
    const ownerOne = `backup-stale-owner-one-${suffix}`
    const ownerTwo = `backup-stale-owner-two-${suffix}`
    const projectOne = `backup-stale-project-one-${suffix}`
    const projectTwo = `backup-stale-project-two-${suffix}`
    const staleDatabaseOne = `backup-stale-database-one-${suffix}`
    const recentDatabaseOne = `backup-stale-database-recent-${suffix}`
    const staleDatabaseTwo = `backup-stale-database-two-${suffix}`
    const appOne = `backup-stale-app-one-${suffix}`
    const appTwo = `backup-stale-app-two-${suffix}`
    const staleVolumeOne = `backup-stale-volume-one-${suffix}`
    const recentVolumeOne = `backup-stale-volume-recent-${suffix}`
    const staleVolumeTwo = `backup-stale-volume-two-${suffix}`
    const staleDatabaseConfigOne = `backup-stale-db-config-one-${suffix}`
    const recentDatabaseConfigOne = `backup-stale-db-config-recent-${suffix}`
    const staleDatabaseConfigTwo = `backup-stale-db-config-two-${suffix}`
    const staleVolumeConfigOne = `backup-stale-volume-config-one-${suffix}`
    const recentVolumeConfigOne = `backup-stale-volume-config-recent-${suffix}`
    const staleVolumeConfigTwo = `backup-stale-volume-config-two-${suffix}`

    staleDispatch.mockClear()
    staleRedisSet.mockClear()
    staleRedis.disconnect.mockClear()
    staleRedisKeys.clear()

    try {
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db
        await createBackupShadowTables(txDb, [
          "users",
          "projects",
          "databases",
          "apps",
          "app_volumes",
          "notification_channels",
          "backup_configs",
          "volume_backup_configs",
          "backups",
          "volume_backups",
        ])

      await txDb.insert(users).values([
        {
          id: ownerOne,
          email: `${ownerOne}@example.test`,
          display_name: "Backup owner one",
          created_at: configuredAt,
          updated_at: configuredAt,
          recovery_token_hash: null,
          recovery_expires_at: null,
        },
        {
          id: ownerTwo,
          email: `${ownerTwo}@example.test`,
          display_name: "Backup owner two",
          created_at: configuredAt,
          updated_at: configuredAt,
          recovery_token_hash: null,
          recovery_expires_at: null,
        },
      ])
      await txDb.insert(projects).values([
        {
          id: projectOne,
          owner_id: ownerOne,
          name: "Backup project one",
          slug: `backup-stale-one-${suffix}`,
          created_at: configuredAt,
        },
        {
          id: projectTwo,
          owner_id: ownerTwo,
          name: "Backup project two",
          slug: `backup-stale-two-${suffix}`,
          created_at: configuredAt,
        },
      ])
      await txDb.insert(notification_channels).values([
        {
          id: `backup-stale-channel-one-${suffix}`,
          owner_id: ownerOne,
          project_id: projectOne,
          kind: "email",
          name: "Backup stale test one",
          config: JSON.stringify({}),
          events: ["backup.stale"],
          enabled: true,
          created_at: configuredAt,
        },
        {
          id: `backup-stale-channel-two-${suffix}`,
          owner_id: ownerTwo,
          project_id: projectTwo,
          kind: "email",
          name: "Backup stale test two",
          config: JSON.stringify({}),
          events: ["backup.stale"],
          enabled: true,
          created_at: configuredAt,
        },
      ])
      await txDb.insert(databases).values([
        {
          id: staleDatabaseOne,
          project_id: projectOne,
          kind: "postgres",
          version: "16",
          name: "Stale database one",
          plan: "small",
          management_mode: "managed",
          volume_name: `stale-db-volume-one-${suffix}`,
          container_id: `stale-db-container-one-${suffix}`,
          status: "running",
          health_status: "healthy",
          created_at: configuredAt,
        },
        {
          id: recentDatabaseOne,
          project_id: projectOne,
          kind: "postgres",
          version: "16",
          name: "Recent database one",
          plan: "small",
          management_mode: "managed",
          volume_name: `recent-db-volume-one-${suffix}`,
          container_id: `recent-db-container-one-${suffix}`,
          status: "running",
          health_status: "healthy",
          created_at: configuredAt,
        },
        {
          id: staleDatabaseTwo,
          project_id: projectTwo,
          kind: "postgres",
          version: "16",
          name: "Stale database two",
          plan: "small",
          management_mode: "managed",
          volume_name: `stale-db-volume-two-${suffix}`,
          container_id: `stale-db-container-two-${suffix}`,
          status: "running",
          health_status: "healthy",
          created_at: configuredAt,
        },
      ])
      await txDb.insert(apps).values([
        {
          id: appOne,
          project_id: projectOne,
          name: "Backup app one",
          slug: `backup-stale-app-one-${suffix}`,
          created_at: configuredAt,
          updated_at: configuredAt,
        },
        {
          id: appTwo,
          project_id: projectTwo,
          name: "Backup app two",
          slug: `backup-stale-app-two-${suffix}`,
          created_at: configuredAt,
          updated_at: configuredAt,
        },
      ])
      await txDb.insert(app_volumes).values([
        {
          id: staleVolumeOne,
          app_id: appOne,
          name: "stale-data",
          mount_path: "/stale-data",
          created_at: configuredAt,
        },
        {
          id: recentVolumeOne,
          app_id: appOne,
          name: "recent-data",
          mount_path: "/recent-data",
          created_at: configuredAt,
        },
        {
          id: staleVolumeTwo,
          app_id: appTwo,
          name: "stale-data",
          mount_path: "/stale-data",
          created_at: configuredAt,
        },
      ])
      await txDb.insert(backup_configs).values([
        {
          id: staleDatabaseConfigOne,
          database_id: staleDatabaseOne,
          schedule_cron: "0 3 * * *",
          enabled: true,
          last_scheduled_at: scanAt,
          created_at: configuredAt,
        },
        {
          id: recentDatabaseConfigOne,
          database_id: recentDatabaseOne,
          schedule_cron: "0 3 * * *",
          enabled: true,
          last_scheduled_at: scanAt,
          created_at: configuredAt,
        },
        {
          id: staleDatabaseConfigTwo,
          database_id: staleDatabaseTwo,
          schedule_cron: "0 3 * * *",
          enabled: true,
          last_scheduled_at: scanAt,
          created_at: configuredAt,
        },
      ])
      await txDb.insert(volume_backup_configs).values([
        {
          id: staleVolumeConfigOne,
          app_id: appOne,
          volume_id: staleVolumeOne,
          schedule_cron: "0 3 * * *",
          enabled: true,
          last_scheduled_at: scanAt,
          created_at: configuredAt,
        },
        {
          id: recentVolumeConfigOne,
          app_id: appOne,
          volume_id: recentVolumeOne,
          schedule_cron: "0 3 * * *",
          enabled: true,
          last_scheduled_at: scanAt,
          created_at: configuredAt,
        },
        {
          id: staleVolumeConfigTwo,
          app_id: appTwo,
          volume_id: staleVolumeTwo,
          schedule_cron: "0 3 * * *",
          enabled: true,
          last_scheduled_at: scanAt,
          created_at: configuredAt,
        },
      ])
      await txDb.insert(backups).values({
        id: `backup-stale-recent-database-${suffix}`,
        database_id: recentDatabaseOne,
        config_id: recentDatabaseConfigOne,
        destination_kind: "local",
        location: `/tmp/${recentDatabaseOne}.dump`,
        status: "succeeded",
        started_at: recentSuccessAt,
        finished_at: recentSuccessAt,
      })
      await txDb.insert(volume_backups).values({
        id: `backup-stale-recent-volume-${suffix}`,
        app_id: appOne,
        volume_id: recentVolumeOne,
        config_id: recentVolumeConfigOne,
        destination_kind: "local",
        location: `/tmp/${recentVolumeOne}.tar`,
        status: "succeeded",
        started_at: recentSuccessAt,
        finished_at: recentSuccessAt,
      })

      await runScheduledBackups(txDb, scanAt)
      await runScheduledBackups(txDb, scanAt)

      const staleCalls = staleDispatch.mock.calls.filter(
        (call) => call[2] === "backup.stale"
      )
      expect(staleCalls).toHaveLength(4)
      const staleResourceIds = staleCalls.map(
        (call) => (call[3] as { appId: string }).appId
      )
      expect(staleResourceIds).toEqual(
        expect.arrayContaining([
          staleDatabaseOne,
          staleVolumeOne,
          staleDatabaseTwo,
          staleVolumeTwo,
        ])
      )
      expect(staleResourceIds).not.toContain(recentDatabaseOne)
      expect(staleResourceIds).not.toContain(recentVolumeOne)

      for (const call of staleCalls) {
        const resourceId = (call[3] as { appId: string }).appId
        const scope = call[4] as { userId: string; projectId: string }
        if (resourceId === staleDatabaseOne || resourceId === staleVolumeOne) {
          expect(scope).toEqual({ userId: ownerOne, projectId: projectOne })
        } else {
          expect(scope).toEqual({ userId: ownerTwo, projectId: projectTwo })
        }
      }

      const setKeys = staleRedisSet.mock.calls.map((call) => call[0] as string)
      expect(setKeys).toHaveLength(8)
      expect(new Set(setKeys)).toHaveLength(4)
      expect(staleRedis.disconnect).toHaveBeenCalledTimes(2)
      })
    } finally {
      await db.$client.end()
    }
  }
)
