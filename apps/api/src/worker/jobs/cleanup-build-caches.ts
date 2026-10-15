// SPDX-License-Identifier: AGPL-3.0-only
import { lstat, readdir, rm } from "node:fs/promises"
import type { Stats } from "node:fs"
import path from "node:path"
import { env } from "../../env"
import { childLogger } from "../../logger"
import { buildxBuilderName } from "../buildkit"

const log = childLogger("cleanup-build-caches")

export const BUILD_CACHE_DIR_NAMES = [
  ".buildkit-cache",
  ".nixpacks-cache",
] as const

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_AGE_MS = 14 * ONE_DAY_MS
const DEFAULT_HOUR_UTC = 2
const DEFAULT_DOCKER_CACHE_KEEP_DURATION = "168h"
const DEFAULT_DOCKER_CACHE_KEEP_STORAGE = "10g"

let _timer: ReturnType<typeof setTimeout> | null = null
let _interval: ReturnType<typeof setInterval> | null = null

export interface CleanupBuildCachesOptions {
  rootDir?: string
  now?: Date
  maxAgeMs?: number
  activeAppIds?: ReadonlySet<string>
}

export interface CleanupBuildCachesResult {
  appsScanned: number
  cacheDirsScanned: number
  removedDirs: number
  removedBytes: number
  skippedActiveApps: number
}

export interface BuildKitCachePruneResult {
  ok: boolean
  exitCode?: number
  output?: string
  error?: string
}

interface BuildctlProcess {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

async function statDirectory(dir: string): Promise<Stats | null> {
  try {
    const stat = await lstat(dir)
    return stat.isDirectory() ? stat : null
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null
    }
    throw err
  }
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directorySizeBytes(entryPath)
      continue
    }
    if (!entry.isFile()) continue

    const stat = await lstat(entryPath).catch(() => null)
    total += stat?.size ?? 0
  }

  return total
}

function isStale(stat: Stats, now: Date, maxAgeMs: number): boolean {
  return now.getTime() - stat.mtime.getTime() > maxAgeMs
}

export async function cleanupBuildCaches(
  options: CleanupBuildCachesOptions = {}
): Promise<CleanupBuildCachesResult> {
  const rootDir = options.rootDir ?? env.PLOYDOK_BUILD_DIR
  const now = options.now ?? new Date()
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const result: CleanupBuildCachesResult = {
    appsScanned: 0,
    cacheDirsScanned: 0,
    removedDirs: 0,
    removedBytes: 0,
    skippedActiveApps: 0,
  }

  const appEntries = await readdir(rootDir, { withFileTypes: true }).catch(
    () => []
  )

  for (const appEntry of appEntries) {
    if (!appEntry.isDirectory()) continue
    result.appsScanned += 1
    if (options.activeAppIds?.has(appEntry.name)) {
      result.skippedActiveApps += 1
      continue
    }
    const appDir = path.join(rootDir, appEntry.name)

    for (const cacheName of BUILD_CACHE_DIR_NAMES) {
      const cacheDir = path.join(appDir, cacheName)
      const stat = await statDirectory(cacheDir)
      if (!stat) continue

      result.cacheDirsScanned += 1
      if (!isStale(stat, now, maxAgeMs)) continue

      const bytes = await directorySizeBytes(cacheDir)
      await rm(cacheDir, { recursive: true, force: true })
      result.removedDirs += 1
      result.removedBytes += bytes
      log.info(
        { cacheDir, bytes, mtime: stat.mtime.toISOString() },
        "stale build cache removed"
      )
    }
  }

  return result
}

export async function pruneBuildKitCache(opts?: {
  keepDuration?: string
  keepStorage?: string
  address?: string
  spawn?: (
    command: string[],
    options: { stdout: "pipe"; stderr: "pipe" }
  ) => BuildctlProcess
}): Promise<BuildKitCachePruneResult> {
  const keepDuration = opts?.keepDuration ?? DEFAULT_DOCKER_CACHE_KEEP_DURATION
  const keepStorage = opts?.keepStorage ?? DEFAULT_DOCKER_CACHE_KEEP_STORAGE

  try {
    const durationMatch = /^(\d+)h$/.exec(keepDuration)
    const storageMatch = /^(\d+)([gmk])$/i.exec(keepStorage)
    if (!durationMatch || !storageMatch) {
      throw new Error("invalid build-cache retention setting")
    }
    const storageUnit = storageMatch[2]!.toUpperCase()
    const normalizedStorage = `${storageMatch[1]}${storageUnit}B`
    const address = opts?.address ?? env.PLOYDOK_BUILDKIT_ADDR
    const spawn = opts?.spawn ?? Bun.spawn
    const builder = buildxBuilderName(address)
    const proc = spawn(
      builder
        ? [
            "docker",
            "buildx",
            "prune",
            "--builder",
            builder,
            "--force",
            "--filter",
            `until=${keepDuration}`,
            // buildx renamed buildctl's --keep-storage (BuildKit keepBytes).
            "--reserved-space",
            normalizedStorage,
          ]
        : [
            "buildctl",
            "--addr",
            address,
            "prune",
            "--keep-duration",
            keepDuration,
            "--keep-storage",
            normalizedStorage,
          ],
      { stdout: "pipe", stderr: "pipe" }
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
    if (exitCode !== 0) {
      const error = output || `buildctl prune failed (exit ${exitCode})`
      log.warn({ address, exitCode, error }, "dedicated BuildKit prune failed")
      return { ok: false, exitCode, output, error }
    }
    log.info(
      { address, keepDuration, keepStorage: normalizedStorage, output },
      "dedicated BuildKit cache pruned"
    )
    return { ok: true, exitCode, output }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn({ error }, "dedicated BuildKit prune unavailable")
    return { ok: false, error }
  }
}

function msUntilNextUtcHour(hourUtc: number): number {
  const now = new Date()
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0
    )
  )
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now.getTime()
}

export function startCleanupBuildCachesCron(opts?: {
  intervalMs?: number
  hourUtc?: number
  rootDir?: string
}): void {
  stopCleanupBuildCachesCron()

  const intervalMs = opts?.intervalMs ?? ONE_DAY_MS
  const hourUtc = opts?.hourUtc ?? DEFAULT_HOUR_UTC

  async function tick(): Promise<void> {
    try {
      const cleanup = await cleanupBuildCaches(
        opts?.rootDir ? { rootDir: opts.rootDir } : {}
      )
      const buildkit = await pruneBuildKitCache()
      if (!buildkit.ok) {
        log.warn(
          { cleanup, buildkit },
          "build cache cleanup cron tick completed with BuildKit prune failure"
        )
        return
      }
      log.info({ cleanup, buildkit }, "build cache cleanup cron tick done")
    } catch (err) {
      log.warn({ err }, "build cache cleanup cron tick failed")
    }
  }

  const delay = msUntilNextUtcHour(hourUtc)
  log.info(
    { delayMin: Math.round(delay / 60_000), hourUtc },
    "build cache cleanup cron scheduled"
  )

  _timer = setTimeout(() => {
    void tick()
    _interval = setInterval(() => void tick(), intervalMs)
  }, delay)
}

export function stopCleanupBuildCachesCron(): void {
  if (_timer !== null) {
    clearTimeout(_timer)
    _timer = null
  }
  if (_interval !== null) {
    clearInterval(_interval)
    _interval = null
  }
}
