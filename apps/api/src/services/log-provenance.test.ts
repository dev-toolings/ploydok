// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import type { Agent } from "../agent"
import { appLogSource, logContainers } from "./log-provenance"

describe("log provenance", () => {
  it("uses observed names and preserves service endpoint indices", async () => {
    const agent = {
      listContainers: async () => ({
        containers: [
          { id: "id-b", name: "worker" },
          { id: "id-a", name: "web" },
          { id: "other", name: "unrelated" },
        ],
      }),
    } as unknown as Agent
    expect(await logContainers(agent, ["id-a", "missing", "worker"])).toEqual([
      { id: "id-a", name: "web", index: 0 },
      { id: "id-b", name: "worker", index: 2 },
    ])
  })

  it("does not invent provenance when the agent inventory is unavailable", async () => {
    const agent = {
      listContainers: async () => {
        throw new Error("offline")
      },
    } as unknown as Agent
    expect(await logContainers(agent, ["id-a"])).toEqual([])
  })
})

describe("app log source selection", () => {
  const agent = {
    listContainers: async () => ({
      containers: [
        {
          id: "task-a",
          name: "app.web.1",
          appId: "app-1",
          kind: "app",
          status: "running",
          lastSeenMs: 1,
        },
        {
          id: "task-b",
          name: "app.web.2",
          appId: "app-1",
          kind: "app",
          status: "running",
          lastSeenMs: 2,
        },
        {
          id: "foreign",
          name: "other.web.1",
          appId: "app-2",
          kind: "app",
          status: "running",
          lastSeenMs: 3,
        },
      ],
    }),
  } as unknown as Agent

  it("exposes observed replicas and preserves the existing default container", async () => {
    expect(await appLogSource(agent, "app-1", "task-a")).toEqual({
      containers: [
        { id: "task-a", name: "app.web.1", index: 0 },
        { id: "task-b", name: "app.web.2", index: 1 },
      ],
      index: 0,
    })
  })

  it("selects an explicit replica and rejects a container from another app", async () => {
    expect(
      (await appLogSource(agent, "app-1", "task-a", "task-b"))?.index
    ).toBe(1)
    expect(await appLogSource(agent, "app-1", "task-a", "foreign")).toBeNull()
  })

  it("resolves observed Swarm replicas when there is no stored container reference", async () => {
    expect((await appLogSource(agent, "app-1", null))?.index).toBe(1)
  })
})
