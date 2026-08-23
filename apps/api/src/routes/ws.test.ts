// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for WebSocket log streaming endpoints (M3.2).
//
// Full WebSocket handshake tests require a live Bun server with the
// `websocket` handler registered — that requires integration test infra
// (real DB, real JWT).  Here we focus on:
//   1. The wsRouter stub responses when auth is missing (HTTP-level test
//      before upgrade — Hono will respond with a non-101 when the WS
//      upgrade middleware cannot proceed).
//   2. Smoke: wsRouter is exported and has the expected routes registered.
//
// End-to-end WS tests (replay + live stream) live in the log-bus.test.ts
// which tests the LogBus independently, and in future E2E Playwright specs.

import { describe, it, expect } from "bun:test"
import { wsRouter } from "./ws"

const wsEnv = { server: { upgrade: () => false } }

// ---------------------------------------------------------------------------
// Smoke: router is a Hono instance with the right shape
// ---------------------------------------------------------------------------

describe("wsRouter shape", () => {
  it("is exported and has a fetch function (Hono)", () => {
    expect(typeof wsRouter.fetch).toBe("function")
  })

  it("responds to unknown routes with 404", async () => {
    const res = await wsRouter.fetch(
      new Request("http://localhost/apps/x/unknown-route"),
      wsEnv
    )
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Auth rejection: requests without a valid cookie must not successfully
// upgrade (Bun will respond non-101).  Without a real Bun server that
// registered `websocket:`, the upgrade middleware falls back to a regular
// HTTP response. We assert it does NOT return 200 or 101 for unauthenticated
// plain HTTP GETs (i.e. no Upgrade header), which exercises the auth path.
// ---------------------------------------------------------------------------

describe("wsRouter auth", () => {
  it("/apps/:id/build/:buildId — plain GET without cookie returns non-200", async () => {
    const res = await wsRouter.fetch(
      new Request("http://localhost/apps/app-1/build/build-1"),
      wsEnv
    )
    // Without a valid JWT cookie the endpoint should either 401 or
    // perform a WebSocket upgrade (101).  Since there is no live Bun
    // server backing this test, the upgrade middleware internally calls
    // server.upgrade() which fails gracefully — Hono/Bun returns a
    // 426 Upgrade Required or the handler's fallback.
    // We just assert it is NOT a plain 200 success (which would be wrong).
    expect(res.status).not.toBe(200)
  })

  it("/apps/:id/logs — plain GET without cookie returns non-200", async () => {
    const res = await wsRouter.fetch(
      new Request("http://localhost/apps/app-1/logs"),
      wsEnv
    )
    expect(res.status).not.toBe(200)
  })

  it("/databases/:id/logs — plain GET without cookie returns non-200", async () => {
    const res = await wsRouter.fetch(
      new Request("http://localhost/databases/db-1/logs"),
      wsEnv
    )
    expect(res.status).not.toBe(200)
  })

  it("/services/:id/logs — plain GET without cookie returns non-200", async () => {
    const res = await wsRouter.fetch(
      new Request("http://localhost/services/svc-1/logs"),
      wsEnv
    )
    expect(res.status).not.toBe(200)
  })
})

// ---------------------------------------------------------------------------
// wsHandler exported for Bun.serve
// ---------------------------------------------------------------------------

describe("wsHandler", () => {
  it("wsHandler is exported and is an object (BunWebSocket handler)", async () => {
    const { wsHandler } = await import("./ws")
    expect(typeof wsHandler).toBe("object")
    expect(wsHandler).not.toBeNull()
  })
})
