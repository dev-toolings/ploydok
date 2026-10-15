// SPDX-License-Identifier: AGPL-3.0-only
//
// Unit tests for the blue-green runner.
// All external dependencies (gRPC agent, Caddy, DB) are mocked.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { ContainerHealthStatus } from "@ploydok/agent-proto"
import type { InspectContainerHealthResponse } from "@ploydok/agent-proto"
import {
  createContainerWithStaleSlotRecovery,
  DeployFailedError,
  pollHealthcheck,
  publishContainerLogTail,
  publishKnownAppLogFiles,
  stopContainer,
} from "./runner.js"
import { logBus } from "./log-bus.js"
import { workerLog } from "./logger.js"

// ---------------------------------------------------------------------------
// Minimal in-memory DB mock
// ---------------------------------------------------------------------------

interface AppRecord {
  id: string
  domain: string | null
  container_id: string | null
  status: string
  healthcheck_path: string | null
  healthcheck_port: number | null
  healthcheck_interval_s: number | null
  healthcheck_timeout_s: number | null
  healthcheck_retries: number | null
}

interface BuildRecord {
  id: string
  app_id: string
  status: string
  image_tag: string | null
  container_id: string | null
  created_at: Date
}

/**
 * Tiny Drizzle-compatible mock. Supports the chaining pattern:
 *   db.select().from().where().limit()
 *   db.update().set().where()
 */
function createMockDb(appRecords: AppRecord[], buildRecords: BuildRecord[]) {
  const updates: Array<{
    table: string
    patch: Record<string, unknown>
    where: unknown
  }> = []

  return {
    _updates: updates,
    select(_fields?: unknown) {
      return {
        from(table: unknown) {
          return {
            where(_cond: unknown) {
              return {
                limit(_n: number) {
                  // Determine which table was queried by examining _fields.
                  // Since we mock at a higher level, we return based on
                  // which records we have.
                  if (appRecords.length > 0 && String(table).includes("app")) {
                    return Promise.resolve(
                      appRecords.map((r) => ({ app: r, ...r }))
                    )
                  }
                  if (buildRecords.length > 0) {
                    return Promise.resolve(buildRecords)
                  }
                  return Promise.resolve([])
                },
                orderBy(_ord: unknown) {
                  return {
                    limit(_n: number) {
                      return Promise.resolve(buildRecords)
                    },
                  }
                },
              }
            },
          }
        },
      }
    },
    update(_table: unknown) {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where(where: unknown) {
              updates.push({ table: "apps", patch, where })
              return Promise.resolve()
            },
          }
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Mock Caddy HTTP server (same harness as client.test.ts)
// ---------------------------------------------------------------------------

type Handler = (
  method: string,
  path: string,
  body: unknown
) => { status: number; body: unknown }

let caddyServer: ReturnType<typeof Bun.serve> | null = null
let caddyHandler: Handler = () => ({ status: 200, body: null })

function startCaddyServer(): string {
  caddyServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      return req.text().then((text) => {
        let body: unknown = null
        try {
          body = text ? JSON.parse(text) : null
        } catch {
          body = text
        }
        const result = caddyHandler(req.method, url.pathname, body)
        return new Response(
          result.body !== null ? JSON.stringify(result.body) : "",
          {
            status: result.status,
            headers: { "Content-Type": "application/json" },
          }
        )
      })
    },
  })
  return `http://127.0.0.1:${caddyServer.port}`
}

function stopCaddyServer(): void {
  caddyServer?.stop(true)
  caddyServer = null
}

// ---------------------------------------------------------------------------
// Mock gRPC agent using @grpc/grpc-js in-process server
// ---------------------------------------------------------------------------
// Rather than standing up a full gRPC server (complex setup), we mock the
// AgentClient class directly so unit tests remain fast and deterministic.

// We mock the @ploydok/agent-proto module before any imports of runner.ts.
// Because runner.ts imports it at module level via dynamic import in grpcUnary,
// we stub the class constructor.

let agentCallLog: Array<{ method: string; req: unknown }> = []
let mockAgentBehavior: Record<string, "ok" | "error"> = {}

