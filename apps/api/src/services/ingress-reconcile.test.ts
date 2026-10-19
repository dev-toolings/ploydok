// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, mock } from "bun:test"

const events: string[] = []
const result = { synced: 0, failed: 0, bootstrapped: true }
mock.module("../caddy/reconciler.js", () => ({
  fetchRunningAppsForCaddy: async () => [],
  fetchRunningServicesForCaddy: async () => [],
  fetchPublicDatabaseProxiesForCaddy: async () => [],
  reconcileCaddyRoutes: async () => { events.push("app-routes"); return result },
  reconcileServiceRoutes: async () => { events.push("service-routes"); return result },
  reconcileDatabaseTcpProxies: async () => { events.push("database-routes"); return result },
}))
mock.module("../caddy/attachment.js", () => ({
  reconcileUnusedProjectOverlays: async () => ({ removed: 0, failed: 0 }),
  reconcileCaddyAttachments: async () => {
    events.push("attachment-start")
    await Promise.resolve()
    events.push("attachment-converged")
    return { attached: 1, skipped: 0, failed: 0 }
  },
}))
const { reconcileIngressOnce } = await import("./ingress-reconcile.js")

it("restores all routes after attachment rollout converges", async () => {
  const db = { select: () => ({ from: async () => [] }) }
  const caddy = { ensureRequestLogging: async () => {} }
  const report = await reconcileIngressOnce({ db, caddy, agent: {}, logger: {} } as any)
  expect(events).toEqual([
    "attachment-start", "attachment-converged", "app-routes", "service-routes", "database-routes",
  ])
  expect(report.ok).toBe(true)
})
