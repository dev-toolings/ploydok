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

    const agent = {
      containerExec: mock(() => ({
        send: mock(() => {}),
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
      containerCreate: mock(async (req: { name: string }) => {
        expect(req.name).toMatch(/^ploydok-[a-z0-9][a-z0-9-]{0,62}$/)
        expect(req.name).not.toContain("--")
        return { containerId: "ctr-ephemeral-1" }
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
      makeDb([[{ network_name: "ploydok-org-1" }]]) as never,
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