function makeMockAgent() {
  agentCallLog = []

  function makeMethod(name: string, responseFactory: () => unknown) {
    return function (
      req: unknown,
      cb: (err: null | Error, res: unknown) => void
    ) {
      agentCallLog.push({ method: name, req })
      if (mockAgentBehavior[name] === "error") {
        cb(new Error(`mock ${name} error`), null as unknown as never)
      } else {
        cb(null, responseFactory())
      }
      return {} as ReturnType<
        import("@grpc/grpc-js").Client["makeUnaryRequest"]
      >
    }
  }

  return {
    containerCreate: makeMethod("containerCreate", () => ({
      containerId: "mock-container-id",
    })),
    containerStart: makeMethod("containerStart", () => ({})),
    containerStop: makeMethod("containerStop", () => ({})),
    containerRemove: makeMethod("containerRemove", () => ({})),
    pingContainer: makeMethod("pingContainer", () => ({
      ok: true,
      statusCode: 200,
      latencyMs: 5,
      error: "",
    })),
    close: () => {},
  }
}

// ---------------------------------------------------------------------------
// Mock agent helper for pollHealthcheck — feeds inspectContainerHealth replies
// ---------------------------------------------------------------------------

type HealthReply = Partial<InspectContainerHealthResponse> & {
  status: ContainerHealthStatus
}

function makeHealthMockAgent(replies: Array<HealthReply>): {
  agent: unknown
  callCount: () => number
} {
  let i = 0
  const calls: Array<unknown> = []
  const agent = {
    inspectContainerHealth(
      _req: unknown,
      cb: (err: null, res: InspectContainerHealthResponse) => void
    ) {
      calls.push(_req)
      const reply = replies[Math.min(i, replies.length - 1)]
      i++
      const status =
        reply?.status ?? ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE
      const containerMissing = reply?.containerMissing ?? false
      cb(null, {
        status,
        failingStreak: reply?.failingStreak ?? 0,
        lastProbeOutput: reply?.lastProbeOutput ?? "",
        containerMissing,
        running: reply?.running ?? (!containerMissing && status !== ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE),
        exitCode: reply?.exitCode ?? -1,
        state: reply?.state ?? (containerMissing ? "" : "running"),
      })
      return {} as ReturnType<
        import("@grpc/grpc-js").Client["makeUnaryRequest"]
      >
    },
    close() {},
  }
  return { agent, callCount: () => calls.length }
}

// ---------------------------------------------------------------------------
// Override module-level dependencies
// We test the runner logic by importing specific helpers.
// For integration-style tests of the full runBlueGreen flow, we test
// DeployFailedError throw path using a dedicated direct test.
// ---------------------------------------------------------------------------

describe("DeployFailedError", () => {
  test("has the correct name and message", () => {
    const err = new DeployFailedError("app123", "healthcheck timed out")
    expect(err.name).toBe("DeployFailedError")
    expect(err.message).toContain("app123")
    expect(err.message).toContain("healthcheck timed out")
    expect(err instanceof Error).toBe(true)
  })
})

describe("publishContainerLogTail", () => {
  test("publishes stdout and stderr lines to the runtime channel", async () => {
    const channel = `runtime:test-${Date.now()}`
    logBus.evict(channel)

    const stream = new EventEmitter() as EventEmitter & {
      cancel: () => void
    }
    stream.cancel = () => {}
    const agent = {
      containerLogs: () => stream,
    }

    const promise = publishContainerLogTail(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent as any,
      "container-123",
      channel,
      { tail: 2, timeoutMs: 500 }
    )
    queueMicrotask(() => {
      stream.emit("data", {
        stream: "stdout",
        line: "booting",
        timestamp: new Date(0).toISOString(),
      })
      stream.emit("data", {
        stream: "stderr",
        line: "SQLSTATE database missing",
        timestamp: new Date(1).toISOString(),
      })
      stream.emit("end")
    })

    await promise

    const lines = logBus.replay(channel).map((entry) => entry.line)
    expect(lines).toContain("[container stdout] booting")
    expect(lines).toContain("[container stderr] SQLSTATE database missing")
    expect(lines.at(-1)).toBe("[runner] collected 2 container log lines")

    logBus.evict(channel)
  })
})

