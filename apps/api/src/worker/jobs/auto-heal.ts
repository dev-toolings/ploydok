// SPDX-License-Identifier: AGPL-3.0-only
//
// Auto-heal cron: reconciles the agent's live container snapshots against
// runtime-recoverable apps (see app-runtime-reconciler.ts) and restarts any
// app whose container reports `unhealthy`. Restarts are bounded by a rolling
// per-app budget so a crash-looping app is not restarted forever — once the
// budget is exhausted within the current window we stop trying and notify
// once instead of spamming a notification on every tick.

import { eq, inArray } from "drizzle-orm"
import { apps, projects, createRedis } from "@ploydok/db"
import type { Db, Redis } from "@ploydok/db"
import type { Agent } from "../../agent"
import { childLogger } from "../../logger"
import {
  getAgentAvailability,
  logAgentDependentFailure,
} from "../../agent/availability"
import { env } from "../../env"
import { dispatch } from "../../notify/index"
import { getSharedAgent } from "../../debug/singletons"
import {
  loadAppContainerIndex,
  type AppContainerIndex,
} from "../../services/app-status-reconciler"
import {
  fetchRuntimeRecoveryCandidates,
  type RestartAppForRecovery,
  type RuntimeRecoveryApp,
} from "../../services/app-runtime-reconciler"

const log = childLogger("cron.auto-heal")

export const MAX_RESTARTS = 3
export const WINDOW_MS = 10 * 60_000
export const AUTO_HEAL_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// Restart budget (pure, unit-testable)
// ---------------------------------------------------------------------------

export interface RestartBudgetState {
  timestamps: number[]
}

/** True if one more restart is allowed for this app within the window. */
export function withinBudget(
  state: RestartBudgetState,
  nowMs: number,
  maxRestarts: number,
  windowMs: number
): boolean {
  const cutoff = nowMs - windowMs
  const recent = state.timestamps.filter((t) => t > cutoff)
  return recent.length < maxRestarts
}

/** Appends a restart timestamp and drops entries that fell out of the window. */
export function recordRestart(
  state: RestartBudgetState,
  nowMs: number,
  windowMs: number
): RestartBudgetState {
  const cutoff = nowMs - windowMs
  const timestamps = state.timestamps.filter((t) => t > cutoff)
  timestamps.push(nowMs)
  return { timestamps }
}

// ---------------------------------------------------------------------------
// Reconcile tick
// ---------------------------------------------------------------------------

type AppMeta = { name: string; project_id: string; owner_id: string }

export interface AutoHealResult {
  scanned: number
  healed: number
  gaveUp: number
  skipped: number
}

export interface AutoHealDeps {
  restartApp?: RestartAppForRecovery
  dispatch?: typeof dispatch
  loadIndex?: (agent: Agent) => Promise<AppContainerIndex | null>
  now?: () => number
}

