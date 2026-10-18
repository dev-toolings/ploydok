// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scheduled cron: run user-defined scheduled jobs according to their schedule_cron.
 *
 * Ticker runs every 30 seconds. Each tick:
 * 1. SELECT due jobs (next_run_at <= now, enabled=true)
 * 2. Claim the job locally by marking it running and creating a run row
 * 3. Dispatch based on kind:
 *    - app_exec: call agent.containerExec on the app's runtime container
 *    - container_run: start an ephemeral container, exec the command, clean up
 * 4. Update the run record with status/output/error
 * 5. Persist last_run_* and next_run_at on the job row
 */
import { and, eq, lt } from "drizzle-orm"
import { CronExpressionParser } from "cron-parser"
import { apps, projects, scheduled_job_runs, type Db } from "@ploydok/db"
import {
  createScheduledJobRun,
  getScheduledJob,
  listDueJobs,
  updateScheduledJob,
  updateScheduledJobRun,
} from "@ploydok/db/queries"
import { childLogger } from "../../logger"
import type { Agent as WrappedAgent } from "../../agent/wrapper"
import { ephemeralContainerName, resolveRuntimeContainer } from "../../services/runtime-containers"

const log = childLogger("scheduled-jobs.cron")

let _interval: ReturnType<typeof setInterval> | null = null
let _isRunning = false
const _activeJobs = new Set<string>()
const MAX_CAPTURED_LOG_BYTES = 32 * 1024

type RunnableJob = NonNullable<Awaited<ReturnType<typeof getScheduledJob>>>

export class ScheduledJobAlreadyRunningError extends Error {
  constructor(jobId: string) {
    super(`scheduled job ${jobId} is already running`)
    this.name = "ScheduledJobAlreadyRunningError"
  }
}

class ScheduledJobTimeoutError extends Error {
  constructor(jobId: string, timeoutMs: number) {
    super(`scheduled job ${jobId} timed out after ${timeoutMs}ms`)
    this.name = "ScheduledJobTimeoutError"
  }
}

function computeNextRunAt(
  job: RunnableJob,
  now: Date,
  source: "tick" | "manual"
): Date | null {
  if (source === "manual" && job.next_run_at && job.next_run_at > now) {
    return job.next_run_at
  }

  try {
    const interval = CronExpressionParser.parse(job.schedule_cron, {
      currentDate: now,
    })
    return interval.next().toDate()
  } catch (err) {
    log.warn(
      { err, jobId: job.id, cron: job.schedule_cron },
      "failed to compute next_run_at"
    )
    return job.next_run_at ?? null
  }
}

function normalizeEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [key, String(val)])
  )
}

function truncateLog(text: string): string | null {
  if (text.length === 0) return null
  return text.length > MAX_CAPTURED_LOG_BYTES
    ? text.slice(-MAX_CAPTURED_LOG_BYTES)
    : text
}

function appendLogTail(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length > MAX_CAPTURED_LOG_BYTES
    ? combined.slice(-MAX_CAPTURED_LOG_BYTES)
    : combined
}

function isConcurrentRunConstraint(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const record = err as Record<string, unknown>
  return (
    record["code"] === "23505" &&
    (record["constraint"] === "scheduled_job_runs_one_running_per_job_idx" ||
      String(record["message"] ?? "").includes(
        "scheduled_job_runs_one_running_per_job_idx"
      ))
  )
}