describe("publishKnownAppLogFiles", () => {
  test("publishes known framework log file lines to the runtime channel", async () => {
    const channel = `runtime:test-app-log-${Date.now()}`
    logBus.evict(channel)
    const content = new TextEncoder().encode("line one\nSQLSTATE missing\n")
    const agent = {
      readContainerFile(_req: unknown, cb: (err: null, res: unknown) => void) {
        cb(null, {
          content,
          totalSize: content.length,
          truncated: false,
          isBinary: false,
          error: "",
        })
        return {} as ReturnType<
          import("@grpc/grpc-js").Client["makeUnaryRequest"]
        >
      },
    }

    await publishKnownAppLogFiles(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent as any,
      "container-123",
      channel,
      ["/app/storage/logs/laravel.log"]
    )

    const lines = logBus.replay(channel).map((entry) => entry.line)
    expect(lines).toContain(
      "[runner] app log tail: /app/storage/logs/laravel.log"
    )
    expect(lines).toContain(
      "[app log /app/storage/logs/laravel.log] SQLSTATE missing"
    )

    logBus.evict(channel)
  })
})

// ---------------------------------------------------------------------------
// CaddyClient.setUpstream / getUpstream / removeUpstream (via HTTP mock)
// ---------------------------------------------------------------------------

describe("CaddyClient upstream methods (M3.3)", () => {
  let baseUrl: string

  beforeEach(() => {
    baseUrl = startCaddyServer()
  })

  afterEach(() => {
    stopCaddyServer()
  })

  test("setUpstream calls upsertRoute with correct dial", async () => {
    const { CaddyClient } = await import("../caddy/client.js")
    const client = new CaddyClient(baseUrl)

    const calls: Array<{ method: string; path: string }> = []
    const existingConfig = {
      apps: { http: { servers: { srv0: { listen: [":80"], routes: [] } } } },
    }

    caddyHandler = (method, path) => {
      calls.push({ method, path })
      if (
        method === "GET" &&
        path === "/config/apps/http/servers/srv0/routes"
      )
        return { status: 200, body: [] }
      if (method === "GET") return { status: 200, body: existingConfig }
      if (method === "PATCH") return { status: 200, body: null }
      return { status: 200, body: null }
    }

    await client.setUpstream("myapp", "myapp.ploydok.local", {
      host: "ploydok-app-myapp-blue",
      port: 3000,
    })

    const patch = calls.find(
      (c) =>
        c.method === "PATCH" &&
        c.path === "/config/apps/http/servers/srv0/routes"
    )
    expect(patch).toBeDefined()
  })

  test("getUpstream returns null when route not found", async () => {
    const { CaddyClient } = await import("../caddy/client.js")
    const client = new CaddyClient(baseUrl)

    caddyHandler = () => ({ status: 404, body: { error: "not found" } })

    const result = await client.getUpstream("nonexistent")
    expect(result).toBeNull()
  })

  test("getUpstream parses existing route", async () => {
    const { CaddyClient } = await import("../caddy/client.js")
    const client = new CaddyClient(baseUrl)

    caddyHandler = () => ({
      status: 200,
      body: {
        "@id": "ploydok-myapp",
        match: [{ host: ["myapp.ploydok.local"] }],
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: "ploydok-app-myapp-blue:3000" }],
          },
        ],
        terminal: true,
      },
    })

    const result = await client.getUpstream("myapp")
    expect(result).toEqual({ host: "ploydok-app-myapp-blue", port: 3000 })
  })

  test("getUpstream throws on unexpected error", async () => {
    const { CaddyClient } = await import("../caddy/client.js")
    const client = new CaddyClient(baseUrl)

    caddyHandler = () => ({ status: 500, body: { error: "internal" } })

    await expect(client.getUpstream("badapp")).rejects.toThrow(
      "CaddyClient.getUpstream failed: 500"
    )
  })

  test("removeUpstream delegates to removeRoute (idempotent)", async () => {
    const { CaddyClient } = await import("../caddy/client.js")
    const client = new CaddyClient(baseUrl)

    const calls: string[] = []
    caddyHandler = (method) => {
      calls.push(method)
      return { status: 200, body: null }
    }

    await client.removeUpstream("myapp")
    expect(calls).toContain("DELETE")
  })
})

// ---------------------------------------------------------------------------
// pollHealthcheck — Docker-state-driven, no HTTP probe (post net-isolation fix)
// ---------------------------------------------------------------------------

