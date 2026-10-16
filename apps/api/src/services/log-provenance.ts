// SPDX-License-Identifier: AGPL-3.0-only
import type { Agent } from "../agent"
import { resolveRuntimeContainer } from "./runtime-containers"

export interface LogContainer {
  id: string
  name: string
  index: number
}

// Preserve the stored order: service log endpoints select by this index.
export async function logContainers(
  agent: Agent,
  refs: Array<string>
): Promise<Array<LogContainer>> {
  try {
    const { containers } = await agent.listContainers({ kindFilter: "" })
    return refs.flatMap((ref, index) => {
      const container = containers.find((c) => c.id === ref || c.name === ref)
      return container
        ? [{ id: container.id, name: container.name, index }]
        : []
    })
  } catch {
    // Provenance is optional; a failed inventory must not prevent log delivery.
    return []
  }
}

export async function appLogSource(
  agent: Agent,
  appId: string,
  preferredContainerRef?: string | null,
  requestedId?: string
): Promise<{ containers: Array<LogContainer>; index: number } | null> {
  const inventory = await agent.listContainers({ kindFilter: "" })
  const selected = requestedId
    ? inventory.containers.find(
        (container) =>
          container.id === requestedId &&
          container.appId === appId &&
          (!container.kind || container.kind === "app")
      )
    : await resolveRuntimeContainer(
        { listContainers: async () => inventory },
        { appId, preferredContainerRef: preferredContainerRef ?? null }
      )
  if (!selected) return null
  const containers = inventory.containers
    .filter(
      (container) =>
        container.id === selected.id ||
        (container.appId === appId &&
          (!container.kind || container.kind === "app"))
    )
    .map((container, index) => ({
      id: container.id,
      name: container.name,
      index,
    }))
  return {
    containers,
    index: containers.findIndex((container) => container.id === selected.id),
  }
}
