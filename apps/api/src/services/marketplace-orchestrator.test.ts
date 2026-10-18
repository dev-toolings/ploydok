// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock, beforeAll } from "bun:test"

// ---------------------------------------------------------------------------
// Module-level mocks — must be declared before any import that triggers them
// ---------------------------------------------------------------------------

const mockInsertService = mock(
  async (_db: unknown, values: Record<string, unknown>) => ({
    id: values["id"],
    project_id: values["project_id"],
    name: values["name"],
    slug: values["slug"],
    template_id: values["template_id"],
    template_version: values["template_version"],
    status: "pending",
    runtime_mode: values["runtime_mode"],
    compose_raw: values["compose_raw"],
    generated_env: values["generated_env"],
    domain: values["domain"],
    entrypoint_service_name: values["entrypoint_service_name"],
    entrypoint_port: values["entrypoint_port"],
    container_ids: [],
    created_at: new Date(),
    updated_at: new Date(),
  })
)

const mockUpdateServiceStatus = mock(async () => {})
const mockUpdateServiceContainers = mock(async () => {})
const mockUpdateServiceSwarmNames = mock(async () => {})
const mockMarkServiceDeleting = mock(async () => {})
const mockUniqueServiceSlug = mock(async () => "my-pb")
const mockGetServiceForUser = mock(async () => null as unknown)
const mockHasRole = mock(async () => true)
const mockGetServiceById = mock(async () => null as unknown)
const mockClaimCreationSaga = mock(async () => null as unknown)

mock.module("@ploydok/db/queries", () => ({
  insertService: mockInsertService,
  createCreationSaga: mock(async () => {}),
  claimCreationSaga: mockClaimCreationSaga,
  fenceCreationSaga: mock(async () => true),
  recordClaimedCreationSagaStep: mock(async () => true),
  completeClaimedCreationSaga: mock(async () => true),
  beginClaimedCreationSagaCompensation: mock(async () => true),
  completeClaimedCreationSagaCompensation: mock(async () => true),
  retryClaimedCreationSaga: mock(async () => true),
  getServiceById: mockGetServiceById,
  updateServiceStatus: mockUpdateServiceStatus,
  updateServiceContainers: mockUpdateServiceContainers,
  updateServiceSwarmNames: mockUpdateServiceSwarmNames,
  markServiceDeleting: mockMarkServiceDeleting,
  uniqueServiceSlug: mockUniqueServiceSlug,
  getServiceForUser: mockGetServiceForUser,
  hasRole: mockHasRole,
  // re-export everything else as no-ops to satisfy wide imports
  listServicesForProject: mock(async () => []),
}))

mock.module("@ploydok/db", () => ({
  services: {},
  projects: {},
  createDb: mock(() => ({})),
}))

mock.module("./projects.js", () => ({
  ensureProjectNetwork: mock(async () => "ploydok-proj-proj-1"),
  ensureProjectSwarmNetwork: mock(async () => "ploydok-swarm-proj-proj-1"),
}))

const mockEnsureCaddyOnProjectNetwork = mock(async () => {})
mock.module("../caddy/attachment.js", () => ({
  ensureCaddyOnProjectNetwork: mockEnsureCaddyOnProjectNetwork,
}))

mock.module("../debug/singletons.js", () => ({
  getSharedCaddy: mock(() => ({
    upsertRoute: mock(async () => {}),
    removeRoute: mock(async () => {}),
  })),
  getSharedAgent: mock(() => ({})),
}))

mock.module("../logger", () => ({
  childLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
}))

// ---------------------------------------------------------------------------
// The worker owns Docker effects after the durable acceptance.
mock.module("../worker/queues", () => ({ serviceInstallQueue: { name: "service.install" } }))
mock.module("../worker/queue-enqueue", () => ({
  enqueueWithDbRow: async (opts: { db: unknown; insertRow: (tx: unknown) => Promise<unknown> }) => ({ row: await opts.insertRow(opts.db) }),
}))

// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  planServiceStack,
  installFromTemplate,
  resumeServiceCreation,
  startService,
  stopService,
  deleteService,
} from "./marketplace-orchestrator"
import type { OrchestratorDeps } from "./marketplace-orchestrator"
import { env } from "../env"
import { deriveDefaultAppDomainBase } from "../domains/app-domain"

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

