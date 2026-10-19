// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "bun:test"
import {
  ensureCaddyOnProjectNetwork,
  CaddyAttachmentError,
  isCaddyIngressContainer,
  networksToAttachForRunningApps,
  pickCaddyIngressContainer,
  resetCaddyIdCache,
} from "./attachment"

describe("isCaddyIngressContainer", () => {
  it("matches compose names used in local infra", () => {
    expect(
      isCaddyIngressContainer({ id: "1", name: "ploydok-caddy-1", kind: "infra" })
    ).toBe(true)
    expect(
      isCaddyIngressContainer({ id: "2", name: "/ploydok-caddy", kind: "infra" })
    ).toBe(true)
  })

  it("matches Swarm task names and rejects the admin proxy", () => {
    expect(
      isCaddyIngressContainer({
        id: "3",
        name: "ploydok_caddy.1.abc123",
        kind: "infra",
      })
    ).toBe(true)
    expect(
      isCaddyIngressContainer({
        id: "4",
        name: "ploydok_caddy-admin.1.abc123",
        kind: "infra",
      })
    ).toBe(false)
  })
})

describe("pickCaddyIngressContainer", () => {
  it("prefers a running Swarm task over a stopped compose leftover", () => {
    const picked = pickCaddyIngressContainer([
      { id: "old", name: "ploydok-caddy-1", status: "stopped", kind: "infra" },
      {
        id: "live",
        name: "ploydok_caddy.1.task",
        status: "running",
        kind: "infra",
      },
    ])
    expect(picked?.id).toBe("live")
  })
})

describe("ensureCaddyOnProjectNetwork cache", () => {
  afterEach(() => resetCaddyIdCache())

  it.each([
    { state: "address_collision", network: "overlay", address: "10.0.8.2", conflicting_endpoint: "vip:app" },
    { state: "attachment_pending", network: "overlay" },
  ])("preserves the agent's typed $state failure", async (attachment) => {
    const agent = {
      listContainers: async () => ({ containers: [{ id: "caddy", name: "ploydok_caddy.1.task", status: "running" }] }),
      networkConnect: async () => {
        throw { code: 9, details: JSON.stringify(attachment) }
      },
    }
    try {
      await ensureCaddyOnProjectNetwork(agent as any, "overlay")
      throw new Error("expected attachment to fail")
    } catch (err) {
      expect(err).toBeInstanceOf(CaddyAttachmentError)
      expect((err as CaddyAttachmentError).attachment).toEqual(attachment)
    }
  })

  it("reuses a cached running container after validating its runtime state", async () => {
    let listCalls = 0
    let inspectCalls = 0
    const attached: string[] = []
    const agent = {
      listContainers: async () => {
        listCalls++
        return {
          containers: [{ id: "cached", name: "ploydok-caddy", status: "running" }],
        }
      },
      inspectContainerHealth: async ({ containerId }: { containerId: string }) => {
        inspectCalls++
        expect(containerId).toBe("cached")
        return { containerMissing: false, running: true }
      },
      networkConnect: async ({ containerId }: { containerId: string }) => {
        attached.push(containerId)
      },
    }

    await ensureCaddyOnProjectNetwork(agent as any, "network-a")
    await ensureCaddyOnProjectNetwork(agent as any, "network-b")

    expect(listCalls).toBe(1)
    expect(inspectCalls).toBe(1)
    expect(attached).toEqual(["cached", "cached"])
  })

  it.each([
    ["stopped", { containerMissing: false, running: false }],
    ["missing", { containerMissing: true, running: false }],
  ] as const)("refreshes a %s cached container before attaching", async (_case, state) => {
    let listCalls = 0
    const attached: string[] = []
    const agent = {
      listContainers: async () => {
        listCalls++
        return {
          containers:
            listCalls === 1
              ? [{ id: "old", name: "ploydok-caddy", status: "running" }]
              : [
                  { id: "old", name: "ploydok-caddy", status: "stopped" },
                  { id: "fresh", name: "ploydok_caddy.1.task", status: "running" },
                ],
        }
      },
      inspectContainerHealth: async ({ containerId }: { containerId: string }) => {
        expect(containerId).toBe("old")
        return state
      },
      networkConnect: async ({ containerId }: { containerId: string }) => {
        attached.push(containerId)
      },
    }

    await ensureCaddyOnProjectNetwork(agent as any, "network-a")
    await ensureCaddyOnProjectNetwork(agent as any, "network-b")

    expect(listCalls).toBe(2)
    expect(attached).toEqual(["old", "fresh"])
  })

  it("propagates a cached-container inspection error", async () => {
    const transientError = new Error("agent unavailable")
    let attached = 0
    const agent = {
      listContainers: async () => ({
        containers: [{ id: "cached", name: "ploydok-caddy", status: "running" }],
      }),
      inspectContainerHealth: async () => {
        throw transientError
      },
      networkConnect: async () => {
        attached++
      },
    }

    await ensureCaddyOnProjectNetwork(agent as any, "network-a")
    await expect(
      ensureCaddyOnProjectNetwork(agent as any, "network-b")
    ).rejects.toBe(transientError)
    expect(attached).toBe(1)
  })
})

