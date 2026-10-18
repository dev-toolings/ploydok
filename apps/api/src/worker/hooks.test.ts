// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock, beforeEach } from "bun:test"
import { runPreDeployHook, runPostDeployHook, HookFailedError } from "./hooks"
import type { HookContext } from "./hooks"
import type { Agent } from "../agent/index.js"
import { AgentError, GrpcStatus } from "../agent/errors"
import { logBus } from "./log-bus"
import { Metadata } from "@grpc/grpc-js"
import { classifyAgentError, FatalDeployError } from "./errors"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFrame(fields: {
  stdout?: string
  stderr?: string
  exitCode?: number
  ready?: boolean
}) {
  return {
    stdout: fields.stdout ? new TextEncoder().encode(fields.stdout) : undefined,
    stderr: fields.stderr ? new TextEncoder().encode(fields.stderr) : undefined,
    exit: fields.exitCode !== undefined ? { code: fields.exitCode } : undefined,
    ready: fields.ready ? { execId: "exec-1" } : undefined,
  }
}

async function* makeExecEvents(frames: ReturnType<typeof makeFrame>[]) {
  for (const f of frames) yield f
}

function makeAgent(opts: {
  exitCode?: number
  createFail?: boolean
  startFail?: boolean
}): Agent {
  const { exitCode = 0, createFail = false, startFail = false } = opts

  const execEvents = makeExecEvents([
    makeFrame({ ready: true }),
    makeFrame({ stdout: "hook output\n" }),
    makeFrame({ exitCode }),
  ])

  return {
    containerCreate: createFail
      ? mock(() => Promise.reject(new Error("create failed")))
      : mock(() => Promise.resolve({ containerId: "a".repeat(64) })),
    containerStart: startFail
      ? mock(() => Promise.reject(new Error("start failed")))
      : mock(() => Promise.resolve({})),
    containerStop: mock(() => Promise.resolve({})),
    containerRemove: mock(() => Promise.resolve({})),
    containerExec: mock(() => ({
      send: mock(() => {}),
      events: execEvents,
      close: mock(() => {}),
    })),
    ensureProjectNetwork: mock(() => Promise.resolve("ploydok-proj-1")),
  } as unknown as Agent
}

function makeDb(): import("@ploydok/db").Db {
  // Minimal fake db — ensureProjectNetwork reads from projects table
  const rows = [{ network_name: "ploydok-proj-1" }]
  return {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(() => Promise.resolve(rows)),
        })),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve([])),
      })),
    })),
    insert: mock(() => ({
      values: mock(() => Promise.resolve([])),
    })),
  } as unknown as import("@ploydok/db").Db
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// We mock ensureProjectNetwork to avoid real DB calls
import * as projectsMod from "../services/projects.js"

beforeEach(() => {
  mock.restore()
})

