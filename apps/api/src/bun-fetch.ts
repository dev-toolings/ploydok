// SPDX-License-Identifier: AGPL-3.0-only
import type { Server } from "bun"
import type { BunWebSocketData } from "hono/bun"

export type ApiBindings = {
  server: Server<BunWebSocketData>
  remoteAddress: string | undefined
}

/** Keep Hono's WebSocket adapter and trusted socket IP on the same bindings. */
export function createApiFetch(app: {
  fetch(request: Request, env: ApiBindings): Response | Promise<Response>
}) {
  return (request: Request, server: Server<BunWebSocketData>) =>
    app.fetch(request, {
      server,
      remoteAddress: server.requestIP(request)?.address,
    })
}