function makeAgent(
  overrides: Partial<OrchestratorDeps["agent"]> = {}
): OrchestratorDeps["agent"] {
  return {
    imagePull: mock(async function* () {}),
    containerCreate: mock(async () => ({ containerId: "ctr-1" })),
    containerStart: mock(async () => ({})),
    containerStop: mock(async () => ({})),
    containerRemove: mock(async () => ({})),
    listContainers: mock(async () => ({ containers: [] })),
    ...overrides,
  }
}

type CaddyDeps = NonNullable<OrchestratorDeps["caddy"]>

function makeSwarm() {
  return {
    swarmEnsureSingleNode: mock(async () => ({})),
    serviceCreate: mock(
      async (req: { spec: Record<string, unknown> }) => ({
        serviceId: String(req.spec["name"] ?? "svc"),
      })
    ),
    serviceRemove: mock(async () => ({})),
  }
}

function makeCaddy(overrides: Partial<CaddyDeps> = {}): CaddyDeps {
  return {
    upsertRoute: mock(async () => {}),
    removeRoute: mock(async () => {}),
    ...overrides,
  }
}

// Minimal db stub — queries are mocked at module level
function makeDb(): OrchestratorDeps["db"] {
  return {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          limit: mock(async () => []),
        })),
      })),
    })),
    insert: mock(() => ({ values: mock(async () => {}) })),
    update: mock(() => ({
      set: mock(() => ({ where: mock(async () => {}) })),
    })),
    delete: mock(() => ({ where: mock(async () => {}) })),
    transaction: mock(async (callback: (tx: unknown) => unknown) => callback(undefined)),
  } as unknown as OrchestratorDeps["db"]
}

// ---------------------------------------------------------------------------
// installFromTemplate
// ---------------------------------------------------------------------------

