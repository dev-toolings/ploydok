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
    expose: [80]
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
    expose: [80]
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

describe("faithful Swarm Compose contract", () => {
  const plan = (body: string) => planComposeSwarmDeploy({
    compose: `services:\n  app:\n    image: alpine\n${body}`,
    kindToken: "contract", network: "project-only", labels: {},
  });
  it("preserves user and quoted argument boundaries through the agent spec", async () => {
    const { plannedServiceToSpec } = await import("./compose-swarm");
    const service = plan('    user: "1001:1002"\n    command: sh -c "echo hello"\n    expose: [8080]\n').services[0]!;
    expect(plannedServiceToSpec(service).user).toBe("1001:1002");
    expect(plannedServiceToSpec(service).command).toEqual(["sh", "-c", "echo hello"]);
    expect(service.runtimePort).toBe(8080);
  });
  it("rejects IP publications and discarded runtime fields before creating anything", () => {
    for (const body of [
      '    ports: ["127.0.0.1:8080:80"]',
      '    ports: [{host_ip: "127.0.0.1", published: 8080, target: 80}]',
      '    ports: ["8080:80"]',
      '    depends_on: {db: {condition: service_healthy}}',
      '    restart: always', '    mem_limit: 512m', '    entrypoint: sh',
      '    healthcheck: {test: ["CMD", "true"], disable: true}',
      '    volumes: [{source: data, target: /data, volume: {nocopy: true}}]',
      '    command: ""',
    ]) expect(() => plan(body)).toThrow(/not supported|cannot preserve|unsupported|cannot be preserved/);
  });
  it("preserves empty quoted arguments, escapes and rejects unfinished quoting", () => {
    expect(plan(`    command: >-\n      echo "" 'two words' escaped\\ space\n`).services[0]!.command)
      .toEqual(["echo", "", "two words", "escaped space"]);
    expect(() => plan('    command: >-\n      echo "unfinished\n')).toThrow(/unterminated quote/);
  });
});
