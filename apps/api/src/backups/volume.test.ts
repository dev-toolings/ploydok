// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Db } from "@ploydok/db"

mock.module("../logger", () => ({
  childLogger: () => ({
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

const tempDirs: string[] = []

beforeEach(() => {
  delete Bun.env.PLOYDOK_APP_VOLUMES_ROOT
  delete Bun.env.PLOYDOK_BUILD_DIR
  delete process.env.PLOYDOK_APP_VOLUMES_ROOT
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function makeChain(results: unknown[]) {
  const result = results.shift() ?? []
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(result),
    then: (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled),
  }
  return chain
}

function buildDb(selectResults: unknown[]) {
  const inserts: unknown[] = []
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
  const deletes: unknown[] = []

  const db: Record<string, unknown> = {
    select: mock(() => makeChain(selectResults)),
    execute: mock(async () => []),
    transaction: mock(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db)
    ),
    insert: mock((table: unknown) => ({
      values: mock(async (values: unknown) => {
        inserts.push({ table, values })
      }),
    })),
    update: mock((table: unknown) => ({
      set: mock((values: Record<string, unknown>) => ({
        where: mock(async () => {
          updates.push({ table, values })
        }),
      })),
    })),
    delete: mock((table: unknown) => ({
      where: mock(async () => {
        deletes.push(table)
      }),
    })),
  }

  return { db: db as unknown as Db, inserts, updates, deletes }
}

describe("runVolumeBackupOnce", () => {
  it("archives an app volume to the local filesystem and updates metadata", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "ploydok-app-volumes-"))
    const buildDir = await mkdtemp(path.join(tmpdir(), "ploydok-builds-"))
    tempDirs.push(rootDir, buildDir)

    Bun.env.PLOYDOK_APP_VOLUMES_ROOT = rootDir
    Bun.env.PLOYDOK_BUILD_DIR = buildDir
    process.env.PLOYDOK_APP_VOLUMES_ROOT = rootDir

    const appId = "app-1"
    const volumeId = "vol-1"
    const volumeDir = path.join(rootDir, appId, volumeId)
    await mkdir(volumeDir, { recursive: true })
    await writeFile(path.join(volumeDir, "notes.txt"), "line one\n")

    const startedAt = new Date("2026-04-28T10:00:00.000Z")
    const configRow = {
      id: "cfg-1",
      app_id: appId,
      volume_id: volumeId,
      destination_kind: "local" as const,
      s3_endpoint: null,
      s3_bucket: null,
      s3_prefix: null,
      s3_region: null,
      s3_credentials_secret_id: null,
      schedule_cron: "0 3 * * *",
      retention_days: 7,
      age_recipient_public_key: null,
      enabled: true,
      last_run_at: null,
      last_error: null,
      created_at: startedAt,
    }

    const { db, inserts, updates, deletes } = buildDb([
      [
        {
          app: { id: appId, project_id: "proj-1", name: "demo-app" },
          volume: {
            id: volumeId,
            app_id: appId,
            name: "data",
            mount_path: "/data",
            size_limit_bytes: null,
            created_at: startedAt,
          },
        },
      ],
      [configRow],
      [configRow],
      [],
    ])

    const { runVolumeBackupOnce } = await import("./volume")
    const result = await runVolumeBackupOnce(db, appId, volumeId)

    expect(result.status).toBe("succeeded")
    expect(result.sizeBytes).toBeGreaterThan(0)
    expect(result.location.endsWith(".tar")).toBe(true)

    const tarListing = execFileSync("tar", ["-tf", result.location], {
      encoding: "utf8",
    })
    expect(tarListing).toContain("./notes.txt")

    expect(inserts).toHaveLength(1)
    expect(updates).toHaveLength(2)
    expect(
      updates.some(
        (entry) =>
          entry.values.status === "succeeded" &&
          typeof entry.values.size_bytes === "number"
      )
    ).toBe(true)
    expect(
      updates.some(
        (entry) =>
          entry.values.last_error === null && entry.values.last_run_at instanceof Date
      )
    ).toBe(true)
    expect(deletes).toHaveLength(0)
  })
})
