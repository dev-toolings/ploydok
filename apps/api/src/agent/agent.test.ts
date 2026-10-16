// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import * as grpc from "@grpc/grpc-js"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import {
  AgentService,
  type AgentServer,
  type ContainerCreateRequest,
  type ContainerLogsRequest,
  LogLine,
} from "@ploydok/agent-proto"
import { Agent } from "./wrapper.js"
import { AgentError, GrpcStatus } from "./errors.js"
import { createAgentClient } from "./client.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempSocketPath(): string {
  return path.join(
    os.tmpdir(),
    `ploydok-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`
  )
}

/** Démarre un serveur gRPC mock sur un socket unix et retourne { server, socketPath }. */
function startMockServer(
  impl: Partial<AgentServer>
): Promise<{ server: grpc.Server; socketPath: string }> {
  return new Promise((resolve, reject) => {
    const socketPath = tempSocketPath()
    const server = new grpc.Server()

    // Implémentation par défaut : retourne UNIMPLEMENTED pour tout ce qui n'est pas fourni
    const defaultImpl: Partial<AgentServer> = {
      containerCreate: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      containerStart: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      containerStop: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      containerRemove: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      containerLogs: (call) => {
        call.end()
      },
      containerStats: (call) => {
        call.end()
      },
      imagePull: (call) => {
        call.end()
      },
      imageBuild: (call) => {
        call.end()
      },
      networkCreate: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      networkRemove: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      networkConnect: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      networkDisconnect: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      listContainers: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      pingContainer: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      inspectContainerHealth: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      containerExec: (call) => {
        call.end()
      },
      dumpDatabase: (call) => {
        call.end()
      },
      restoreDatabase: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      hostStats: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      listContainerFiles: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      readContainerFile: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      signAuditEntry: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
      getAuditPubkey: (_call, cb) =>
        cb(
          {
            code: grpc.status.UNIMPLEMENTED,
            details: "non implémenté",
            name: "Error",
            message: "non implémenté",
            metadata: new grpc.Metadata(),
          },
          null
        ),
    }

    server.addService(AgentService, {
      ...defaultImpl,
      ...impl,
    } as grpc.UntypedServiceImplementation)
    server.bindAsync(
      `unix://${socketPath}`,
      grpc.ServerCredentials.createInsecure(),
      (err) => {
        if (err) return reject(err)
        resolve({ server, socketPath })
      }
    )
  })
}

function stopServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve) => server.tryShutdown(() => resolve()))
}

// ---------------------------------------------------------------------------
// Suite de tests
// ---------------------------------------------------------------------------

