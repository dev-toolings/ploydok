// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, mock } from "bun:test"
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  cleanupBuildCaches,
  pruneBuildKitCache,
  stopCleanupBuildCachesCron,
} from "./cleanup-build-caches"

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ploydok-cache-test-"))
  roots.push(root)
  return root
}

async function touchDir(dir: string, date: Date): Promise<void> {
  await utimes(dir, date, date)
}

describe("cleanupBuildCaches", () => {
  afterEach(async () => {
    stopCleanupBuildCachesCron()
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, {
          recursive: true,
          force: true,
        })
      )
    )
  })

  it("removes stale app build cache directories", async () => {
    const root = await makeRoot()
    const cacheDir = path.join(root, "app-1", ".nixpacks-cache")
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, "layer"), "cached")
    await touchDir(cacheDir, new Date("2026-04-20T08:00:00.000Z"))

    const result = await cleanupBuildCaches({
      rootDir: root,
      now: new Date("2026-05-10T08:00:00.000Z"),
    })

    expect(result.appsScanned).toBe(1)
    expect(result.cacheDirsScanned).toBe(1)
    expect(result.removedDirs).toBe(1)
    expect(result.removedBytes).toBe(6)
    await expect(stat(cacheDir)).rejects.toThrow()
  })

  it("keeps recent app build cache directories", async () => {
    const root = await makeRoot()
    const cacheDir = path.join(root, "app-1", ".buildkit-cache")
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, "layer"), "cached")
    await touchDir(cacheDir, new Date("2026-05-09T08:00:00.000Z"))

    const result = await cleanupBuildCaches({
      rootDir: root,
      now: new Date("2026-05-10T08:00:00.000Z"),
    })

    expect(result.removedDirs).toBe(0)
    expect((await stat(cacheDir)).isDirectory()).toBe(true)
  })

  it("never removes a stale cache owned by an active build", async () => {
    const root = await makeRoot()
    const cacheDir = path.join(root, "app-active", ".buildkit-cache")
    await mkdir(cacheDir, { recursive: true })
    await writeFile(path.join(cacheDir, "layer"), "cached")
    await touchDir(cacheDir, new Date("2026-04-20T08:00:00.000Z"))

    const result = await cleanupBuildCaches({
      rootDir: root,
      now: new Date("2026-05-10T08:00:00.000Z"),
      activeAppIds: new Set(["app-active"]),
    })

    expect(result.removedDirs).toBe(0)
    expect(result.skippedActiveApps).toBe(1)
    expect((await stat(cacheDir)).isDirectory()).toBe(true)
  })

  it("prunes the dedicated BuildKit cache through its configured address", async () => {
    const spawn = mock(() => ({
      stdout: new Response("ID RECLAIMABLE SIZE\ncache-1 true 42B\n").body!,
      stderr: new Response("").body!,
      exited: Promise.resolve(0),
    }))

    const result = await pruneBuildKitCache({
      keepDuration: "24h",
      keepStorage: "5g",
      address: "tcp://buildkitd:1234",
      spawn,
    })

    expect(result.ok).toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      [
        "buildctl",
        "--addr",
        "tcp://buildkitd:1234",
        "prune",
        "--keep-duration",
        "24h",
        "--keep-storage",
        "5GB",
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
  })

  it("does not report success when dedicated BuildKit prune fails", async () => {
    const spawn = mock(() => ({
      stdout: new Response("").body!,
      stderr: new Response("failed to dial buildkitd").body!,
      exited: Promise.resolve(1),
    }))

    const result = await pruneBuildKitCache({
      address: "tcp://buildkitd:1234",
      spawn,
    })

    expect(result).toEqual({
      ok: false,
      exitCode: 1,
      output: "failed to dial buildkitd",
      error: "failed to dial buildkitd",
    })
  })
})