describe("runPreDeployHook", () => {
  it("satisfies strict agent create and lifecycle rules for both hook phases", async () => {
    for (const run of [runPreDeployHook, runPostDeployHook]) {
      for (const appId of ["vAabMU-x0H0WQxlqV9J1-", "A_".repeat(100), "___"]) {
        const names: string[] = []
        const agent = makeAgent({})
        agent.containerCreate = mock(async (req) => {
          names.push(req.name)
          expect(req.name).toMatch(/^ploydok-[a-z0-9][a-z0-9-]{0,62}$/)
          expect(req.name).not.toContain("--")
          // Mirror StrictValidator create rules with the installer registry allowlist.
          expect(req.image).toBe("127.0.0.1:5000/app:tag")
          expect(req.labels).toMatchObject({
            "ploydok.app_id": appId,
            "ploydok.owner_id": "owner-1",
            "ploydok.kind": "hook",
          })
          expect(req.volumes).toEqual([])
          expect(req.ports).toEqual([])
          expect(req.healthcheck).toBeUndefined()
          expect(req.network).toBe("ploydok-proj-1")
          expect(req.networks).toEqual([req.network])
          expect(req.user).toBe("")
          expect(req.resourceLimits).toEqual({ cpu: 0.5, memoryBytes: 268435456, pidsLimit: 100 })
          expect(req.resourceLimits!.cpu).toBeLessThanOrEqual(4)
          expect(req.resourceLimits!.memoryBytes).toBeLessThanOrEqual(8 * 1024 ** 3)
          return { containerId: "a".repeat(64) }
        })
        const send = mock(() => {})
        agent.containerExec = mock(() => ({ send, events: makeExecEvents([
          makeFrame({ stdout: "hook output\n", stderr: "hook warning\n" }), makeFrame({ exitCode: 0 }),
        ]), close: mock(() => {}) }))
        const result = await run({
          db: makeDb(), agent, appId, ownerId: "owner-1", projectId: "proj-1",
          imageRef: "127.0.0.1:5000/app:tag", env: {}, buildId: "bld-1",
        }, "echo hello", 60)
        if (run === runPostDeployHook) expect(result).toEqual({ ok: true })
        expect(names).toHaveLength(1)
        const phase = run === runPreDeployHook ? "pre" : "post"
        const lines = logBus.replay("build:bld-1").map((entry) => entry.line)
        expect(lines).toContain(`[hook:${phase}] hook output`)
        expect(lines).toContain(`[hook:${phase}] [stderr] hook warning`)
        // Start/exec/stop/remove accept Docker hex ids, and exec requires a shell.
        const containerId = "a".repeat(64)
        expect(agent.containerStart).toHaveBeenCalledWith({ containerId })
        expect(send).toHaveBeenCalledWith({ start: {
          containerId, cmd: ["sh", "-c", "echo hello"], tty: false,
          cols: 220, rows: 50, user: "",
        } })
        expect(agent.containerStop).toHaveBeenCalledWith({ containerId, timeoutSeconds: 2 })
        expect(agent.containerRemove).toHaveBeenCalledWith({ containerId, force: true, removeVolumes: false })
      }
    }
  })

  it("fails closed and cleans up when exec is refused or ends without an exit", async () => {
    for (const refused of [true, false]) {
      const agent = makeAgent({})
      agent.containerExec = mock(() => ({
        send: mock(() => {}), close: mock(() => {}),
        events: (async function* () {
          if (refused) throw new Error("exec_cmd_not_allowed")
        })(),
      }))
      await expect(runPreDeployHook({
        db: makeDb(), agent, appId: "app-1", ownerId: "owner-1", projectId: "proj-1",
        imageRef: "127.0.0.1:5000/app:tag", env: {}, buildId: "bld-1",
      }, "echo hello", 60)).rejects.toThrow(refused ? "exec_cmd_not_allowed" : "without exit code")
      expect(agent.containerRemove).toHaveBeenCalledWith({
        containerId: "a".repeat(64), force: true, removeVolumes: false,
      })
    }
  })

  it("preserves agent policy refusals as fatal errors through the hook wrapper", async () => {
    const refusal = new AgentError(Object.assign(new Error("policy refusal"), {
      code: GrpcStatus.INVALID_ARGUMENT,
      details: "container_name_prefix",
      metadata: new Metadata(),
    }))
    const agent = makeAgent({})
    agent.containerCreate = mock(async () => { throw refusal })
    let caught: unknown
    try {
      await runPreDeployHook({
        db: makeDb(), agent, appId: "app-1", ownerId: "owner-1", projectId: "proj-1",
        imageRef: "127.0.0.1:5000/app:tag", env: {}, buildId: "bld-1",
      }, "echo hello", 60)
    } catch (err) {
      caught = err
    }
    expect((caught as Error).cause).toBe(refusal)
    expect(classifyAgentError(caught)).toBeInstanceOf(FatalDeployError)
  })

  it("resolves when hook exits 0", async () => {
    mock.module("../projects.js", () => ({
      ensureProjectNetwork: mock(() => Promise.resolve("ploydok-proj-1")),
    }))

    const agent = makeAgent({ exitCode: 0 })
    const ctx: HookContext = {
      db: makeDb(),
      agent,
      appId: "app-1",
      ownerId: "owner-1",
      projectId: "proj-1",
      imageRef: "127.0.0.1:5000/app-1:abc",
      env: { NODE_ENV: "production" },
      buildId: "bld-1",
    }

    await expect(runPreDeployHook(ctx, "echo hello", 60)).resolves.toBeUndefined()
  })

  it("throws HookFailedError when hook exits non-zero", async () => {
    mock.module("../projects.js", () => ({
      ensureProjectNetwork: mock(() => Promise.resolve("ploydok-proj-1")),
    }))

    const agent = makeAgent({ exitCode: 1 })
    const ctx: HookContext = {
      db: makeDb(),
      agent,
      appId: "app-1",
      ownerId: "owner-1",
      projectId: "proj-1",
      imageRef: "127.0.0.1:5000/app-1:abc",
      env: {},
      buildId: "bld-1",
    }

    await expect(runPreDeployHook(ctx, "exit 1", 60)).rejects.toThrow(HookFailedError)
  })

  it("throws when containerCreate fails", async () => {
    mock.module("../projects.js", () => ({
      ensureProjectNetwork: mock(() => Promise.resolve("ploydok-proj-1")),
    }))

    const agent = makeAgent({ createFail: true })
    const ctx: HookContext = {
      db: makeDb(),
      agent,
      appId: "app-1",
      ownerId: "owner-1",
      projectId: "proj-1",
      imageRef: "127.0.0.1:5000/app-1:abc",
      env: {},
      buildId: "bld-1",
    }

    await expect(runPreDeployHook(ctx, "echo hi", 60)).rejects.toThrow("Failed to create pre_deploy hook container")
  })
})

describe("runPostDeployHook", () => {
  it("returns { ok: true } on success", async () => {
    mock.module("../projects.js", () => ({
      ensureProjectNetwork: mock(() => Promise.resolve("ploydok-proj-1")),
    }))

    const agent = makeAgent({ exitCode: 0 })
    const ctx: HookContext = {
      db: makeDb(),
      agent,
      appId: "app-1",
      ownerId: "owner-1",
      projectId: "proj-1",
      imageRef: "127.0.0.1:5000/app-1:abc",
      env: {},
      buildId: "bld-1",
    }

    const result = await runPostDeployHook(ctx, "echo done", 60)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it("returns { ok: false, error } on failure — never throws", async () => {
    mock.module("../projects.js", () => ({
      ensureProjectNetwork: mock(() => Promise.resolve("ploydok-proj-1")),
    }))

    const agent = makeAgent({ exitCode: 42 })
    const ctx: HookContext = {
      db: makeDb(),
      agent,
      appId: "app-1",
      ownerId: "owner-1",
      projectId: "proj-1",
      imageRef: "127.0.0.1:5000/app-1:abc",
      env: {},
      buildId: "bld-1",
    }

    const result = await runPostDeployHook(ctx, "exit 42", 60)
    expect(result.ok).toBe(false)
    expect(result.error).toContain("42")
  })
})
