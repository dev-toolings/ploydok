// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test"
import type { Db } from "@ploydok/db"
import { checkIngress } from "./health"

const db = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as unknown as Db

test("ingress is degraded with typed network evidence even when all routes exist", async () => {
  const issue = {
    state: "address_collision", network: "ploydok-swarm-proj-org",
    address: "10.0.8.2", conflictingEndpoint: "vip:app-service",
  }
  const report = await checkIngress(db,
    async () => ({ containerId: "caddy", issues: [issue] }), async () => ({}))
  expect(report.status).toBe("degraded")
  expect(report.network_issues).toEqual([issue])
  expect(report.missing_http_routes).toEqual([])
})

test("ingress cannot be green when allocation inspection is unavailable", async () => {
  const report = await checkIngress(db,
    async () => { throw new Error("allocation inspection failed") }, async () => ({}))
  expect(report.status).toBe("down")
  expect(report.error).toBe("allocation inspection failed")
})

test("ingress is green with routes present and no address collision", async () => {
  const report = await checkIngress(db,
    async () => ({ containerId: "caddy", issues: [] }), async () => ({}))
  expect(report.status).toBe("ok")
  expect(report.network_issues).toEqual([])
})
