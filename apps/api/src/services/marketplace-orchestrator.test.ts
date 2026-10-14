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
    compose_raw: values["compose_raw"],
    generated_env: values["generated_env"],
    domain: values["domain"],
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

mock.module("@ploydok/db/queries", () => ({
  insertService: mockInsertService,
  createCreationSaga: mock(async () => {}),
  claimCreationSaga: mock(async () => null),
  fenceCreationSaga: mock(async () => true),
  recordClaimedCreationSagaStep: mock(async () => true),
  completeClaimedCreationSaga: mock(async () => true),
  beginClaimedCreationSagaCompensation: mock(async () => true),
  completeClaimedCreationSagaCompensation: mock(async () => true),
  retryClaimedCreationSaga: mock(async () => true),
  getServiceById: mock(async () => null),
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
  ensureProjectSwarmNetwork: mock(async () => "ploydok-swarm-proj-proj-1"),
}))

mock.module("../caddy/attachment.js", () => ({
  ensureCaddyOnProjectNetwork: mock(async () => {}),
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
  startService,
  stopService,
  deleteService,
} from "./marketplace-orchestrator"
import type { OrchestratorDeps } from "./marketplace-orchestrator"

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
      // compose with ${domain} DSL + a port so the entrypoint heuristic succeeds
      compose:
        'services:\n  app:\n    image: pocketbase:latest\n    ports:\n      - "8080:8080"\n    environment:\n      DOMAIN: ${domain}\n',
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
    const compose_raw = 'services:\n  web:\n    image: nginx:alpine\n    ports: ["80:80"]\n';
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
