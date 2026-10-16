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

/**
 * Caddy's host matcher takes an authority hostname, while the public URL
 * shown to users may also contain a scheme and a development port. Keep that
 * distinction at the route boundary so a service domain such as
 * `https://demo-abc123.apps.example.com:8181` still produces the matcher
 * `demo-abc123.apps.example.com`.
 */
export function normalizeCaddyHost(domain: string): string {
  const value = domain.trim()
  if (!value) {
    throw new Error("Service domain must not be empty")
  }

  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `http://${value}`

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`Service domain is not a valid host: ${domain}`)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Service domain is not an HTTP(S) host: ${domain}`)
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new Error(
      `Service domain must be a hostname or HTTP(S) origin: ${domain}`
    )
  }

  return parsed.hostname.replace(/\.$/, "").toLowerCase()
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
  const { serviceId, containers } = input
  const { name, port } = input.entrypoint ?? pickEntrypoint(containers)

  if (!name || port === 0) {
    throw new ServiceHasNoEntrypointError(serviceId)
  }

  const domain = normalizeCaddyHost(input.domain)
  const upstream = `${name}:${port}`

  await client.upsertRoute({
    accessLogs: false,
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