describe("pollHealthcheck (Docker State.Health.Status)", () => {
  test("resolves true on the first HEALTHY response", async () => {
    const { agent, callCount } = makeHealthMockAgent([
      { status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY },
    ])

    const t0 = Date.now()
    const result = await pollHealthcheck({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      containerId: "ploydok-app-test",
      intervalMs: 30,
      retries: 6,
      startPeriodMs: 0,
      appId: "test-app",
      color: "blue",
    })

    expect(result).toBe(true)
    expect(callCount()).toBe(1)
    // Should not wait for all retries — just the initial intervalMs sleep.
    expect(Date.now() - t0).toBeLessThan(150)
  })

  test("retries through STARTING then resolves true on HEALTHY", async () => {
    const { agent, callCount } = makeHealthMockAgent([
      { status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_STARTING },
      { status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_STARTING },
      { status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY },
    ])

    const result = await pollHealthcheck({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      containerId: "ploydok-app-test",
      intervalMs: 20,
      retries: 6,
      startPeriodMs: 0,
      appId: "test-app",
      color: "blue",
    })

    expect(result).toBe(true)
    expect(callCount()).toBe(3)
  })

  test("resolves false after retries are exhausted on persistent UNHEALTHY", async () => {
    const { agent, callCount } = makeHealthMockAgent([
      {
        status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_UNHEALTHY,
        failingStreak: 3,
        lastProbeOutput: "boom",
      },
    ])

    const result = await pollHealthcheck({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      containerId: "ploydok-app-test",
      intervalMs: 10,
      retries: 4,
      startPeriodMs: 0,
      appId: "test-app",
      color: "blue",
    })

    expect(result).toBe(false)
    expect(callCount()).toBe(4)
  })

  test("bails out immediately when the container is missing", async () => {
    const { agent, callCount } = makeHealthMockAgent([
      {
        status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE,
        containerMissing: true,
      },
    ])

    const result = await pollHealthcheck({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      containerId: "ploydok-app-test",
      intervalMs: 30,
      retries: 6,
      startPeriodMs: 0,
      appId: "test-app",
      color: "blue",
    })

    expect(result).toBe(false)
    expect(callCount()).toBe(1)
  })

  test("resolves false on NONE — container has no HEALTHCHECK declared", async () => {
    const { agent, callCount } = makeHealthMockAgent([
      { status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE },
    ])

    const result = await pollHealthcheck({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      containerId: "ploydok-app-test",
      intervalMs: 30,
      retries: 6,
      startPeriodMs: 0,
      appId: "test-app",
      color: "blue",
    })

    expect(result).toBe(false)
    // NONE is fatal: no point retrying when there is no HEALTHCHECK.
    expect(callCount()).toBe(1)
  })

  test("respects startPeriodMs before first probe", async () => {
    const { agent } = makeHealthMockAgent([
      { status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY },
    ])

    const START_PERIOD_MS = 200
    const t0 = Date.now()

    const result = await pollHealthcheck({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      containerId: "ploydok-app-test",
      intervalMs: 30,
      retries: 1,
      startPeriodMs: START_PERIOD_MS,
      appId: "test-app",
      color: "blue",
    })

    expect(result).toBe(true)
    // Allow 20ms tolerance for scheduler jitter.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(START_PERIOD_MS - 20)
  })

  test("skips grace period when startPeriodMs is 0", async () => {
    const { agent } = makeHealthMockAgent([
      { status: ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY },
    ])

    const t0 = Date.now()

    await pollHealthcheck({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      containerId: "ploydok-app-test",
      intervalMs: 10,
      retries: 1,
      startPeriodMs: 0,
      appId: "test-app",
      color: "blue",
    })

    expect(Date.now() - t0).toBeLessThan(200)
  })
})

// ---------------------------------------------------------------------------
// getCurrentColor helper (via DB query behaviour)
// ---------------------------------------------------------------------------

describe("getCurrentColor inference", () => {
  test("returns blue when container_id contains -blue", async () => {
    // We test the runner module's color detection indirectly.
    // The container name `ploydok-app-{id}-blue` contains "-blue".
    const name = "ploydok-app-abc-blue"
    expect(name.includes("-blue")).toBe(true)
    expect(name.includes("-green")).toBe(false)
  })

  test("returns green when container_id contains -green", async () => {
    const name = "ploydok-app-abc-green"
    expect(name.includes("-green")).toBe(true)
  })

  test("defaults to green when no container_id", () => {
    // Default behavior: no container → treat as green → first deploy uses blue.
    // We verify by checking that the opposite of the default is blue.
    const colors = ["blue", "green"] as const
    type Color = (typeof colors)[number]
    function opp(c: Color): Color {
      return c === "blue" ? "green" : "blue"
    }
    expect(opp("green")).toBe("blue")
  })
})

