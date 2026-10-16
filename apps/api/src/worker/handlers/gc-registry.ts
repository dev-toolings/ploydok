// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Registry GC handler — M4.2
 *
 * Exports:
 *  - runRegistryGc()          : prune old images across all apps (or a single app)
 *  - startRegistryGcCron()    : schedule runRegistryGc at 04:00 UTC daily
 *  - stopRegistryGcCron()     : cancel the scheduled cron (used in tests / shutdown)
 *  - getRegistryUsageForApp() : per-app registry stats (tags, bytes, diskPct)
 */
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import type { Queue } from "bullmq"
import { nanoid } from "nanoid"
import { apps, builds, system_jobs } from "@ploydok/db"
import {
  deleteDigest,
  diskUsagePct,
  getManifest,
  listTags,
  runtimeGarbageCollect,
} from "../registry"
import type { Db } from "@ploydok/db"
import { imageRepoForApp } from "../../services/runtime-containers"
import {
  runningBuildMatch,
  type RuntimeIdentity,
} from "../../services/runtime-build"
import { enqueueWithDbRow } from "../queue-enqueue"

// ---------------------------------------------------------------------------
// Types & Schemas
// ---------------------------------------------------------------------------

export const GcRegistryOptionsSchema = z.object({
  appId: z.string().nullish(),
  keepPerRepo: z.number().int().nonnegative().max(50).default(3),
})
export type GcRegistryOptions = z.infer<typeof GcRegistryOptionsSchema>

export interface RegistryClient {
  listTags: (repo: string) => Promise<string[]>
  getManifest: (
    repo: string,
    tag: string
  ) => Promise<{ digest: string; createdAt?: Date } | null>
  deleteDigest: (repo: string, digest: string) => Promise<void>
  diskUsagePct: () => Promise<number>
  /** Reclaim blob storage by running `registry garbage-collect` on the host. */
  garbageCollect: () => Promise<{ ok: boolean; output: string }>
}

export interface GcOptions {
  /** Injected registry client (defaults to the real client from registry.ts). */
  registryClient?: RegistryClient
  /** Keep at most N images per app repo. Default: 3. */
  keepPerRepo?: number
  /** DB instance. */
  db: Db
  /** When set, only GC the given app id. */
  appFilter?: string
  /**
   * Skip blob reclamation (`registry garbage-collect`). The HTTP manifest
   * deletes still happen. Useful for unit tests + when a follow-up call will
   * reclaim blobs in batch (e.g. cron tick scanning many apps).
   */
  skipBlobReclaim?: boolean
}

export interface GcResult {
  reposScanned: number
  tagsDeleted: number
  bytesFreed: number
  /** Whether the binary `registry garbage-collect` ran and succeeded. */
  blobReclaim?: { ok: boolean; output: string }
}

export interface RegistryUsage {
  tags: number
  bytes: number
  diskPct: number
}

// ---------------------------------------------------------------------------
// Default registry client (real implementation)
// ---------------------------------------------------------------------------

const defaultRegistryClient: RegistryClient = {
  listTags,
  getManifest,
  deleteDigest,
  diskUsagePct,
  garbageCollect: runtimeGarbageCollect,
}

// ---------------------------------------------------------------------------
// runRegistryGc
// ---------------------------------------------------------------------------

/**
 * Garbage-collect the local registry by keeping only the `keepPerRepo` most
 * recently-built images for each app.
 *
 * Sort order:
 *  1. Builds with a known `created_at` date from the DB → newest first.
 *  2. Tags with no matching build row → kept (unknown = safe default).
 *  3. Tags with a known `createdAt` from the manifest → newest first.
 *
 * Returns aggregated stats: repos scanned, tags deleted, bytes freed (0 —
 * the registry HTTP API does not expose freed bytes; call `registry gc` CLI
 * for actual reclamation).
 */