describe("installFromTemplate", () => {
  it("throws NOT_FOUND when project does not exist", async () => {
    const db = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(async () => []),
          })),
        })),
      })),
    } as unknown as OrchestratorDeps["db"]

    await expect(
      installFromTemplate(
        { agent: makeAgent(), swarm: makeSwarm(), db, caddy: makeCaddy() },
        "user-1",
        {
          projectId: "proj-missing",
          templateId: "pocketbase",
          templateVersion: "0.22.0",
          name: "My PB",
          compose: "services:\n  app:\n    image: pocketbase:latest\n",
        }
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("throws FORBIDDEN when project belongs to another user", async () => {
    mockHasRole.mockResolvedValueOnce(false)
    const db = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(async () => [{ id: "proj-1", owner_id: "other-user" }]),
          })),
        })),
      })),
    } as unknown as OrchestratorDeps["db"]

    await expect(
      installFromTemplate(
        { agent: makeAgent(), swarm: makeSwarm(), db, caddy: makeCaddy() },
        "user-1",
        {
          projectId: "proj-1",
          templateId: "pocketbase",
          templateVersion: "0.22.0",
          name: "My PB",
          compose: "services:\n  app:\n    image: pocketbase:latest\n",
        }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("returns a pending row immediately", async () => {
    const db = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(async () => [{ id: "proj-1", owner_id: "user-1" }]),
          })),
        })),
      })),
    } as unknown as OrchestratorDeps["db"]

    const row = await installFromTemplate(
      { agent: makeAgent(), swarm: makeSwarm(), db, caddy: makeCaddy() },
      "user-1",
      {
        projectId: "proj-1",
        templateId: "pocketbase",
        templateVersion: "0.22.0",
        name: "My PB",
        compose: "services:\n  app:\n    image: pocketbase:latest\n",
      }
    )

    expect(row.status).toBe("pending")
    expect(row.name).toBe("My PB")
    expect(row.template_id).toBe("pocketbase")
  })

  it("accepts a domain without mutating ingress before the worker runs", async () => {
    const db = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(async () => [{ id: "proj-1", owner_id: "user-1" }]),
          })),
        })),
      })),
    } as unknown as OrchestratorDeps["db"]

    const caddy = makeCaddy()

    await installFromTemplate({ agent: makeAgent(), swarm: makeSwarm(), db, caddy }, "user-1", {
      projectId: "proj-1",
      templateId: "pocketbase",
      templateVersion: "0.22.0",
      name: "My PB",
      // compose with ${domain} DSL + a port so the legacy route can resolve it
      compose:
        'services:\n  app:\n    image: pocketbase:latest\n    expose: [8080]\n    environment:\n      DOMAIN: ${domain}\n',
    })


    expect(caddy.upsertRoute).not.toHaveBeenCalled()
  })

  it("does NOT call caddy.upsertRoute when domain is null", async () => {
    const db = {
      select: mock(() => ({
        from: mock(() => ({
          where: mock(() => ({
            limit: mock(async () => [{ id: "proj-1", owner_id: "user-1" }]),
          })),
        })),
      })),
    } as unknown as OrchestratorDeps["db"]

    const caddy = makeCaddy()

    // compose without x-ploydok-domain → domain will be null
    await installFromTemplate({ agent: makeAgent(), swarm: makeSwarm(), db, caddy }, "user-1", {
      projectId: "proj-1",
      templateId: "pocketbase",
      templateVersion: "0.22.0",
      name: "My PB",
      compose: "services:\n  app:\n    image: pocketbase:latest\n",
    })


    expect(caddy.upsertRoute).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// startService
// ---------------------------------------------------------------------------

describe("startService", () => {
  it("throws NOT_FOUND when service not found", async () => {
    mockGetServiceForUser.mockResolvedValueOnce(null)
    await expect(
      startService(
        { agent: makeAgent(), swarm: makeSwarm(), db: makeDb(), caddy: makeCaddy() },
        "user-1",
        "svc-1"
      )
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("throws CONFLICT when service is already running", async () => {
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      status: "running",
      container_ids: ["ctr-1"],
    })
    await expect(
      startService(
        { agent: makeAgent(), swarm: makeSwarm(), db: makeDb(), caddy: makeCaddy() },
        "user-1",
        "svc-1"
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("starts containers and updates status when service is stopped", async () => {
    const agent = makeAgent()
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      status: "stopped",
      container_ids: ["ctr-a", "ctr-b"],
    })
    await startService(
      { agent, db: makeDb(), caddy: makeCaddy() },
      "user-1",
      "svc-1"
    )
    expect(agent.containerStart).toHaveBeenCalledTimes(2)
    expect(mockUpdateServiceStatus).toHaveBeenCalledWith(
      expect.anything(),
      "svc-1",
      "running"
    )
  })
})

// ---------------------------------------------------------------------------
// stopService
// ---------------------------------------------------------------------------

describe("stopService", () => {
  it("throws CONFLICT when service is not running", async () => {
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      status: "stopped",
      container_ids: [],
    })
    await expect(
      stopService(
        { agent: makeAgent(), swarm: makeSwarm(), db: makeDb(), caddy: makeCaddy() },
        "user-1",
        "svc-1"
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("stops containers in reverse order", async () => {
    const agent = makeAgent()
    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      status: "running",
      container_ids: ["ctr-a", "ctr-b"],
    })
    await stopService(
      { agent, db: makeDb(), caddy: makeCaddy() },
      "user-1",
      "svc-1"
    )
    expect(agent.containerStop).toHaveBeenCalledTimes(2)
    // second call should be ctr-a (reversed)
    const calls = (agent.containerStop as ReturnType<typeof mock>).mock.calls
    expect(calls[0]?.[0].containerId).toBe("ctr-b")
    expect(calls[1]?.[0].containerId).toBe("ctr-a")
    expect(mockUpdateServiceStatus).toHaveBeenCalledWith(
      expect.anything(),
      "svc-1",
      "stopped"
    )
  })
})

// ---------------------------------------------------------------------------
// deleteService
// ---------------------------------------------------------------------------

describe("deleteService", () => {
  it("throws NOT_FOUND when service not found", async () => {
    mockGetServiceForUser.mockResolvedValueOnce(null)
    await expect(
      deleteService(
        { agent: makeAgent(), swarm: makeSwarm(), db: makeDb(), caddy: makeCaddy() },
        "user-1",
        "svc-1"
      )
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("marks deleting, stops+removes each container, then calls db.delete", async () => {
    const agent = makeAgent()
    let deleteCalled = false
    const db = {
      ...makeDb(),
      delete: mock(() => ({
        where: mock(async () => {
          deleteCalled = true
        }),
      })),
    } as unknown as OrchestratorDeps["db"]

    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      name: "My PB",
      status: "stopped",
      container_ids: ["ctr-a", "ctr-b"],
    })

    await deleteService({ agent, db, caddy: makeCaddy() }, "user-1", "svc-1")

    expect(mockMarkServiceDeleting).toHaveBeenCalledWith(
      expect.anything(),
      "svc-1"
    )
    expect(agent.containerStop).toHaveBeenCalledTimes(2)
    expect(agent.containerRemove).toHaveBeenCalledTimes(2)
    expect(deleteCalled).toBe(true)
  })

  it("continues deletion even if containerStop throws", async () => {
    const agent = makeAgent({
      containerStop: mock(async () => {
        throw new Error("stop failed")
      }),
    })
    let deleteCalled = false
    const db = {
      ...makeDb(),
      delete: mock(() => ({
        where: mock(async () => {
          deleteCalled = true
        }),
      })),
    } as unknown as OrchestratorDeps["db"]

    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      name: "My PB",
      status: "running",
      container_ids: ["ctr-a"],
    })

    await deleteService({ agent, db, caddy: makeCaddy() }, "user-1", "svc-1")
    expect(agent.containerRemove).toHaveBeenCalledTimes(1)
    expect(deleteCalled).toBe(true)
  })

  it("calls caddy.removeRoute before db.delete", async () => {
    const agent = makeAgent()
    const callOrder: string[] = []
    const caddy = {
      upsertRoute: mock(async () => {}),
      removeRoute: mock(async () => {
        callOrder.push("removeRoute")
      }),
    }
    const db = {
      ...makeDb(),
      delete: mock(() => ({
        where: mock(async () => {
          callOrder.push("dbDelete")
        }),
      })),
    } as unknown as OrchestratorDeps["db"]

    mockGetServiceForUser.mockResolvedValueOnce({
      id: "svc-1",
      name: "My PB",
      status: "stopped",
      container_ids: [],
    })

    await deleteService({ agent, db, caddy }, "user-1", "svc-1")

    expect(caddy.removeRoute).toHaveBeenCalledWith("svc-1")
    expect(callOrder).toEqual(["removeRoute", "dbDelete"])
  })
})

describe("marketplace project isolation", () => {
  it("plans only its own project network, with a reachable ingress upstream", () => {
    const compose_raw = 'services:\n  web:\n    image: nginx:alpine\n    expose: [80]\n';
    const plans = ["one", "two"].map(id => planServiceStack(
      { id, slug: "demo", compose_raw }, `ploydok-swarm-proj-${id}`, "owner"
    ));
    for (const [index, plan] of plans.entries()) {
      expect(plan.services.every(s => s.networks.length === 1)).toBe(true);
      expect(plan.services[0]!.networks).toEqual([`ploydok-swarm-proj-${["one", "two"][index]}`]);
      expect(plan.entrypoint).toEqual({ name: plan.services[0]!.name, port: 80 });
    }
    expect(plans[0]!.services[0]!.networks).not.toEqual(plans[1]!.services[0]!.networks);
  });
});

describe("marketplace Docker dependency readiness", () => {
  const sagaClaim = {
    saga: {
      state: "provisioning",
      attempt_count: 1,
      max_attempts: 8,
      owned_resources: {},
      requested_by_user_id: "user-1",
    },
    token: "saga-token",
  };

  function serviceRow() {
    return {
      id: "svc-ready",
      project_id: "project-1",
      name: "Ready service",
      slug: "ready-service",
      status: "pending",
      runtime_mode: "docker",
      compose_raw: `services:
  app:
    image: app:latest
    depends_on:
      db:
        condition: service_healthy
  db:
    image: postgres:16
    healthcheck:
      test: ["CMD", "pg_isready"]
`,
      generated_env: {},
      secrets_encrypted: true,
      domain: null,
      entrypoint_service_name: null,
      entrypoint_port: null,
      container_ids: [],
      swarm_service_names: [],
    };
  }

  function oneShotServiceRow() {
    return {
      ...serviceRow(),
      compose_raw: `services:
  app:
    image: app:latest
    depends_on:
      migrate:
        condition: service_completed_successfully
  migrate:
    image: migrate:latest
`,
    };
  }

  it("does not create the dependent Docker container before its dependency is healthy", async () => {
    mockClaimCreationSaga.mockResolvedValueOnce(sagaClaim as never);
    mockGetServiceById.mockResolvedValueOnce(serviceRow() as never);
    const events: string[] = [];
    const healthPolls = new Map<string, number>();
    const containers: Array<{ id: string; name: string; serviceId: string }> = [];
    const agent = makeAgent({
      imagePull: async function* () {},
      listContainers: mock(async () => ({ containers })),
      containerCreate: mock(async (req: Record<string, unknown>) => {
        const id = `ctr-${containers.length + 1}`;
        containers.push({
          id,
          name: String(req.name),
          serviceId: "svc-ready",
        });
        events.push(`create:${String(req.name)}`);
        return { containerId: id };
      }),
      containerStart: mock(async ({ containerId }: { containerId: string }) => {
        events.push(`start:${containerId}`);
        return {};
      }),
      inspectContainerHealth: mock(async ({ containerId }: { containerId: string }) => {
        const poll = (healthPolls.get(containerId) ?? 0) + 1;
        healthPolls.set(containerId, poll);
        events.push(`health:${containerId}:${poll}`);
        return {
          status: poll === 1 ? 2 : 3,
          running: true,
          containerMissing: false,
        };
      }),
    } as never);

    await resumeServiceCreation({ agent, db: makeDb(), caddy: makeCaddy() }, "svc-ready");

    const dbCreate = events.findIndex((event) => event.startsWith("create:") && event.includes("-db"));
    const appCreate = events.findIndex((event) => event.startsWith("create:") && event.includes("-app"));
    const dbHealthy = events.findIndex((event) => event.startsWith("health:") && event.endsWith(":2"));
    expect(dbCreate).toBeGreaterThanOrEqual(0);
    expect(dbHealthy).toBeGreaterThan(dbCreate);
    expect(appCreate).toBeGreaterThan(dbHealthy);
  });

  it("times out a Docker dependency and compensates the containers already created", async () => {
    mockClaimCreationSaga.mockResolvedValueOnce(sagaClaim as never);
    mockGetServiceById.mockResolvedValueOnce(serviceRow() as never);
    const removed: string[] = [];
    const created: string[] = [];
    const containers: Array<{ id: string; name: string; serviceId: string }> = [];
    const agent = makeAgent({
      imagePull: async function* () {},
      listContainers: mock(async () => ({ containers })),
      containerCreate: mock(async (req: Record<string, unknown>) => {
        const id = `ctr-${containers.length + 1}`;
        containers.push({ id, name: String(req.name), serviceId: "svc-ready" });
        created.push(String(req.name));
        return { containerId: id };
      }),
      containerStart: mock(async () => ({})),
      inspectContainerHealth: mock(async () => ({
        status: 2,
        running: true,
        containerMissing: false,
      })),
      containerRemove: mock(async ({ containerId }: { containerId: string }) => {
        removed.push(containerId);
        return {};
      }),
    } as never);
    const originalNow = Date.now;
    let logicalNow = originalNow();
    Date.now = () => {
      logicalNow += 10 * 60 * 1000;
      return logicalNow;
    };
    try {
      await expect(
        resumeServiceCreation({ agent, db: makeDb(), caddy: makeCaddy() }, "svc-ready")
      ).rejects.toThrow(/Timed out|healthy|dependency/i);
    } finally {
      Date.now = originalNow;
    }

    expect(created.some((name) => name.includes("-db"))).toBe(true);
    expect(created.some((name) => name.includes("-app"))).toBe(false);

    mockClaimCreationSaga.mockResolvedValueOnce({
      saga: {
        ...sagaClaim.saga,
        state: "compensating",
        last_error: "dependency timeout",
        owned_resources: { containerIds: ["ctr-1"] },
      },
      token: "compensation-token",
    } as never);
    mockGetServiceById.mockResolvedValueOnce({
      ...serviceRow(),
      container_ids: ["ctr-1"],
    } as never);
    await expect(
      resumeServiceCreation({ agent, db: makeDb(), caddy: makeCaddy() }, "svc-ready")
    ).resolves.toBe(true);
    expect(removed).toEqual(["ctr-1"]);
  });

  it("does not restart a completed creation saga on replay", async () => {
    mockClaimCreationSaga.mockResolvedValueOnce(null);
    const agent = makeAgent();

    await expect(
      resumeServiceCreation({ agent, db: makeDb(), caddy: makeCaddy() }, "svc-ready")
    ).resolves.toBe(false);
    expect(agent.containerCreate).not.toHaveBeenCalled();
    expect(agent.containerStart).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "exited successfully",
      initialState: { state: "exited", running: false, exitCode: 0 },
      dependencyState: { state: "exited", running: false, exitCode: 0 },
      startsInit: false,
    },
    {
      label: "created with exit code zero",
      initialState: { state: "created", running: false, exitCode: 0 },
      dependencyState: { state: "exited", running: false, exitCode: 0 },
      startsInit: true,
    },
  ])("resumes a one-shot init correctly when it is $label", async ({
    initialState,
    dependencyState,
    startsInit,
  }) => {
    mockClaimCreationSaga.mockResolvedValueOnce(sagaClaim as never);
    mockGetServiceById.mockResolvedValueOnce(oneShotServiceRow() as never);
    const starts: string[] = [];
    const creates: string[] = [];
    const initContainer = {
      id: "init-1",
      name: "ploydok-svc-svc-ready-migrate",
      serviceId: "svc-ready",
    };
    const healthStates = [initialState, dependencyState];
    const agent = makeAgent({
      imagePull: async function* () {},
      listContainers: mock(async () => ({ containers: [initContainer] })),
      containerCreate: mock(async (req: Record<string, unknown>) => {
        const name = String(req.name);
        creates.push(name);
        return { containerId: "app-1" };
      }),
      containerStart: mock(async ({ containerId }: { containerId: string }) => {
        starts.push(containerId);
        return {};
      }),
      inspectContainerHealth: mock(async () => ({
        status: 1,
        containerMissing: false,
        ...(healthStates.shift() ?? dependencyState),
      })),
    } as never);

    await resumeServiceCreation({ agent, db: makeDb(), caddy: makeCaddy() }, "svc-ready");

    expect(creates).toEqual(["ploydok-svc-svc-ready-app"]);
    expect(starts).toEqual(startsInit ? ["init-1", "app-1"] : ["app-1"]);
  });

  it("refuses to resume a one-shot when an older agent omits structured state", async () => {
    mockClaimCreationSaga.mockResolvedValueOnce(sagaClaim as never);
    mockGetServiceById.mockResolvedValueOnce(oneShotServiceRow() as never);
    const agent = makeAgent({
      imagePull: async function* () {},
      listContainers: mock(async () => ({
        containers: [{
          id: "init-1",
          name: "ploydok-svc-svc-ready-migrate",
          serviceId: "svc-ready",
        }],
      })),
      inspectContainerHealth: mock(async () => ({
        status: 1,
        containerMissing: false,
        running: false,
        exitCode: 0,
        statusText: "Exited (0) 1s ago",
      })),
    } as never);

    await expect(
      resumeServiceCreation({ agent, db: makeDb(), caddy: makeCaddy() }, "svc-ready")
    ).rejects.toThrow(/refusing to restart|ambiguous|complete state/i);
    expect(agent.containerStart).not.toHaveBeenCalled();
    expect(agent.containerCreate).not.toHaveBeenCalled();
  });

  it("refuses to resume a one-shot when an older agent lacks inspection support", async () => {
    mockClaimCreationSaga.mockResolvedValueOnce(sagaClaim as never);
    mockGetServiceById.mockResolvedValueOnce(oneShotServiceRow() as never);
    const agent = makeAgent({
      imagePull: async function* () {},
      listContainers: mock(async () => ({
        containers: [{
          id: "init-1",
          name: "ploydok-svc-svc-ready-migrate",
          serviceId: "svc-ready",
        }],
      })),
    } as never);

    await expect(
      resumeServiceCreation({ agent, db: makeDb(), caddy: makeCaddy() }, "svc-ready")
    ).rejects.toThrow(/does not support container inspection|refusing to restart/i);
    expect(agent.containerStart).not.toHaveBeenCalled();
    expect(agent.containerCreate).not.toHaveBeenCalled();
  });

  it("times out a Swarm dependency and compensates the services on the next saga step", async () => {
    mockClaimCreationSaga.mockResolvedValueOnce(sagaClaim as never);
    mockGetServiceById.mockResolvedValueOnce({
      ...serviceRow(),
      runtime_mode: "swarm",
      swarm_service_names: [],
    } as never);
    const created: string[] = [];
    const removed: string[] = [];
    const swarm = {
      ...makeSwarm(),
      serviceCreate: mock(async ({ spec }: { spec: Record<string, unknown> }) => {
        const name = String(spec.name);
        created.push(name);
        return { serviceId: name };
      }),
      serviceRemove: mock(async ({ serviceName }: { serviceName: string }) => {
        removed.push(serviceName);
        return {};
      }),
      listServiceTasks: mock(async () => ({
        tasks: [{
          status: "starting",
          running: true,
          healthStatus: "starting",
          state: "running",
        }],
      })),
    };
    const originalNow = Date.now;
    let logicalNow = originalNow();
    Date.now = () => {
      logicalNow += 10 * 60 * 1000;
      return logicalNow;
    };
    try {
      await expect(
        resumeServiceCreation({ agent: makeAgent(), swarm, db: makeDb(), caddy: makeCaddy() }, "svc-ready")
      ).rejects.toThrow(/Timed out|healthy|dependency/i);
    } finally {
      Date.now = originalNow;
    }

    expect(created).toHaveLength(1);
    mockClaimCreationSaga.mockResolvedValueOnce({
      saga: {
        ...sagaClaim.saga,
        state: "compensating",
        last_error: "dependency timeout",
        owned_resources: { swarmServiceNames: [created[0]!] },
      },
      token: "swarm-compensation-token",
    } as never);
    mockGetServiceById.mockResolvedValueOnce({
      ...serviceRow(),
      runtime_mode: "swarm",
      swarm_service_names: [created[0]!],
    } as never);
    await expect(
      resumeServiceCreation({ agent: makeAgent(), swarm, db: makeDb(), caddy: makeCaddy() }, "svc-ready")
    ).resolves.toBe(true);
    expect(removed).toEqual([created[0]!]);
  });
});

it("selects Docker mode for an explicit host IP before durable acceptance", async () => {
  const db = makeDb();
  (db.select as any).mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => [{ id: "proj-1" }] }) }),
  }));
  const agent = makeAgent();
  const row = await installFromTemplate({ db, agent }, "user-1", {
    projectId: "proj-1", name: "Bad", templateId: "fixture", templateVersion: "1",
    compose: 'services:\n  app:\n    image: nginx\n    ports: ["127.0.0.1:8080:80"]',
  });
  expect(row.runtime_mode).toBe("docker");
  expect(mockInsertService.mock.calls.at(-1)?.[1]).toMatchObject({
    runtime_mode: "docker",
  });
  expect((agent.containerCreate as any).mock.calls).toHaveLength(0);
});