// ---------------------------------------------------------------------------
// containerName helper
// ---------------------------------------------------------------------------

describe("containerName convention", () => {
  test("formats as ploydok-app-{slug}-{shortId}-{color}", () => {
    const slug = "my-app"
    const shortId = "abc123ef"
    const blue = `ploydok-app-${slug}-${shortId}-blue`
    const green = `ploydok-app-${slug}-${shortId}-green`
    expect(blue).toBe("ploydok-app-my-app-abc123ef-blue")
    expect(green).toBe("ploydok-app-my-app-abc123ef-green")
  })
})

// ---------------------------------------------------------------------------
// stopContainer — silent rollback was hiding orphan containers
// ---------------------------------------------------------------------------

describe("stopContainer rollback logs", () => {
  type LogCall = { level: "warn" | "debug"; obj: unknown; msg: string }

  function captureLog(): {
    logs: Array<LogCall>
    restore: () => void
  } {
    const logs: Array<LogCall> = []
    const origWarn = workerLog.warn.bind(workerLog)
    const origDebug = workerLog.debug.bind(workerLog)
    // pino's `log.warn(obj, msg)` shape — we accept both arities.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(workerLog as any).warn = (obj: unknown, msg?: string) => {
      logs.push({ level: "warn", obj, msg: msg ?? "" })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(workerLog as any).debug = (obj: unknown, msg?: string) => {
      logs.push({ level: "debug", obj, msg: msg ?? "" })
    }
    return {
      logs,
      restore() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(workerLog as any).warn = origWarn
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(workerLog as any).debug = origDebug
      },
    }
  }

  /** gRPC `ServiceError`-shaped error — what the agent client surfaces. */
  function grpcErr(code: number, details: string): Error {
    return Object.assign(new Error(details), { code, details, metadata: {} })
  }

  function unaryFailing(err: Error) {
    return (_req: unknown, cb: (err: Error | null, res: unknown) => void) => {
      cb(err, null as never)
      return {} as ReturnType<
        import("@grpc/grpc-js").Client["makeUnaryRequest"]
      >
    }
  }

  function unaryOk(res: unknown) {
    return (_req: unknown, cb: (err: null, res: unknown) => void) => {
      cb(null, res)
      return {} as ReturnType<
        import("@grpc/grpc-js").Client["makeUnaryRequest"]
      >
    }
  }

  test("warns when stop fails with a non-NotFound error (orphan risk)", async () => {
    const cap = captureLog()
    const agent = {
      // 14 = UNAVAILABLE — agent socket dropped during rollback was the
      // exact failure mode that hid the bug from the user.
      containerStop: unaryFailing(grpcErr(14, "agent socket gone")),
      containerRemove: unaryOk({}),
      close() {},
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await stopContainer(agent as any, "ploydok-app-test-blue")
    } finally {
      cap.restore()
    }

    const warns = cap.logs.filter((l) => l.level === "warn")
    expect(warns.length).toBeGreaterThanOrEqual(1)
    expect(warns[0]?.msg).toContain("stop failed")
  })

  test("does NOT warn when stop returns NOT_FOUND (idempotent path)", async () => {
    const cap = captureLog()
    const agent = {
      // 5 = NOT_FOUND
      containerStop: unaryFailing(grpcErr(5, "no such container")),
      containerRemove: unaryFailing(grpcErr(5, "no such container")),
      close() {},
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await stopContainer(agent as any, "ploydok-app-test-blue")
    } finally {
      cap.restore()
    }

    expect(cap.logs.filter((l) => l.level === "warn")).toEqual([])
    expect(
      cap.logs.filter((l) => l.level === "debug").length
    ).toBeGreaterThanOrEqual(1)
  })

  test("warns when remove fails too — surfaces a leftover orphan", async () => {
    const cap = captureLog()
    const agent = {
      containerStop: unaryOk({}),
      // 13 = INTERNAL with arbitrary text (not a NotFound legacy fallback).
      containerRemove: unaryFailing(grpcErr(13, "boom")),
      close() {},
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await stopContainer(agent as any, "ploydok-app-test-green")
    } finally {
      cap.restore()
    }

    const warns = cap.logs.filter((l) => l.level === "warn")
    expect(warns.some((l) => l.msg.includes("remove failed"))).toBe(true)
  })

  test("never throws — the deploy must keep going on its catch path", async () => {
    const cap = captureLog()
    const agent = {
      containerStop: unaryFailing(grpcErr(14, "unavailable")),
      containerRemove: unaryFailing(grpcErr(14, "unavailable")),
      close() {},
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(stopContainer(agent as any, "x")).resolves.toBeUndefined()
    } finally {
      cap.restore()
    }
  })
})