async function execCommandInContainer(
  agent: WrappedAgent,
  opts: {
    jobId: string
    containerId: string
    command: string[]
    timeoutMs: number
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const exec = agent.containerExec()
  let timedOut = false
  let exitCode: number | null = null
  let stdout = ""
  let stderr = ""

  exec.send({
    start: {
      containerId: opts.containerId,
      cmd: opts.command,
      tty: false,
      cols: 220,
      rows: 50,
      user: "",
    },
  })

  const timeoutHandle = setTimeout(() => {
    timedOut = true
    exec.close()
  }, opts.timeoutMs)

  try {
    for await (const frame of exec.events) {
      if (frame.stdout?.length) {
        stdout = appendLogTail(
          stdout,
          Buffer.from(frame.stdout).toString("utf-8")
        )
      }
      if (frame.stderr?.length) {
        stderr = appendLogTail(
          stderr,
          Buffer.from(frame.stderr).toString("utf-8")
        )
      }
      if (frame.exit !== undefined) {
        exitCode = frame.exit.code
        break
      }
    }
  } catch (err) {
    if (!timedOut) throw err
  } finally {
    clearTimeout(timeoutHandle)
    exec.close()
  }

  if (timedOut) {
    throw new ScheduledJobTimeoutError(opts.jobId, opts.timeoutMs)
  }
  if (exitCode === null) {
    throw new Error("container exec ended without exit code")
  }

  return { exitCode, stdout, stderr }
}

async function executeAppCommand(
  db: Db,
  agent: WrappedAgent,
  job: RunnableJob,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!job.app_id) {
    throw new Error("app_exec kind requires app_id")
  }
  if (!job.command || job.command.length === 0) {
    throw new Error("scheduled job command is required")
  }

  const appRows = await db
    .select({
      id: apps.id,
      container_id: apps.container_id,
    })
    .from(apps)
    .where(and(eq(apps.id, job.app_id), eq(apps.project_id, job.org_id)))
    .limit(1)

  const appRow = appRows[0]
  if (!appRow) {
    throw new Error(
      "scheduled job app target does not belong to the organization"
    )
  }

  const resolved =
    appRow.container_id != null
      ? { id: appRow.container_id }
      : await resolveRuntimeContainer(agent, {
          appId: appRow.id,
          preferredContainerRef: null,
        })

  const containerId = resolved?.id
  if (!containerId) {
    throw new Error("app container is not currently running")
  }

  return execCommandInContainer(agent, {
    jobId: job.id,
    containerId,
    command: job.command,
    timeoutMs,
  })
}

async function executeContainerCommand(
  db: Db,
  agent: WrappedAgent,
  job: RunnableJob,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!job.command || job.command.length === 0) {
    throw new Error("scheduled job command is required")
  }

  let image = job.image
  if (!image && job.app_id) {
    const appRows = await db
      .select({ image_ref: apps.image_ref })
      .from(apps)
      .where(and(eq(apps.id, job.app_id), eq(apps.project_id, job.org_id)))
      .limit(1)
    image = appRows[0]?.image_ref ?? null
  }
  if (!image) {
    throw new Error(
      "container_run kind requires image or app_id with image_ref"
    )
  }

  const projectRows = await db
    .select({ network_name: projects.network_name })
    .from(projects)
    .where(eq(projects.id, job.org_id))
    .limit(1)
  const networkName = projectRows[0]?.network_name ?? null

  const created = await agent.containerCreate({
    name: ephemeralContainerName("scheduled-job", job.id),
    image,
    env: normalizeEnv(job.env),
    command: ["sleep", String(Math.ceil(timeoutMs / 1000) + 30)],
    networks: networkName ? [networkName] : [],
    network: networkName ?? "",
    volumes: [],
    ports: [],
    restartPolicy: "no",
    resourceLimits: {
      cpu: 0.5,
      memoryBytes: 256 * 1024 * 1024,
      pidsLimit: 100,
    },
    labels: {
      "ploydok.kind": "scheduled-job",
      "ploydok.org_id": job.org_id,
      "ploydok.scheduled_job_id": job.id,
    },
    user: "",
  })

  try {
    await agent.containerStart({ containerId: created.containerId })
    return await execCommandInContainer(agent, {
      jobId: job.id,
      containerId: created.containerId,
      command: job.command,
      timeoutMs,
    })
  } finally {
    try {
      await agent.containerStop({
        containerId: created.containerId,
        timeoutSeconds: 2,
      })
    } catch {
      // best-effort
    }
    try {
      await agent.containerRemove({
        containerId: created.containerId,
        force: true,
        removeVolumes: false,
      })
    } catch (err) {
      log.warn(
        { err, jobId: job.id, containerId: created.containerId },
        "failed to remove scheduled job container"
      )
    }
  }
}

