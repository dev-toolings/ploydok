// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  isCaddyIngressContainer,
  networksToAttachForRunningApps,
  pickCaddyIngressContainer,
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
