// SPDX-License-Identifier: AGPL-3.0-only
import { expect, mock, test } from "bun:test"
import type { Db } from "@ploydok/db"

const events: string[] = []
let attachFails = false
let existingService = false
let updateState = ""
const rpc = (event: string, response: object = {}) =>
  (_req: unknown, callback: (error: null, response: object) => void) => {
    events.push(event)
    callback(null, response)
    return {}
  }
const agent = {
  swarmEnsureSingleNode: rpc("swarm"),
  serviceCreate: rpc("create"),
  serviceRemove: rpc("remove"),
  serviceUpdateImage: rpc("update"),
  serviceRollback: rpc("rollback"),
  listServiceTasks(_req: unknown, callback: (error: null, response: object) => void) {
    return rpc("healthy", {
      updateState,
      updateMessage: "update rolled back due to healthcheck failure",
      tasks: [{ id: "task-1", status: "running", error: "", running: true, healthStatus: "healthy", matchesServiceSpec: true, desiredState: "running", slot: 1 }],
    })(_req, callback)
  },
  close() {},
}
mock.module("../agent/client.js", () => ({ createAgentClient: () => agent }))
mock.module("../debug/singletons.js", () => ({ getSharedAgent: () => agent }))
mock.module("../services/projects.js", () => ({
  ensureProjectSwarmNetwork: async () => {
    events.push("network")
    return "ploydok-swarm-proj-first"
  },
  ensureProjectDatabasesOnSwarmNetwork: async () => {},
}))
mock.module("../services/app-volumes.js", () => ({
  listRuntimeAppVolumeMounts: async () => [],
}))
mock.module("../caddy/attachment.js", () => ({
  ensureCaddyOnProjectNetwork: async () => {
    // A managed Caddy task cannot join an overlay absent from local libnetwork.
    if (!events.includes("healthy")) throw new Error("network not found")
    events.push("attach")
    if (attachFails) throw new Error("attachment failed")
  },
}))
mock.module("../caddy/client.js", () => ({ CaddyClient: class {} }))
mock.module("./log-bus.js", () => ({ logBus: { publish() {} } }))
mock.module("./logger.js", () => ({ workerLog: { info() {}, error() {} } }))
mock.module("./app-deploy-lock.js", () => ({
  currentDeployLease: () => undefined,
  currentDeployLeaseCondition: () => undefined,
  DeployLeaseLostError: class extends Error {},
  fenceDeploySideEffect: async () => {},
  runOwnedDeployReconciliation: async (action: () => Promise<void>) => action(),
}))

const { runSwarmDeploy } = await import("./swarm-runner")
const db = {
  select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({
    limit: async () => [{
      id: "app-1", slug: "first", project_id: "first", owner_id: "owner-1",
      domain: null, replicas: 1, runtime_port: 8080, plan: "custom",
      swarm_service_name: existingService ? "ploydok-app-first" : null,
    }],
  }) }) }) }),
  update: () => ({ set: () => ({ where: () => ({
    returning: async () => {
      events.push("commit")
      return [{ id: "app-1" }]
    },
  }) }) }),
} as unknown as Db

test("first Swarm deploy materializes its overlay before attaching ingress", async () => {
  events.length = 0
  attachFails = false
  await runSwarmDeploy({ appId: "app-1", imageRef: "app:sha", env: {}, db })
  expect(events).toEqual(["swarm", "network", "create", "healthy", "attach", "commit"])
})

test("an ingress attachment failure still removes the newly created service", async () => {
  events.length = 0
  attachFails = true
  await expect(
    runSwarmDeploy({ appId: "app-1", imageRef: "app:sha", env: {}, db })
  ).rejects.toThrow("attachment failed")
  expect(events).toEqual(["swarm", "network", "create", "healthy", "attach", "remove"])
})

test("a Swarm automatic rollback fails deploy without toggling the service back to the failed spec", async () => {
  events.length = 0
  attachFails = false
  existingService = true
  updateState = "rollback_completed"
  try {
    await expect(
      runSwarmDeploy({ appId: "app-1", imageRef: "app:bad", env: {}, db })
    ).rejects.toThrow("update rollback_completed: update rolled back due to healthcheck failure")
    expect(events).toEqual(["swarm", "network", "update", "healthy"])
  } finally {
    existingService = false
    updateState = ""
  }
})