const BUDGET_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
redis.call("PEXPIRE", KEYS[1], ARGV[5])
return 1
`

const RELEASE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

function redisKey(kind: "lock" | "budget" | "gave-up", appId: string) {
  return `ploydok:autoheal:${kind}:${appId}`
}

async function reserveRestartAttempt(
  redis: Redis,
  appId: string,
  nowMs: number
): Promise<boolean> {
  const result = await redis.eval(
    BUDGET_SCRIPT,
    1,
    redisKey("budget", appId),
    String(nowMs - WINDOW_MS),
    String(MAX_RESTARTS),
    String(nowMs),
    `${nowMs}:${crypto.randomUUID()}`,
    String(WINDOW_MS)
  )
  return Number(result) === 1
}

function resolveUnhealthySnapshot(
  app: RuntimeRecoveryApp,
  index: AppContainerIndex
) {
  let snap =
    app.container_id !== null
      ? (index.byContainerId.get(app.container_id) ??
        index.byContainerName.get(app.container_id))
      : undefined
  if (!snap) {
    snap = index.bestByAppId.get(app.id)
  }
  return snap
}

async function fetchAppMeta(
  db: Db,
  ids: string[]
): Promise<Map<string, AppMeta>> {
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      project_id: apps.project_id,
      owner_id: projects.owner_id,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .where(inArray(apps.id, ids))

  return new Map(rows.map((row) => [row.id, row]))
}

export async function runAutoHealOnce(
  db: Db,
  agent: Agent,
  redis: Redis,
  deps: AutoHealDeps = {}
): Promise<AutoHealResult> {
  const result: AutoHealResult = {
    scanned: 0,
    healed: 0,
    gaveUp: 0,
    skipped: 0,
  }

  const loadIndex = deps.loadIndex ?? loadAppContainerIndex
  const index = await loadIndex(agent)
  if (!index) {
    if (getAgentAvailability().state === "down") {
      log.debug("auto-heal skipped: agent unavailable")
    } else {
      log.warn("auto-heal skipped: container snapshot unavailable")
    }
    return result
  }

  const candidates = await fetchRuntimeRecoveryCandidates(db)
  result.scanned = candidates.length

  const unhealthyApps: RuntimeRecoveryApp[] = []
  for (const app of candidates) {
    const snap = resolveUnhealthySnapshot(app, index)
    if (snap?.status === "unhealthy") {
      unhealthyApps.push(app)
    } else {
      await redis.del(redisKey("gave-up", app.id))
      result.skipped++
    }
  }

  if (unhealthyApps.length === 0) return result

  const now = deps.now ?? Date.now
  const restartApp =
    deps.restartApp ?? (await import("../runner.js")).restartApp
  const dispatchFn = deps.dispatch ?? dispatch
  const meta = await fetchAppMeta(
    db,
    unhealthyApps.map((app) => app.id)
  )

  for (const app of unhealthyApps) {
    const nowMs = now()
    const info = meta.get(app.id)
    const lockKey = redisKey("lock", app.id)
    const lockToken = crypto.randomUUID()
    const acquired = await redis.set(lockKey, lockToken, "PX", WINDOW_MS, "NX")
    if (acquired !== "OK") {
      result.skipped++
      continue
    }

    try {
      const allowed = await reserveRestartAttempt(redis, app.id, nowMs)
      if (!allowed) {
        result.gaveUp++
        const shouldNotify =
          (await redis.set(
            redisKey("gave-up", app.id),
            "1",
            "PX",
            WINDOW_MS,
            "NX"
          )) === "OK"
        if (shouldNotify && info) {
          log.warn(
            { appId: app.id },
            "auto-heal restart budget exhausted — giving up this window"
          )
          await dispatchFn(
            db,
            redis,
            "app.autoheal_failed",
            { appId: app.id, appName: info.name },
            { userId: info.owner_id, projectId: info.project_id }
          ).catch((err) =>
            log.warn(
              { err, appId: app.id },
              "auto-heal gave-up notification dispatch failed (non-fatal)"
            )
          )
        }
        continue
      }

      await redis.del(redisKey("gave-up", app.id))
      try {
        await restartApp(app.id, db, undefined, { background: false })
        result.healed++
        log.info({ appId: app.id }, "auto-heal restarted unhealthy app")

        if (info) {
          await dispatchFn(
            db,
            redis,
            "app.autohealed",
            { appId: app.id, appName: info.name },
            { userId: info.owner_id, projectId: info.project_id }
          ).catch((err) =>
            log.warn(
              { err, appId: app.id },
              "auto-heal notification dispatch failed (non-fatal)"
            )
          )
        }
      } catch (err) {
        result.skipped++
        log.warn({ err, appId: app.id }, "auto-heal restart attempt failed")
      }
    } finally {
      await redis
        .eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken)
        .catch((err) =>
          log.warn({ err, appId: app.id }, "auto-heal lock release failed")
        )
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Cron lifecycle
// ---------------------------------------------------------------------------

let _timer: ReturnType<typeof setInterval> | null = null
let _running = false
let _redis: Redis | null = null

function getAutoHealRedis(): Redis {
  if (!_redis) {
    _redis = createRedis(env.REDIS_URL)
  }
  return _redis
}

async function autoHealTick(db: Db): Promise<void> {
  if (_running) return
  _running = true
  try {
    const agent = getSharedAgent()
    const redis = getAutoHealRedis()
    const result = await runAutoHealOnce(db, agent, redis)
    if (result.gaveUp > 0) {
      log.warn(
        result,
        "auto-heal tick: one or more apps exhausted restart budget"
      )
    } else {
      log.debug(result, "auto-heal tick complete")
    }
  } catch (err) {
    logAgentDependentFailure(log, err, {}, "auto-heal tick failed")
  } finally {
    _running = false
  }
}

export function startAutoHealCron(db: Db): void {
  stopAutoHealCron()
  _timer = setInterval(() => {
    void autoHealTick(db)
  }, AUTO_HEAL_INTERVAL_MS)
  log.info(
    {
      intervalMs: AUTO_HEAL_INTERVAL_MS,
      maxRestarts: MAX_RESTARTS,
      windowMs: WINDOW_MS,
    },
    "auto-heal cron scheduled"
  )
}

export function stopAutoHealCron(): void {
  if (_timer !== null) {
    clearInterval(_timer)
    _timer = null
  }
  if (_redis) {
    _redis.disconnect()
    _redis = null
  }
}
