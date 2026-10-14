// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test, mock } from "bun:test"
import type { Db } from "@ploydok/db"
import {
  latestBackupOccurrence,
  runScheduledBackupConfig,
} from "./backup-databases"
import { readFileSync } from "node:fs"
import { parse } from "yaml"

const createdAt = new Date("2026-10-01T00:00:00Z")
const now = new Date("2026-10-14T03:20:00Z")
const due = new Date("2026-10-14T03:00:00Z")
const result = {
  backupId: "backup-1",
  status: "succeeded" as const,
  sizeBytes: 1,
  location: "/backup",
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
