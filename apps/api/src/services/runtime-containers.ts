// SPDX-License-Identifier: AGPL-3.0-only
import type { Agent } from "../agent"
import type { ContainerSnapshot } from "@ploydok/shared"
import { customAlphabet } from "nanoid"

const ephemeralSuffix = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12)

export type RuntimeContainerColor = "blue" | "green"

const STATUS_PRIORITY: Record<ContainerSnapshot["status"], number> = {
  running: 4,
  unhealthy: 3,
  starting: 2,
  stopped: 1,
  unknown: 0,
}

export function normalizeRuntimeContainerSlug(slug: string, maxLength = 32): string {
  const normalized = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)

  return normalized || "app"
}

/** Keep the entire random suffix when bounding names to the agent's policy. */
export function ephemeralContainerName(
  kind: "hook-pre" | "hook-post" | "scheduled-job",
  resourceId: string
): string {
  const token = normalizeRuntimeContainerSlug(resourceId).replace(/-+$/, "")
  return `ploydok-${kind}-${token}-${ephemeralSuffix()}`
}

/**
 * Build a Docker reference-safe image repository name from an app id.
 *
 * Docker reference grammar (distribution/reference) only allows runs of a
 * single separator: `--`, `__`, `..` are valid; `-_` or `_-` are NOT (e.g.
 * `app-xsr2-_4ut` is rejected by BuildKit with "invalid reference format").
 * Nanoid's default alphabet mixes `-` and `_`, so the raw `app-${id}` form
 * occasionally produces invalid sequences depending on the random id.
 *
 * Normalize every run of non-alphanumeric characters to a single `-`, which
 * is universally accepted. Existing apps whose ids contain only `[a-z0-9-]`
 * are unaffected (idempotent).
 */
export function imageRepoForApp(appId: string): string {
  const sanitized = appId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `app-${sanitized || "anon"}`
}

export function runtimeContainerShortId(appId: string): string {
  // Nanoid's default alphabet includes `_`, which the agent validator rejects
  // (container_name_prefix regex `^ploydok-[a-z0-9][a-z0-9-]{0,62}$`). Strip
  // any character outside `[a-z0-9-]` before slicing so the 8-char prefix is
  // always a valid Docker name component.
  return appId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 8)
}

export function runtimeContainerName(
  app: { id: string; slug: string },
  color: RuntimeContainerColor
): string {
  const slug = normalizeRuntimeContainerSlug(app.slug)
  const shortId = runtimeContainerShortId(app.id)
  return `ploydok-app-${slug}-${shortId}-${color}`
}

export function legacyRuntimeContainerName(
  appId: string,
  color: RuntimeContainerColor
): string {
  return `ploydok-app-${appId.toLowerCase()}-${color}`
}

export function runtimeContainerNameCandidates(
  app: { id: string; slug: string },
  color: RuntimeContainerColor
): Array<string> {
  return Array.from(
    new Set([
      runtimeContainerName(app, color),
      legacyRuntimeContainerName(app.id, color),
    ])
  )
}

export function inferContainerColor(
  containerRef: string | null | undefined
): RuntimeContainerColor | null {
  if (!containerRef) return null
  if (containerRef.includes("-blue")) return "blue"
  if (containerRef.includes("-green")) return "green"
  return null
}

function selectBestAppContainer(
  containers: Array<ContainerSnapshot>,
  appId: string
): ContainerSnapshot | null {
  let selected: ContainerSnapshot | null = null

  for (const container of containers) {
    if (container.app_id !== appId) continue
    if (container.kind && container.kind !== "app") continue
    if (!selected) {
      selected = container
      continue
    }

    const statusDiff =
      STATUS_PRIORITY[container.status] - STATUS_PRIORITY[selected.status]
    if (statusDiff > 0) {
      selected = container
      continue
    }
    if (statusDiff === 0 && container.last_seen_ms > selected.last_seen_ms) {
      selected = container
    }
  }

  return selected
}

export async function resolveRuntimeContainer(
  agent: Pick<Agent, "listContainers">,
  opts: {
    appId: string
    preferredContainerRef?: string | null
  }
): Promise<ContainerSnapshot | null> {
  const { containers } = await agent.listContainers({ kindFilter: "" })

  const snapshots = containers.map((c) => ({
    id: c.id,
    name: c.name,
    image: c.image,
    status: c.status || "unknown",
    uptime_s: c.uptimeS,
    cpu_pct: c.cpuPct,
    mem_bytes: c.memBytes,
    mem_limit_bytes: c.memLimitBytes,
    restart_count: c.restartCount,
    kind: c.kind || undefined,
    app_id: c.appId || undefined,
    color: c.color || undefined,
    last_ping_ms: c.lastPingMs > 0 ? c.lastPingMs : undefined,
    last_ping_ok: c.lastPingMs > 0 ? c.lastPingOk : undefined,
    last_seen_ms: c.lastSeenMs > 0 ? c.lastSeenMs : Date.now(),
  })) as Array<ContainerSnapshot>

  if (opts.preferredContainerRef) {
    const preferred = snapshots.find(
      (container) =>
        container.id === opts.preferredContainerRef ||
        container.name === opts.preferredContainerRef
    )
    if (preferred) return preferred
  }

  return selectBestAppContainer(snapshots, opts.appId)
}