async function claimScheduledJobRun(
  db: Db,
  jobId: string,
  opts: { allowDisabled?: boolean; source: "tick" | "manual" }
) {
  if (_activeJobs.has(jobId)) {
    throw new ScheduledJobAlreadyRunningError(jobId)
  }

  const startedAt = new Date()

  try {
    return await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db
      const job = await getScheduledJob(txDb, jobId)
      if (!job) throw new Error("scheduled job not found")
      if (!job.enabled && !opts.allowDisabled) {
        throw new Error("scheduled job is disabled")
      }

      const staleBefore = new Date(
        startedAt.getTime() - ((job.timeout_seconds || 300) + 60) * 1000
      )
      await tx
        .update(scheduled_job_runs)
        .set({
          status: "timeout",
          finished_at: startedAt,
          error: "Previous runner stopped before recording completion",
        })
        .where(
          and(
            eq(scheduled_job_runs.job_id, job.id),
            eq(scheduled_job_runs.status, "running"),
            lt(scheduled_job_runs.started_at, staleBefore)
          )
        )

      const nextRunAt = computeNextRunAt(job, startedAt, opts.source)
      const run = await createScheduledJobRun(txDb, {
        job_id: job.id,
        started_at: startedAt,
        finished_at: null,
        status: "running",
        exit_code: null,
        output: null,
        error: null,
      })

      await updateScheduledJob(txDb, job.id, {
        last_run_at: startedAt,
        last_run_status: "running",
        next_run_at: nextRunAt,
      })

      return { job, run, nextRunAt }
    })
  } catch (err) {
    if (isConcurrentRunConstraint(err)) {
      throw new ScheduledJobAlreadyRunningError(jobId)
    }
    throw err
  }
}

export async function runScheduledJobNow(
  db: Db,
  agent: WrappedAgent,
  jobId: string,
  opts: { allowDisabled?: boolean; source: "tick" | "manual" }
) {
  const claimed = await claimScheduledJobRun(db, jobId, opts)
  _activeJobs.add(jobId)

  try {
    const { job, run, nextRunAt } = claimed
    const timeoutMs = (job.timeout_seconds || 300) * 1000
    let status: "succeeded" | "failed" | "timeout" = "failed"
    let exitCode: number | null = null
    let stdout = ""
    let stderr = ""

    try {
      const result =
        job.kind === "app_exec"
          ? await executeAppCommand(db, agent, job, timeoutMs)
          : await executeContainerCommand(db, agent, job, timeoutMs)
      exitCode = result.exitCode
      stdout = result.stdout
      stderr = result.stderr
      status = result.exitCode === 0 ? "succeeded" : "failed"
    } catch (err) {
      status = err instanceof ScheduledJobTimeoutError ? "timeout" : "failed"
      stderr = [stderr, err instanceof Error ? err.message : String(err)]
        .filter(Boolean)
        .join("\n")
    }

    const finishedAt = new Date()

    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db
      const updatedRun = await updateScheduledJobRun(txDb, run.id, {
        status,
        exit_code: exitCode,
        output: truncateLog(stdout),
        error: truncateLog(stderr),
        finished_at: finishedAt,
      })

      await updateScheduledJob(txDb, job.id, {
        last_run_at: finishedAt,
        last_run_status: status,
        next_run_at: nextRunAt,
      })

      return updatedRun
    })
  } finally {
    _activeJobs.delete(jobId)
  }
}

export async function runScheduledJobsTick(
  db: Db,
  agent: WrappedAgent
): Promise<{ queued: number; skipped: number }> {
  if (_isRunning) {
    log.debug("tick already running, skipping")
    return { queued: 0, skipped: 0 }
  }

  _isRunning = true

  try {
    let queued = 0
    const dueJobs = await listDueJobs(db)

    for (const job of dueJobs) {
      log.info(
        { jobId: job.id, name: job.name, cron: job.schedule_cron },
        "job due — running"
      )
      queued++

      void runScheduledJobNow(db, agent, job.id, {
        source: "tick",
      }).catch((err) => {
        if (err instanceof ScheduledJobAlreadyRunningError) {
          log.debug(
            { jobId: job.id },
            "scheduled job already running, skipping"
          )
          return
        }
        log.error({ err, jobId: job.id }, "scheduled job execution failed")
      })
    }

    return { queued, skipped: 0 }
  } finally {
    _isRunning = false
  }
}

export function startScheduledJobsRunner(db: Db, agent: WrappedAgent): void {
  stopScheduledJobsRunner()

  async function tick() {
    try {
      const result = await runScheduledJobsTick(db, agent)
      if (result.queued > 0) {
        log.info(result, "scheduled-jobs cron tick")
      }
    } catch (err) {
      log.error({ err }, "scheduled-jobs cron tick error")
    }
  }

  void tick()
  _interval = setInterval(() => void tick(), 30 * 1000)

  log.info("scheduled-jobs cron started (30s interval)")
}

export function stopScheduledJobsRunner(): void {
  if (_interval !== null) {
    clearInterval(_interval)
    _interval = null
  }
}
