// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, mock } from "bun:test"
import * as realQueries from "@ploydok/db/queries"

const mockCreateScheduledJobRun = mock(
  async (..._args: any[]): Promise<unknown> => null
)
const mockGetScheduledJob = mock(
  async (..._args: any[]): Promise<unknown> => null
)
const mockListDueJobs = mock(async (..._args: any[]): Promise<unknown[]> => [])
const mockUpdateScheduledJob = mock(
  async (_db: unknown, _id: string, patch: Record<string, unknown>) => patch
)
const mockUpdateScheduledJobRun = mock(
  async (_db: unknown, _id: string, patch: Record<string, unknown>) => patch
)

mock.module("@ploydok/db/queries", () => ({
  ...realQueries,
  createScheduledJobRun: mockCreateScheduledJobRun,
  getScheduledJob: mockGetScheduledJob,
  listDueJobs: mockListDueJobs,
  updateScheduledJob: mockUpdateScheduledJob,
  updateScheduledJobRun: mockUpdateScheduledJobRun,
}))

const runnerModule = await import("./scheduled-jobs-runner")
const { runScheduledJobNow } = runnerModule

function makeExecFrames(frames: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame
    },
  }
}

function makeDb(selectRows: unknown[][] = []) {
  let selectCount = 0
  const db: Record<string, unknown> = {}

  db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db)
  db.select = mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(async () => selectRows[selectCount++] ?? []),
      })),
    })),
  }))
  db.update = mock(() => ({
    set: mock(() => ({
      where: mock(async () => []),
    })),
  }))

  return db
}

beforeEach(() => {
  mock.restore()
  mockCreateScheduledJobRun.mockReset()
  mockGetScheduledJob.mockReset()
  mockListDueJobs.mockReset()
  mockUpdateScheduledJob.mockReset()
  mockUpdateScheduledJobRun.mockReset()
})