describe("Agent — containerCreate", () => {
  let server: grpc.Server
  let socketPath: string
  let agent: Agent

  beforeAll(async () => {
    ;({ server, socketPath } = await startMockServer({
      containerCreate: (call, cb) => {
        const req: ContainerCreateRequest = call.request
        if (req.name === "ploydok-forbidden") {
          cb(
            {
              code: grpc.status.PERMISSION_DENIED,
              details: "nom interdit par allowlist",
              name: "Error",
              message: "PERMISSION_DENIED",
              metadata: new grpc.Metadata(),
            },
            null
          )
          return
        }
        cb(null, { containerId: "abc123" })
      },
    }))
    agent = new Agent({ socketPath })
  })

  afterAll(async () => {
    agent.close()
    await stopServer(server)
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  })

  it("succès round-trip", async () => {
    const res = await agent.containerCreate({
      name: "ploydok-web",
      image: "nginx:alpine",
      env: {},
      labels: {},
      network: "ploydok-net",
      volumes: [],
      ports: [],
      restartPolicy: "unless-stopped",
      resourceLimits: undefined,
      command: [],
      user: "",
      networks: [],
    })
    expect(res.containerId).toBe("abc123")
  })

  it("PERMISSION_DENIED → AgentError typée", async () => {
    let caught: unknown
    try {
      await agent.containerCreate({
        name: "ploydok-forbidden",
        image: "nginx:alpine",
        env: {},
        labels: {},
        network: "ploydok-net",
        volumes: [],
        ports: [],
        restartPolicy: "",
        resourceLimits: undefined,
        command: [],
        user: "",
        networks: [],
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AgentError)
    const err = caught as AgentError
    expect(err.code).toBe(GrpcStatus.PERMISSION_DENIED)
    expect(err.isForbidden).toBe(true)
    expect(err.message).toContain("action refusée par allowlist")
  })
})

describe("Agent — retry sur UNAVAILABLE", () => {
  let server: grpc.Server
  let socketPath: string
  let agent: Agent
  let callCount: number

  beforeAll(async () => {
    callCount = 0
    ;({ server, socketPath } = await startMockServer({
      containerCreate: (call, cb) => {
        callCount++
        if (callCount === 1) {
          // Premier appel : simule UNAVAILABLE
          cb(
            {
              code: grpc.status.UNAVAILABLE,
              details: "agent temporairement indisponible",
              name: "Error",
              message: "UNAVAILABLE",
              metadata: new grpc.Metadata(),
            },
            null
          )
          return
        }
        // Deuxième appel : succès
        cb(null, { containerId: "retry-ok" })
      },
    }))
    agent = new Agent({ socketPath })
  })

  afterAll(async () => {
    agent.close()
    await stopServer(server)
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  })

  it("1 retry puis succès", async () => {
    const res = await agent.containerCreate({
      name: "ploydok-retry",
      image: "busybox:latest",
      env: {},
      labels: {},
      network: "ploydok-net",
      volumes: [],
      ports: [],
      restartPolicy: "",
      resourceLimits: undefined,
      command: [],
      user: "",
      networks: [],
    })
    expect(res.containerId).toBe("retry-ok")
    expect(callCount).toBe(2)
  })
})

describe("Agent — timeout", () => {
  let server: grpc.Server
  let socketPath: string
  let agent: Agent

  beforeAll(async () => {
    ;({ server, socketPath } = await startMockServer({
      containerCreate: (_call, _cb) => {
        // Ne répond jamais → provoque un timeout
      },
    }))
    agent = new Agent({ socketPath })
  })

  afterAll(async () => {
    agent.close()
    await stopServer(server)
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  })

  it("deadline 100ms honorée → AgentError DEADLINE_EXCEEDED", async () => {
    let caught: unknown
    const start = Date.now()
    try {
      // Timeout très court pour rendre le test rapide
      await agent.containerCreate(
        {
          name: "ploydok-slow",
          image: "slow:latest",
          env: {},
          labels: {},
          network: "",
          volumes: [],
          ports: [],
          restartPolicy: "",
          resourceLimits: undefined,
          command: [],
          user: "",
          networks: [],
        },
        100 // 100ms de timeout
      )
    } catch (e) {
      caught = e
    }
    const elapsed = Date.now() - start
    expect(caught).toBeInstanceOf(AgentError)
    const err = caught as AgentError
    expect(err.code).toBe(GrpcStatus.DEADLINE_EXCEEDED)
    // Le test doit se terminer bien avant 30s
    expect(elapsed).toBeLessThan(5000)
  })
})

describe("Agent — containerLogs stream", () => {
  let server: grpc.Server
  let socketPath: string
  let agent: Agent
  let followCancelled = false

  beforeAll(async () => {
    ;({ server, socketPath } = await startMockServer({
      containerLogs: (call) => {
        if (call.request.follow) {
          call.on("cancelled", () => { followCancelled = true; call.end() })
          call.write({ stream: "stdout", line: "ready", timestamp: "2024-01-01T00:00:00Z" })
          return
        }
        const lines: LogLine[] = [
          {
            stream: "stdout",
            line: "ligne 1",
            timestamp: "2024-01-01T00:00:01Z",
          },
          {
            stream: "stdout",
            line: "ligne 2",
            timestamp: "2024-01-01T00:00:02Z",
          },
          {
            stream: "stderr",
            line: "ligne 3",
            timestamp: "2024-01-01T00:00:03Z",
          },
        ]
        for (const l of lines) {
          call.write(l)
        }
        call.end()
      },
    }))
    agent = new Agent({ socketPath })
  })

  afterAll(async () => {
    agent.close()
    await stopServer(server)
    try {
      fs.unlinkSync(socketPath)
    } catch {
      /* ignore */
    }
  })

  it("yield 3 LogLines puis close", async () => {
    const req: ContainerLogsRequest = {
      containerId: "abc123",
      follow: false,
      sinceUnix: 0,
      tail: 0,
    }

    const received: LogLine[] = []
    for await (const line of agent.containerLogs(req)) {
      received.push(line)
    }

    expect(received).toHaveLength(3)
    expect(received[0]?.line).toBe("ligne 1")
    expect(received[1]?.line).toBe("ligne 2")
    expect(received[2]?.stream).toBe("stderr")
  })
  it("cancels the gRPC follow stream and releases a pending next on return", async () => {
    const iterator = agent.containerLogs({ containerId: "follow", follow: true, sinceUnix: 0, tail: 0 })[Symbol.asyncIterator]()
    expect((await iterator.next()).value?.line).toBe("ready")
    const pending = iterator.next()
    await iterator.return?.()
    expect((await pending).done).toBe(true)
    await Bun.sleep(10)
    expect(followCancelled).toBe(true)
  })

})