it("persists the template declared entrypoint instead of the first exposed service", async () => {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "proj-1" }] }) }) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  } as unknown as OrchestratorDeps["db"];
  const row = await installFromTemplate({ db, agent: makeAgent() }, "user-1", {
    projectId: "proj-1", templateId: "n8n", templateVersion: "1", name: "N8N",
    compose: 'services:\n  sidecar:\n    image: nginx\n    expose: [80]\n  n8n:\n    image: n8nio/n8n\n',
    templateToml: '[variables]\nmain_domain = "\${domain}"\n[[config.domains]]\nserviceName = "n8n"\nport = 5678\nhost = "\${main_domain}"',
  });
  expect(row.entrypoint_service_name).toBe("n8n");
  expect(row.entrypoint_port).toBe(5678);
  const domainBase = deriveDefaultAppDomainBase({
    explicitBase: env.PLOYDOK_DOMAIN_BASE,
    publicHost: env.PLOYDOK_PUBLIC_HOST,
  })
  expect(row.domain).toMatch(
    new RegExp(`^my-pb-[0-9a-f]{6}\\.${domainBase.replaceAll(".", "\\.")}$`)
  )
  expect(mockInsertService.mock.calls.at(-1)?.[1]).toMatchObject({
    domain: row.domain,
  })
});

it("waits for a public Swarm service to materialize its overlay before ingress joins", async () => {
  const events: string[] = []
  mockGetServiceForUser.mockResolvedValueOnce({
    id: "svc-overlay", project_id: "proj-1", slug: "overlay", status: "stopped",
    runtime_mode: "swarm", swarm_service_names: [], domain: "overlay.example.test",
    compose_raw: 'services:\n  app:\n    image: nginx:alpine\n    expose: [80]\n',
    generated_env: {}, secrets_encrypted: true,
  } as never)
  mockEnsureCaddyOnProjectNetwork.mockImplementationOnce(async () => {
    expect(events).toEqual(["create", "running"])
    events.push("attach")
  })
  const swarm = {
    ...makeSwarm(),
    serviceCreate: mock(async () => {
      events.push("create")
      return { serviceId: "svc-overlay" }
    }),
    listServiceTasks: mock(async () => {
      events.push("running")
      return { tasks: [{ status: "running", running: true }] }
    }),
  }
  await startService({ agent: makeAgent(), swarm, db: makeDb() }, "user-1", "svc-overlay")
  expect(events).toEqual(["create", "running", "attach"])
})