describe("runScheduledJobNow", () => {
  it("executes app_exec jobs and persists stdout/stderr + success status", async () => {
    const nextRunAt = new Date("2026-04-28T11:00:00.000Z")
    const job = {
      id: "job-1",
      org_id: "org-1",
      name: "Run app command",
      schedule_cron: "0 * * * *",
      kind: "app_exec" as const,
      app_id: "app-1",
      image: null,
      command: ["echo", "hello"],
      env: {},
      timeout_seconds: 5,
      enabled: true,
      next_run_at: nextRunAt,
    }
    const run = {
      id: "run-1",
      job_id: job.id,
      started_at: new Date("2026-04-28T10:00:00.000Z"),
      finished_at: null,
      status: "running" as const,
      exit_code: null,
      output: null,
      error: null,
    }

    mockGetScheduledJob.mockResolvedValue(job)
    mockCreateScheduledJobRun.mockResolvedValue(run)
    mockUpdateScheduledJob.mockImplementation(
      async (_db: unknown, _id: string, patch: Record<string, unknown>) => ({
        ...job,
        ...patch,
      })
    )
    mockUpdateScheduledJobRun.mockImplementation(
      async (_db: unknown, _id: string, patch: Record<string, unknown>) => ({
        ...run,
        ...patch,
      })
    )

    const send = mock(() => {})
    const agent = {
      containerExec: mock(() => ({
        send,
        events: makeExecFrames([
          { ready: { execId: "exec-1" } },
          { stdout: new TextEncoder().encode("hello\n") },
          { stderr: new TextEncoder().encode("warn\n") },
          { exit: { code: 0 } },
        ]),
        close: mock(() => {}),
      })),
    }

    const result = await runScheduledJobNow(
      makeDb([[{ id: "app-1", container_id: "ctr-app-1" }]]) as never,
      agent as never,
      job.id,
      { allowDisabled: true, source: "manual" }
    )

    expect(send).toHaveBeenCalledWith({ start: {
      containerId: "ctr-app-1",
      cmd: ["sh", "-c", 'exec "$@"', "scheduled-job", "echo", "hello"],
      tty: false, cols: 220, rows: 50, user: "",
    } })
    expect(result?.status).toBe("succeeded")
    expect(result?.exit_code).toBe(0)
    expect(result?.output).toContain("hello")
    expect(result?.error).toContain("warn")
    expect(mockUpdateScheduledJob).toHaveBeenCalledTimes(2)
    const firstJobUpdate = mockUpdateScheduledJob.mock.calls[0] as
      | [unknown, string, Record<string, unknown>]
      | undefined
    expect(firstJobUpdate?.[2]).toMatchObject({
      last_run_status: "running",
      next_run_at: nextRunAt,
    })
  })

  it("inherits the app image and owner labels and ensures a missing project network", async () => {
    const job = {
      id: "job-app", org_id: "org-1", app_id: "app-1",
      kind: "container_run", image: null, command: ["printf", "%s", 'a b; $(echo unsafe)'],
      env: {}, timeout_seconds: 5, enabled: true, schedule_cron: "* * * * *",
      next_run_at: null,
    }
    mockGetScheduledJob.mockResolvedValue(job)
    mockCreateScheduledJobRun.mockResolvedValue({ id: "run-app" })
    mockUpdateScheduledJobRun.mockImplementation(async (_db, _id, patch) => patch)
    const containerId = "a".repeat(64)
    const send = mock(() => {})
    const agent = {
      networkCreate: mock(async () => ({ networkId: "network-1" })),
      containerCreate: mock(async (_req: unknown) => ({ containerId })),
      containerStart: mock(async () => ({})),
      containerStop: mock(async () => ({})),
      containerRemove: mock(async () => ({})),
      containerExec: mock(() => ({ send, close: mock(() => {}),
        events: makeExecFrames([{ exit: { code: 0 } }]),
      })),
    }
    const image = "127.0.0.1:5000/app-1:commit"
    const result = await runScheduledJobNow(makeDb([
      [{ image_ref: image }],
      [{ network_name: null, owner_id: "owner-1" }],
      [{ network_name: null }],
    ]) as never, agent as never, job.id, { source: "manual" })

    expect(result?.status).toBe("succeeded")
    expect(agent.networkCreate).toHaveBeenCalledWith({
      name: "ploydok-proj-org-1", driver: "bridge", attachable: false,
      labels: { "ploydok.kind": "project-network", "ploydok.project_id": "org-1" },
    })
    expect(agent.containerCreate.mock.calls[0]?.[0]).toMatchObject({
      image, network: "ploydok-proj-org-1", networks: ["ploydok-proj-org-1"],
      labels: { "ploydok.app_id": "app-1", "ploydok.owner_id": "owner-1" },
    })
    const cmd = ["sh", "-c", 'exec "$@"', "scheduled-job", ...job.command]
    expect(send).toHaveBeenCalledWith({ start: {
      containerId, cmd, tty: false, cols: 220, rows: 50, user: "",
    } })
    // Prove the shell wrapper passes arguments literally, including shell syntax.
    const executed = Bun.spawnSync(cmd)
    expect(executed.exitCode).toBe(0)
    expect(executed.stdout.toString()).toBe(job.command[2]!)
    expect(agent.containerRemove).toHaveBeenCalledWith({ containerId, force: true, removeVolumes: false })
  })

  it("marks container_run jobs as timeout and cleans up the ephemeral container", async () => {
    const job = {
      id: "Job_TIMEOUT-",
      org_id: "org-1",
      name: "Timeout job",
      schedule_cron: "* * * * *",
      kind: "container_run" as const,
      app_id: null,
      image: "alpine:3.20",
      command: ["sleep", "60"],
      env: {},
      timeout_seconds: 1,
      enabled: true,
      next_run_at: new Date("2026-04-28T10:00:00.000Z"),
    }
    const run = {
      id: "run-timeout",
      job_id: job.id,
      started_at: new Date("2026-04-28T10:00:00.000Z"),
      finished_at: null,
      status: "running" as const,
      exit_code: null,
      output: null,
      error: null,
    }

    mockGetScheduledJob.mockResolvedValue(job)
    mockCreateScheduledJobRun.mockResolvedValue(run)
    mockUpdateScheduledJob.mockImplementation(
      async (_db: unknown, _id: string, patch: Record<string, unknown>) => ({
        ...job,
        ...patch,
      })
    )
    mockUpdateScheduledJobRun.mockImplementation(
      async (_db: unknown, _id: string, patch: Record<string, unknown>) => ({
        ...run,
        ...patch,
      })
    )

    let closed = false
    const containerStop = mock(async () => ({}))
    const containerRemove = mock(async () => ({}))
    const agent = {
      containerCreate: mock(async (req: import("@ploydok/agent-proto").ContainerCreateRequest) => {
        expect(req.name).toMatch(/^ploydok-[a-z0-9][a-z0-9-]{0,62}$/)
        expect(req.name).not.toContain("--")
        expect(req.labels).toMatchObject({
          "ploydok.app_id": job.id,
          "ploydok.owner_id": "owner-1",
          "ploydok.scheduled_job_id": job.id,
        })
        expect(req.image).toBe(job.image)
        expect(req.network).toBe("ploydok-org-1")
        expect(req.networks).toEqual([req.network])
        expect(req.volumes).toEqual([])
        expect(req.ports).toEqual([])
        expect(req.healthcheck).toBeUndefined()
        expect(req.user).toBe("")
        expect(req.resourceLimits).toEqual({ cpu: 0.5, memoryBytes: 268435456, pidsLimit: 100 })
        return { containerId: "a".repeat(64) }
      }),
      containerStart: mock(async () => ({})),
      containerStop,
      containerRemove,
      containerExec: mock(() => ({
        send: mock(() => {}),
        events: {
          async *[Symbol.asyncIterator]() {
            while (!closed) {
              await new Promise((resolve) => setTimeout(resolve, 20))
            }
          },
        },
        close: mock(() => {
          closed = true
        }),
      })),
    }

    const result = await runScheduledJobNow(
      makeDb([[{ network_name: "ploydok-org-1", owner_id: "owner-1" }]]) as never,
      agent as never,
      job.id,
      { source: "tick" }
    )

    expect(result?.status).toBe("timeout")
    expect(result?.error).toContain("timed out")
    expect(containerStop).toHaveBeenCalledTimes(1)
    expect(containerRemove).toHaveBeenCalledTimes(1)
  })
})
