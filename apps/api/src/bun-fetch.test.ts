// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { createApiFetch, type ApiBindings } from "./bun-fetch"
import { wsHandler, wsRouter } from "./routes/ws"
import { wsExecRouter } from "./routes/apps-exec"
import { createInvitationRegisterRateLimit } from "./security/invitations-rate-limit"

const rateLimitKeys: string[] = []
const app = new Hono<{ Bindings: ApiBindings }>()
app.route("/ws", wsRouter)
app.route("/ws", wsExecRouter)
app.use(
  "/register",
  createInvitationRegisterRateLimit(
    {
      eval: async (_script: string, _keyCount: number, key: string) => {
        rateLimitKeys.push(key)
        return [1, 9]
      },
    } as never,
    { trustProxyHeaders: false }
  )
)
app.post("/register", (c) => c.json({ ok: true }))

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApiFetch(app),
    websocket: wsHandler,
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})
afterAll(async () => {
  await server.stop(true)
})

describe("Bun fetch bindings", () => {
  it.each([
    "/ws/apps/app-1/build/build-1",
    "/ws/apps/app-1/logs",
    "/ws/databases/db-1/logs",
    "/ws/services/service-1/logs",
    "/ws/apps/app-1/exec",
  ])("upgrades %s before rejecting the missing cookie", async (path) => {
    let opened = false
    let socket: WebSocket | undefined
    try {
      const closed = await new Promise<CloseEvent>((resolve, reject) => {
        socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}${path}`)
        socket.onopen = () => {
          opened = true
        }
        socket.onclose = resolve
        socket.onerror = () =>
          reject(new Error(`WebSocket upgrade failed: ${path}`))
      })
      expect(opened).toBe(true)
      expect(closed.code).toBe(4001)
    } finally {
      socket?.close()
    }
  })

  it("passes the socket IP to invitation rate limiting despite spoofed headers", async () => {
    rateLimitKeys.length = 0
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(rateLimitKeys).toEqual(["rl:invitation-register:ip:127.0.0.1"])
  })
})