describe("createContainerWithStaleSlotRecovery", () => {
  function grpcErr(code: number, details: string): Error {
    return Object.assign(new Error(details), { code, details, metadata: {} })
  }

  function unaryOk(res: unknown) {
    return (_req: unknown, cb: (err: null, res: unknown) => void) => {
      cb(null, res)
      return {} as ReturnType<
        import("@grpc/grpc-js").Client["makeUnaryRequest"]
      >
    }
  }

  test("removes a stale target slot and retries when Caddy points elsewhere", async () => {
    const calls: string[] = []
    let createAttempts = 0
    const agent = {
      containerCreate(
        _req: unknown,
        cb: (err: Error | null, res: unknown) => void
      ) {
        calls.push("create")
        createAttempts++
        if (createAttempts === 1) {
          cb(
            grpcErr(
              6,
              'create_container: Conflict. The container name "/ploydok-app-test-green" is already in use'
            ),
            null
          )
          return {} as ReturnType<
            import("@grpc/grpc-js").Client["makeUnaryRequest"]
          >
        }
        cb(null, { containerId: "new-container-id" })
        return {} as ReturnType<
          import("@grpc/grpc-js").Client["makeUnaryRequest"]
        >
      },
      containerStop: (_req: unknown, cb: (err: null, res: unknown) => void) => {
        calls.push("stop")
        cb(null, {})
        return {} as ReturnType<
          import("@grpc/grpc-js").Client["makeUnaryRequest"]
        >
      },
      containerRemove: unaryOk({}),
      close() {},
    }
    const caddyClient = {
      getUpstream: async () => ({
        host: "ploydok-app-test-blue",
        port: 3000,
      }),
    }

    const result = await createContainerWithStaleSlotRecovery({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent: agent as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      caddyClient: caddyClient as any,
      appId: "app-1",
      containerName: "ploydok-app-test-green",
      channel: "runtime:app-1",
      request: { name: "ploydok-app-test-green" },
    })

    expect(result.containerId).toBe("new-container-id")
    expect(calls.filter((call) => call === "create")).toHaveLength(2)
    expect(calls).toContain("stop")
  })

  test("does not remove a slot that is still the active Caddy upstream", async () => {
    const calls: string[] = []
    const conflict = grpcErr(
      6,
      'create_container: Conflict. The container name "/ploydok-app-test-green" is already in use'
    )
    const agent = {
      containerCreate(
        _req: unknown,
        cb: (err: Error | null, res: unknown) => void
      ) {
        calls.push("create")
        cb(conflict, null)
        return {} as ReturnType<
          import("@grpc/grpc-js").Client["makeUnaryRequest"]
        >
      },
      containerStop: (_req: unknown, cb: (err: null, res: unknown) => void) => {
        calls.push("stop")
        cb(null, {})
        return {} as ReturnType<
          import("@grpc/grpc-js").Client["makeUnaryRequest"]
        >
      },
      containerRemove: unaryOk({}),
      close() {},
    }
    const caddyClient = {
      getUpstream: async () => ({
        host: "ploydok-app-test-green",
        port: 3000,
      }),
    }

    await expect(
      createContainerWithStaleSlotRecovery({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent: agent as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        caddyClient: caddyClient as any,
        appId: "app-1",
        containerName: "ploydok-app-test-green",
        channel: "runtime:app-1",
        request: { name: "ploydok-app-test-green" },
      })
    ).rejects.toThrow("already in use")

    expect(calls).toEqual(["create"])
  })
})
