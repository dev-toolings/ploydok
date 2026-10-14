// SPDX-License-Identifier: AGPL-3.0-only
import type { CaddyClient } from "./client.js"
import type { ComposeContainer } from "../marketplace/compose-to-containers.js"

type CaddyRouteClient = Pick<CaddyClient, "upsertRoute" | "removeRoute">

export interface UpsertServiceRouteInput {
  serviceId: string
  domain: string
  containers: ComposeContainer[]
  entrypoint?: { name: string; port: number }
}

export class ServiceHasNoEntrypointError extends Error {
  constructor(serviceId: string) {
    super(`Service ${serviceId} has no container with an exposed port`)
    this.name = "ServiceHasNoEntrypointError"
  }
}

function pickEntrypoint(containers: ComposeContainer[]): {
  name: string
  port: number
} {
  if (containers.length === 1) {
    const c = containers[0]!
    const port = c.exposedPort ?? c.ports[0]?.containerPort
    if (port === undefined) {
      return { name: c.name, port: 0 }
    }
    return { name: c.name, port }
  }

  // Multiple containers: first with exposedPort
  for (const c of containers) {
    if (c.exposedPort !== undefined) {
      return { name: c.name, port: c.exposedPort }
    }
  }

  // Then first with any port
  for (const c of containers) {
    const port = c.ports[0]?.containerPort
    if (port !== undefined) {
      return { name: c.name, port }
    }
  }

  return { name: "", port: 0 }
}

export async function upsertServiceRoute(
  client: CaddyRouteClient,
  input: UpsertServiceRouteInput
): Promise<void> {
  const { serviceId, domain, containers } = input

  const { name, port } = input.entrypoint ?? pickEntrypoint(containers)

  if (!name || port === 0) {
    throw new ServiceHasNoEntrypointError(serviceId)
  }

  const upstream = `${name}:${port}`

  await client.upsertRoute({
    host: domain,
    upstream,
    appId: serviceId,
  })
}

export async function removeServiceRoute(
  client: CaddyRouteClient,
  serviceId: string
): Promise<void> {
  await client.removeRoute(serviceId)
}