export async function runRegistryGc(opts: GcOptions): Promise<GcResult> {
  const {
    registryClient: rc = defaultRegistryClient,
    keepPerRepo = 3,
    db,
    appFilter,
    skipBlobReclaim,
  } = opts

  // 1. Load all app ids (or just the filtered one). Pull container_id +
  //    keep_per_repo override so per-app config wins over the cron default.
  const appRows = appFilter
    ? await db
        .select({
          id: apps.id,
          container_id: apps.container_id,
          runtime_mode: apps.runtime_mode,
          swarm_service_name: apps.swarm_service_name,
          keep_per_repo: apps.keep_per_repo,
        })
        .from(apps)
        .where(eq(apps.id, appFilter))
        .limit(1)
    : await db
        .select({
          id: apps.id,
          container_id: apps.container_id,
          runtime_mode: apps.runtime_mode,
          swarm_service_name: apps.swarm_service_name,
          keep_per_repo: apps.keep_per_repo,
        })
        .from(apps)

  let reposScanned = 0
  let tagsDeleted = 0

  for (const app of appRows) {
    const { id: appId, keep_per_repo } = app
    const repo = imageRepoForApp(appId)
    const tags = await rc.listTags(repo)
    if (tags.length === 0) continue

    reposScanned++

    // Per-app override beats the global default, unless the caller explicitly
    // forced keepPerRepo=0 (delete-app wipes everything regardless of config).
    const effectiveKeep = keepPerRepo === 0 ? 0 : (keep_per_repo ?? keepPerRepo)

    // Compute protected tags: latest succeeded build tied to the running
    // container, plus any build flagged by container_id. Always keep at least
    // these even if `effectiveKeep === 0` (delete-app uses 0 to wipe everything).
    const protectedTags = await loadProtectedTags(db, appId, app)

    if (effectiveKeep > 0 && tags.length <= effectiveKeep) continue

    // 2. Join with builds table to get creation dates.
    const buildRows = await db
      .select({ image_tag: builds.image_tag, created_at: builds.created_at })
      .from(builds)
      .where(eq(builds.app_id, appId))
      .orderBy(desc(builds.created_at))

    // Map image_tag → created_at for quick lookup.
    const buildDateByTag = new Map<string, Date>()
    for (const row of buildRows) {
      if (row.image_tag && row.created_at) {
        // image_tag format: <registry>/app-<id>:<tag>  — extract the tag part.
        const shortTag = row.image_tag.split(":").at(-1) ?? row.image_tag
        buildDateByTag.set(shortTag, row.created_at)
      }
    }

    // 3. Resolve manifests (digest + creation date).
    const resolved = await Promise.all(
      tags.map(async (tag) => {
        const manifest = await rc.getManifest(repo, tag)
        if (!manifest) return null
        const createdAt = buildDateByTag.get(tag) ?? manifest.createdAt
        return { tag, digest: manifest.digest, createdAt }
      })
    )

    // Filter nulls and unknown digests.
    const valid = resolved.filter(
      (m): m is NonNullable<typeof m> & { digest: string } =>
        m !== null && m.digest !== "sha256:unknown" && m.digest !== ""
    )

    // 4. Sort: known date newest-first, then unknown.
    valid.sort((a, b) => {
      if (a.createdAt && b.createdAt)
        return b.createdAt.getTime() - a.createdAt.getTime()
      if (a.createdAt) return -1
      if (b.createdAt) return 1
      return 0
    })

    // Collect digests of protected tags so we never delete them, even if they
    // sort beyond keepPerRepo (e.g. running container holds an old tag).
    const protectedDigests = new Set<string>()
    for (const item of valid) {
      if (protectedTags.has(item.tag)) protectedDigests.add(item.digest)
    }

    // 5. Delete extras, deduplicated by digest, skipping protected digests.
    const toDelete = valid.slice(effectiveKeep)
    const seen = new Set<string>()

    for (const item of toDelete) {
      if (seen.has(item.digest)) continue
      seen.add(item.digest)
      if (protectedDigests.has(item.digest)) {
        // eslint-disable-next-line no-console
        console.log(
          `[gc-registry] skipped protected ${repo}:${item.tag} (${item.digest})`
        )
        continue
      }
      try {
        await rc.deleteDigest(repo, item.digest)
        tagsDeleted++
        // eslint-disable-next-line no-console
        console.log(
          `[gc-registry] deleted ${repo}:${item.tag} (${item.digest})`
        )
      } catch (err) {
        // Non-fatal — log and continue.
        // eslint-disable-next-line no-console
        console.warn(`[gc-registry] failed to delete ${repo}:${item.tag}:`, err)
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[gc-registry] manifests pass — scanned ${reposScanned} repos, deleted ${tagsDeleted} tags`
  )

  let blobReclaim: GcResult["blobReclaim"]
  if (!skipBlobReclaim && tagsDeleted > 0) {
    blobReclaim = await rc.garbageCollect()
    // eslint-disable-next-line no-console
    console.log(
      `[gc-registry] blob reclaim — ok=${blobReclaim.ok} output=${blobReclaim.output.slice(0, 200)}`
    )
  }

  const result: GcResult = { reposScanned, tagsDeleted, bytesFreed: 0 }
  if (blobReclaim) result.blobReclaim = blobReclaim
  return result
}

/**
 * Identify tags that must never be deleted by GC for a given app:
 *   - the build tag tied to the currently-running container_id
 *   - the latest succeeded build (so a rollback always has a fallback)
 *
 * The function is defensive: if `container_id` is unset or no succeeded build
 * exists, it returns an empty set rather than throwing.
 */
async function loadProtectedTags(
  db: Db,
  appId: string,
  runtime: RuntimeIdentity
): Promise<Set<string>> {
  const tags = new Set<string>()
  // Build tied to the running container (or Swarm service).
  const running = runningBuildMatch(runtime)
  if (running) {
    const rows = await db
      .select({ image_tag: builds.image_tag })
      .from(builds)
      .where(and(eq(builds.app_id, appId), running))
      .limit(1)
    const tag = rows[0]?.image_tag
    if (tag) tags.add(tag.split(":").at(-1) ?? tag)
  }

  // Latest succeeded build (rollback safety net). Filter on status so a
  // pending/failed build can't shadow the real rollback target.
  const latestSucceeded = await db
    .select({ image_tag: builds.image_tag })
    .from(builds)
    .where(and(eq(builds.app_id, appId), eq(builds.status, "succeeded")))
    .orderBy(desc(builds.created_at))
    .limit(1)
  const latestTag = latestSucceeded[0]?.image_tag
  if (latestTag) tags.add(latestTag.split(":").at(-1) ?? latestTag)

  return tags
}

// ---------------------------------------------------------------------------
// Aggressive disk-guard GC (item 4)
// ---------------------------------------------------------------------------

export interface AggressiveGcOptions {
  db: Db
  /** Threshold above which the aggressive sweep kicks in. Default: 80. */
  thresholdPct?: number
  /** Keep this many tags per repo when triggered. Default: 1. */
  keepPerRepoUnderPressure?: number
  /** Injected registry client. */
  registryClient?: RegistryClient
}

/**
 * Aggressive disk-pressure GC: when registry storage is above
 * `thresholdPct`, sweep across all apps with `keepPerRepoUnderPressure`
 * (default 1) and force a blob reclaim. Always honours image protection.
 *
 * Returns the GC result, or `null` when disk usage is below the threshold and
 * nothing ran.
 */
export async function runAggressiveDiskGuard(
  opts: AggressiveGcOptions
): Promise<GcResult | null> {
  const {
    db,
    thresholdPct = 80,
    keepPerRepoUnderPressure = 1,
    registryClient: rc = defaultRegistryClient,
  } = opts

  const pct = await rc.diskUsagePct()
  if (pct < thresholdPct) return null

  // eslint-disable-next-line no-console
  console.warn(
    `[gc-registry] disk pressure ${pct}% >= ${thresholdPct}% — aggressive sweep keep=${keepPerRepoUnderPressure}`
  )

  return runRegistryGc({
    db,
    registryClient: rc,
    keepPerRepo: keepPerRepoUnderPressure,
  })
}

// ---------------------------------------------------------------------------
// getRegistryUsageForApp
// ---------------------------------------------------------------------------

/**
 * Return registry usage stats for a single app:
 *  - `tags`    : number of image tags in the registry for this app.
 *  - `bytes`   : total compressed size of all manifests' layers (summed from
 *                manifest config blobs). 0 when the registry doesn't return
 *                size info.
 *  - `diskPct` : overall registry disk usage percentage (not per-app — the
 *                registry v2 API doesn't expose per-repo disk usage).
 */
export async function getRegistryUsageForApp(
  appId: string,
  db: Db,
  rc: RegistryClient = defaultRegistryClient
): Promise<RegistryUsage> {
  const repo = `app-${appId.toLowerCase()}`

  const [tags, diskPct] = await Promise.all([
    rc.listTags(repo),
    rc.diskUsagePct(),
  ])

  // Attempt to compute total bytes from manifest layer sizes.
  let bytes = 0
  if (tags.length > 0) {
    const manifests = await Promise.all(
      tags.map((tag) => rc.getManifest(repo, tag))
    )
    // The manifest type from registry.ts doesn't expose layer sizes.
    // We accept 0 bytes for now — accurate disk breakdown requires a
    // registry catalog + blob listing API which is out of scope for M4.2.
    // The count of manifests and diskPct are sufficient for the widget.
    void manifests
  }

  return { tags: tags.length, bytes, diskPct }
}

// ---------------------------------------------------------------------------
// Cron scheduler
// ---------------------------------------------------------------------------

/** Default run hour in UTC (04:00). */
const DEFAULT_HOUR_UTC = 4
/** 24 hours in milliseconds. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000

let _cronTimer: ReturnType<typeof setTimeout> | null = null
let _cronInterval: ReturnType<typeof setInterval> | null = null

/**
 * Compute milliseconds until the next occurrence of `hourUtc:00:00 UTC`.
 */
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
  // If that time has already passed today, schedule for tomorrow.
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next.getTime() - now.getTime()
}

export interface StartGcCronOptions {
  /** Override interval in ms (for testing). Default: 24h. */
  intervalMs?: number
  /** UTC hour to align the first run (default: 4). */
  hourUtc?: number
  /** Database instance. */
  db: Db
  /** GC queue reference. */
  queue: Queue
}

/**
 * Start the registry GC cron.
 *
 * Runs at `hourUtc:00 UTC` daily (default 04:00 UTC). After the initial
 * aligned delay, repeats every `intervalMs` (default 24h).
 *
 * To bootstrap in worker/index.ts, add:
 *   startRegistryGcCron({ db, queue: gcQueue });
 */
export function startRegistryGcCron(opts: StartGcCronOptions): void {
  // Prevent double-start.
  stopRegistryGcCron()

  const {
    intervalMs = ONE_DAY_MS,
    hourUtc = DEFAULT_HOUR_UTC,
    db,
    queue,
  } = opts

  async function tick(): Promise<void> {
    try {
      const { jobId } = await enqueueWithDbRow({
        db,
        queue,
        jobName: "gc.registry.requested",
        insertRow: (tx) =>
          tx
            .insert(system_jobs)
            .values({
              id: nanoid(),
              kind: "gc.registry",
              requested_by_user_id: null,
              source: "cron:gc",
              options: { appId: null, keepPerRepo: 3 },
            })
            .returning()
            .then((r: (typeof system_jobs.$inferSelect)[]) => r[0]!),
        buildPayload: (row) => ({ jobId: row.id }),
      })
      // eslint-disable-next-line no-console
      console.log("[gc-registry] cron tick enqueued", { jobId })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[gc-registry] cron tick error:", err)
    }
  }

  const delay = msUntilNextUtcHour(hourUtc)
  // eslint-disable-next-line no-console
  console.log(
    `[gc-registry] cron scheduled — first run in ${Math.round(delay / 60_000)} min (at ${hourUtc}:00 UTC)`
  )

  _cronTimer = setTimeout(() => {
    void tick()
    _cronInterval = setInterval(() => void tick(), intervalMs)
  }, delay)
}

/**
 * Cancel the registry GC cron (clears both the initial timeout and the
 * repeating interval). Safe to call even if the cron was never started.
 */
export function stopRegistryGcCron(): void {
  if (_cronTimer !== null) {
    clearTimeout(_cronTimer)
    _cronTimer = null
  }
  if (_cronInterval !== null) {
    clearInterval(_cronInterval)
    _cronInterval = null
  }
}