describe("networksToAttachForRunningApps", () => {
  it("attaches Caddy to the Swarm overlay, not the leftover bridge", () => {
    expect(
      networksToAttachForRunningApps([
        {
          runtime_mode: "swarm",
          status: "running",
          project_id: "proj-1",
          network_name: "ploydok-proj-proj-1",
          swarm_network_name: "ploydok-swarm-proj-proj-1",
        },
      ])
    ).toEqual(["ploydok-swarm-proj-proj-1"])
  })

  it("derives the overlay name when the column is still empty", () => {
    expect(
      networksToAttachForRunningApps([
        {
          runtime_mode: "swarm",
          status: "running",
          project_id: "AbC",
          network_name: "ploydok-proj-abc",
          swarm_network_name: null,
        },
      ])
    ).toEqual(["ploydok-swarm-proj-abc"])
  })

  it("keeps the bridge for leftover docker apps", () => {
    expect(
      networksToAttachForRunningApps([
        {
          runtime_mode: "docker",
          status: "running",
          project_id: "proj-1",
          network_name: "ploydok-proj-proj-1",
          swarm_network_name: null,
        },
      ])
    ).toEqual(["ploydok-proj-proj-1"])
  })
})

it("reconciles ingress for public marketplace services in service-only projects", async () => {
  const { reconcileCaddyAttachments, resetCaddyIdCache } = await import("./attachment");
  resetCaddyIdCache();
  let query = 0;
  const db = { select: () => ({ from: () => ({ innerJoin: () => ({
    where: async () => ++query === 1 ? [] : [
      { project_id: "public", swarm_network_name: "ploydok-swarm-proj-public" },
    ],
  }) }) }) };
  const attached: string[] = [];
  const agent = {
    listContainers: async () => ({ containers: [{ id: "caddy", name: "ploydok-caddy", status: "running" }] }),
    networkConnect: async ({ networkId }: { networkId: string }) => { attached.push(networkId); },
  };
  const result = await reconcileCaddyAttachments(agent as any, db as any);
  expect(attached).toEqual(["ploydok-swarm-proj-public"]);
  expect(result).toEqual({ attached: 1, skipped: 0, failed: 0 });
  resetCaddyIdCache();
});

it.each([
  ["unhealthy", "healthy", "healthy"],
  ["unhealthy", "starting", "starting"],
  ["Up 10s (unhealthy)", "Up 10s (healthy)", "Up 10s (healthy)"],
])(
  "selects the highest-ranked Caddy health status: %s before %s selects %s",
  (firstStatus, secondStatus, expectedStatus) => {
    const picked = pickCaddyIngressContainer([
      {
        id: "first",
        name: "ploydok-caddy-1",
        status: firstStatus,
        kind: "infra",
      },
      {
        id: "second",
        name: "ploydok_caddy.1.task",
        status: secondStatus,
        kind: "infra",
      },
    ])

    expect(picked?.status).toBe(expectedStatus)
  }
)
