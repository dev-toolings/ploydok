// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import {
  deployPlannedComposeStack,
  planComposeSwarmDeploy,
  swarmComposeServiceName,
  waitForDockerContainerCondition,
  waitForSwarmServiceCondition,
  type PlannedSwarmService,
} from "./compose-swarm"

type PlannedServiceDependencies = Pick<
  PlannedSwarmService,
  "composeName"
> & {
  dependsOn?: string[]
  dependsOnConditions?: Record<
    string,
    "service_started" | "service_healthy" | "service_completed_successfully"
  >
}

function dependenciesOf(service: PlannedSwarmService): PlannedServiceDependencies {
  return service as PlannedServiceDependencies
}

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
      '    depends_on: {db: {condition: service_ready}}',
      '    restart: "no"', '    restart: on-failure', '    mem_limit: 512m', '    entrypoint: sh',
      '    healthcheck: {test: ["CMD", "true"], disable: true}',
      '    volumes: [{source: data, target: /data, volume: {nocopy: true}}]',
      '    command: ""',
    ]) expect(() => plan(body)).toThrow(/not supported|cannot preserve|unsupported|cannot be preserved/);
  });
  it("accepts a healthy dependency when the dependency declares a healthcheck", () => {
    const stack = planComposeSwarmDeploy({
      compose: `services:
  app:
    image: alpine
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD", "pg_isready"]
`,
      kindToken: "contract", network: "project-only", labels: {},
    });
    expect(stack.services.map((service) => service.composeName)).toEqual(["db", "app"]);
    expect(dependenciesOf(stack.services[1]!).dependsOn).toEqual(["db"]);
    expect(dependenciesOf(stack.services[1]!).dependsOnConditions).toEqual({ db: "service_healthy" });
  });

  it("keeps a completed dependency one-shot in the Swarm service spec", async () => {
    const stack = planComposeSwarmDeploy({
      compose: `services:
  app:
    image: alpine
    depends_on:
      migrate:
        condition: service_completed_successfully
  migrate:
    image: migrate:latest
    restart: "no"
`,
      kindToken: "completed-order", network: "project-only", labels: {},
    });
    const migration = stack.services.find((service) => service.composeName === "migrate")!;
    const { plannedServiceToSpec } = await import("./compose-swarm");
    expect(plannedServiceToSpec(migration).restartCondition).toBe("none");
  });

  it("does not create a dependent service until its dependency is healthy", async () => {
    const stack = planComposeSwarmDeploy({
      compose: `services:
  app:
    image: alpine
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD", "pg_isready"]
`,
      kindToken: "healthy-order", network: "project-only", labels: {},
    });
    const app = stack.services.find((service) => service.composeName === "app")!;
    expect(dependenciesOf(app).dependsOnConditions).toEqual({ db: "service_healthy" });

    const events: string[] = [];
    const polls = new Map<string, number>();
    const agent = {
      swarmEnsureSingleNode: async () => ({}),
      serviceCreate: async ({ spec }: { spec: Record<string, unknown> }) => {
        events.push(`create:${String(spec.name)}`);
        return { serviceId: String(spec.name) };
      },
      serviceRemove: async () => ({}),
      listServiceTasks: async ({ serviceName }: { serviceName: string }) => {
        const poll = (polls.get(serviceName) ?? 0) + 1;
        polls.set(serviceName, poll);
        events.push(`health:${serviceName}:${poll}`);
        return {
          tasks: [{
            status: poll === 1 ? "starting" : "Up 1s (healthy)",
            running: true,
            healthStatus: poll === 1 ? "starting" : "healthy",
          }],
        };
      },
    };

    await deployPlannedComposeStack(agent, stack);
    const dbName = swarmComposeServiceName("healthy-order", "db");
    const appName = swarmComposeServiceName("healthy-order", "app");
    expect(events.indexOf(`create:${dbName}`)).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(`health:${dbName}:2`)).toBeGreaterThan(
      events.indexOf(`create:${dbName}`)
    );
    expect(events.indexOf(`create:${appName}`)).toBeGreaterThan(
      events.indexOf(`health:${dbName}:2`)
    );
  });

  it("times out a dependency and compensates the services already created", async () => {
    const stack = planComposeSwarmDeploy({
      compose: `services:
  app:
    image: alpine
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD", "pg_isready"]
`,
      kindToken: "healthy-timeout", network: "project-only", labels: {},
    });
    const created: string[] = [];
    const removed: string[] = [];
    const originalNow = Date.now;
    let logicalNow = originalNow();
    Date.now = () => {
      logicalNow += 10 * 60 * 1000;
      return logicalNow;
    };
    try {
      const agent = {
        swarmEnsureSingleNode: async () => ({}),
        serviceCreate: async ({ spec }: { spec: Record<string, unknown> }) => {
          const name = String(spec.name);
          created.push(name);
          return { serviceId: name };
        },
        serviceRemove: async ({ serviceName }: { serviceName: string }) => {
          removed.push(serviceName);
        },
        listServiceTasks: async () => ({
          tasks: [{ status: "starting", running: true, healthStatus: "starting" }],
        }),
      };

      await expect(deployPlannedComposeStack(agent, stack)).rejects.toThrow(
        /healthy|timeout|did not reach/i
      );
    } finally {
      Date.now = originalNow;
    }

    const dbName = swarmComposeServiceName("healthy-timeout", "db");
    const appName = swarmComposeServiceName("healthy-timeout", "app");
    expect(created).toEqual([dbName]);
    expect(removed).toEqual([dbName]);
    expect(created).not.toContain(appName);
  });

  it("waits for service_completed_successfully until a Swarm task exits with code 0", async () => {
    let polls = 0;
    await waitForSwarmServiceCondition(
      {
        listServiceTasks: async () => {
          polls += 1;
            return {
              tasks: [{
                status: polls === 1 ? "running" : "Exited (0) 1s ago",
                running: polls === 1,
                ...(polls === 1 ? {} : { exitCode: 0 }),
                state: polls === 1 ? "running" : "exited",
              }],
            };
        },
      },
      {
        serviceName: "migrate",
        condition: "service_completed_successfully",
        timeoutMs: 50,
        pollMs: 0,
      }
    );
    expect(polls).toBe(2);
  });

  it("does not treat a failed Swarm task as service_completed_successfully", async () => {
    await expect(
      waitForSwarmServiceCondition(
        {
          listServiceTasks: async () => ({
            tasks: [{ status: "Exited (10) 1s ago", running: false, exitCode: 10, state: "exited" }],
          }),
        },
        {
          serviceName: "migrate",
          condition: "service_completed_successfully",
          timeoutMs: 1,
          pollMs: 0,
        }
      )
    ).rejects.toMatchObject({ timedOut: true });
  });

  it("ignores a historical successful task when the current task is still running", async () => {
    await expect(
      waitForSwarmServiceCondition(
        {
          listServiceTasks: async () => ({
            tasks: [
              { status: "Exited (0) 1m ago", running: false, exitCode: 0, state: "exited" },
              { status: "Running 1s", running: true, state: "running" },
            ],
          }),
        },
        {
          serviceName: "migrate",
          condition: "service_completed_successfully",
          timeoutMs: 1,
          pollMs: 0,
        }
      )
    ).rejects.toMatchObject({ timedOut: true });
  });

  it("waits for every dependency replica before creating the dependent service", async () => {
    const stack = planComposeSwarmDeploy({
      compose: `services:
  app:
    image: alpine
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD", "pg_isready"]
`,
      kindToken: "replica-order", network: "project-only", labels: {}, replicas: 2,
    });
    const created: string[] = [];
    const originalNow = Date.now;
    let logicalNow = originalNow();
    Date.now = () => {
      logicalNow += 10 * 60 * 1000;
      return logicalNow;
    };
    try {
      const agent = {
        swarmEnsureSingleNode: async () => ({}),
        serviceCreate: async ({ spec }: { spec: Record<string, unknown> }) => {
          created.push(String(spec.name));
          return { serviceId: String(spec.name) };
        },
        serviceRemove: async () => ({}),
        listServiceTasks: async () => ({
          tasks: [
            { status: "Up 1s (healthy)", running: true, healthStatus: "healthy", state: "running" },
            { status: "starting", running: true, healthStatus: "starting", state: "running" },
          ],
        }),
      };

      await expect(deployPlannedComposeStack(agent, stack)).rejects.toMatchObject({
        timedOut: true,
      });
    } finally {
      Date.now = originalNow;
    }

    expect(created).toEqual([
      swarmComposeServiceName("replica-order", "db"),
    ]);
  });

  it("waits for a Docker one-shot dependency to exit with code 0", async () => {
    let polls = 0;
    await waitForDockerContainerCondition(
      {
        inspectContainerHealth: async () => {
          polls += 1;
          return {
            status: 1,
            running: polls === 1,
            ...(polls === 1 ? {} : { exitCode: 0 }),
            state: polls === 1 ? "running" : "exited",
            containerMissing: false,
          };
        },
      },
      {
        containerId: "migration",
        dependency: "migrate",
        condition: "service_completed_successfully",
        timeoutMs: 50,
        pollMs: 0,
      }
    );
    expect(polls).toBe(2);
  });
  it("keeps fields whose meaning Swarm preserves: internal ports, restart always, creation order", () => {
    for (const body of [
      '    ports: ["8080:80"]',
      '    restart: always',
      '    restart: unless-stopped',
      '    depends_on: [db]\n  db:\n    image: postgres:16',
      '    depends_on: {db: {condition: service_started}}\n  db:\n    image: postgres:16',
    ]) expect(() => plan(body)).not.toThrow();
  });
  it("preserves empty quoted arguments, escapes and rejects unfinished quoting", () => {
    expect(plan(`    command: >-\n      echo "" 'two words' escaped\\ space\n`).services[0]!.command)
      .toEqual(["echo", "", "two words", "escaped space"]);
    expect(() => plan('    command: >-\n      echo "unfinished\n')).toThrow(/unterminated quote/);
  });
});
