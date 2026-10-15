// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock } from "bun:test"
import {
  upsertServiceRoute,
  removeServiceRoute,
  ServiceHasNoEntrypointError,
} from "./service-routes"
import type { CaddyClient } from "./client"
import type { ComposeContainer } from "../marketplace/compose-to-containers"

function makeClient(
  overrides: Partial<Pick<CaddyClient, "upsertRoute" | "removeRoute">> = {}
): Pick<CaddyClient, "upsertRoute" | "removeRoute"> {
  return {
    upsertRoute: mock(async () => {}),
    removeRoute: mock(async () => {}),
    ...overrides,
  }
}

function makeContainer(
  overrides: Partial<ComposeContainer> = {}
): ComposeContainer {
  return {
    name: "svc-app",
    image: "myimage:latest",
    env: {},
    labels: {},
    networks: ["ploydok-public"],
    volumes: [],
    ports: [],
    restartPolicy: "unless-stopped",
    command: [],
    dependsOn: [],
    composeName: "app",
    ...overrides,
  }
}

describe("upsertServiceRoute", () => {
  it("single container with ports → upsertRoute called with correct upstream and host", async () => {
    const client = makeClient()
    const container = makeContainer({
      name: "svc-app",
      ports: [{ containerPort: 8080, hostPort: 8080, proto: "tcp" }],
    })

    await upsertServiceRoute(client as unknown as CaddyClient, {
      serviceId: "svc-123",
      domain: "myservice-abc123.traefik.me",
      containers: [container],
    })

    expect(client.upsertRoute).toHaveBeenCalledTimes(1)
    expect(client.upsertRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "myservice-abc123.traefik.me",
        upstream: "svc-app:8080",
        appId: "svc-123",
      })
    )
  })

  it("single container with exposedPort → uses exposedPort", async () => {
    const client = makeClient()
    const container = makeContainer({
      name: "svc-web",
      exposedPort: 3000,
      ports: [{ containerPort: 3000, hostPort: 3000, proto: "tcp" }],
    })

    await upsertServiceRoute(client as unknown as CaddyClient, {
      serviceId: "svc-456",
      domain: "web.example.com",
      containers: [container],
    })

    expect(client.upsertRoute).toHaveBeenCalledWith(
      expect.objectContaining({ upstream: "svc-web:3000" })
    )
  })

  it("two containers, only second has exposedPort → routes to the one with exposedPort", async () => {
    const client = makeClient()
    const db = makeContainer({ name: "svc-db", ports: [] })
    const web = makeContainer({
      name: "svc-web",
      exposedPort: 8080,
      ports: [{ containerPort: 8080, hostPort: 8080, proto: "tcp" }],
    })

    await upsertServiceRoute(client as unknown as CaddyClient, {
      serviceId: "svc-789",
      domain: "multi.example.com",
      containers: [db, web],
    })

    expect(client.upsertRoute).toHaveBeenCalledWith(
      expect.objectContaining({ upstream: "svc-web:8080" })
    )
  })

  it("two containers, neither has exposedPort → picks first with ports[]", async () => {
    const client = makeClient()
    const c1 = makeContainer({
      name: "svc-c1",
      ports: [{ containerPort: 9000, hostPort: 9000, proto: "tcp" }],
    })
    const c2 = makeContainer({
      name: "svc-c2",
      ports: [{ containerPort: 9001, hostPort: 9001, proto: "tcp" }],
    })

    await upsertServiceRoute(client as unknown as CaddyClient, {
      serviceId: "svc-aaa",
      domain: "fallback.example.com",
      containers: [c1, c2],
    })

    expect(client.upsertRoute).toHaveBeenCalledWith(
      expect.objectContaining({ upstream: "svc-c1:9000" })
    )
  })

  it("uses the declared template entrypoint instead of the first exposed container", async () => {
    const client = makeClient()
    const worker = makeContainer({
      name: "svc-worker",
      composeName: "worker",
      exposedPort: 9000,
      ports: [{ containerPort: 9000, hostPort: 9000, proto: "tcp" }],
    })
    const web = makeContainer({
      name: "svc-web",
      composeName: "web",
      exposedPort: 8080,
      ports: [{ containerPort: 8080, hostPort: 8080, proto: "tcp" }],
    })

    await upsertServiceRoute(client as unknown as CaddyClient, {
      serviceId: "svc-declared",
      domain: "declared.example.com",
      containers: [worker, web],
      entrypoint: { name: "svc-web", port: 8088 },
    })

    expect(client.upsertRoute).toHaveBeenCalledWith(
      expect.objectContaining({ upstream: "svc-web:8088" })
    )
  })

  it("no container has any port → throws ServiceHasNoEntrypointError", async () => {
    const client = makeClient()
    const c1 = makeContainer({ name: "svc-a", ports: [] })
    const c2 = makeContainer({ name: "svc-b", ports: [] })

    await expect(
      upsertServiceRoute(client as unknown as CaddyClient, {
        serviceId: "svc-noport",
        domain: "noport.example.com",
        containers: [c1, c2],
      })
    ).rejects.toBeInstanceOf(ServiceHasNoEntrypointError)

    expect(client.upsertRoute).not.toHaveBeenCalled()
  })
})

describe("removeServiceRoute", () => {
  it("calls removeRoute with the serviceId", async () => {
    const client = makeClient()
    await removeServiceRoute(client as unknown as CaddyClient, "svc-del-1")
    expect(client.removeRoute).toHaveBeenCalledTimes(1)
    expect(client.removeRoute).toHaveBeenCalledWith("svc-del-1")
  })

  it("is idempotent — 404 from removeRoute is not thrown (swallowed by CaddyClient)", async () => {
    // CaddyClient.removeRoute already swallows 404 internally.
    // This test ensures removeServiceRoute does not wrap removeRoute in extra logic.
    const client = makeClient({
      removeRoute: mock(async () => {}),
    })
    await expect(
      removeServiceRoute(client as unknown as CaddyClient, "svc-gone")
    ).resolves.toBeUndefined()
  })
})
