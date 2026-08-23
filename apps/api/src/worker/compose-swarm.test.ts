// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import {
  deployPlannedComposeStack,
  planComposeSwarmDeploy,
  swarmComposeServiceName,
} from "./compose-swarm"

describe("swarmComposeServiceName", () => {
  it("matches the agent allowlist", () => {
    const name = swarmComposeServiceName("web-abc12xyz", "nginx")
    expect(name).toMatch(/^ploydok-app-[a-z0-9][a-z0-9-]{0,90}$/)
    expect(name).toContain("nginx")
  })
})

describe("planComposeSwarmDeploy", () => {
  it("plans Swarm services on the project overlay, not ploydok-public", () => {
    const plan = planComposeSwarmDeploy({
      compose: `
services:
  web:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
  db:
    image: postgres:16
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data:
`,
      kindToken: "demo-abc123",
      network: "ploydok-swarm-proj-proj1",
      labels: {
        "ploydok.app_id": "app-1",
        "ploydok.owner_id": "user-1",
      },
    })

    expect(plan.services.map((s) => s.image).sort()).toEqual([
      "nginx:1.25-alpine",
      "postgres:16",
    ])
    for (const service of plan.services) {
      expect(service.networks).toEqual(["ploydok-swarm-proj-proj1"])
      expect(service.labels["ploydok.app_id"]).toBe("app-1")
      expect(service.labels["ploydok.owner_id"]).toBe("user-1")
      expect(service.name).toMatch(/^ploydok-app-/)
    }
    expect(plan.entrypoint).toEqual({
      name: swarmComposeServiceName("demo-abc123", "web"),
      port: 80,
    })
  })

  it("refuses replicas > 1 with writable volumes", () => {
    expect(() =>
      planComposeSwarmDeploy({
        compose: `
services:
  db:
    image: postgres:16
    volumes:
      - data:/var/lib/postgresql/data
volumes:
  data:
`,
        kindToken: "demo-abc123",
        network: "ploydok-swarm-proj-proj1",
        labels: {
          "ploydok.app_id": "app-1",
          "ploydok.owner_id": "user-1",
        },
        replicas: 2,
      })
    ).toThrow(/writable local volumes/)
  })
})

describe("deployPlannedComposeStack", () => {
  it("creates every service and rolls back on failure", async () => {
    const created: string[] = []
    const removed: string[] = []
    const agent = {
      swarmEnsureSingleNode: mock(async () => ({})),
      serviceCreate: mock(async (req: { spec: Record<string, unknown> }) => {
        created.push(String(req.spec["name"] ?? "svc"))
        if (created.length > 1) {
          throw new Error("create failed")
        }
        return { serviceId: "1" }
      }),
      serviceRemove: mock(async (req: { serviceName: string }) => {
        removed.push(req.serviceName)
      }),
    }

    const plan = planComposeSwarmDeploy({
      compose: `
services:
  web:
    image: nginx:1.25-alpine
    ports:
      - "80:80"
  db:
    image: postgres:16
`,
      kindToken: "demo-abc123",
      network: "ploydok-swarm-proj-proj1",
      labels: {
        "ploydok.app_id": "app-1",
        "ploydok.owner_id": "user-1",
      },
    })

    await expect(deployPlannedComposeStack(agent, plan)).rejects.toThrow(
      /create failed/
    )
    expect(created.length).toBe(2)
    expect(removed).toEqual([created[0]!])
  })
})
