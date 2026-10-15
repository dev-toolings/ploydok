// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from "node:net"
import { and, desc, eq, isNull, isNotNull, inArray, sql } from "drizzle-orm"
import { apps, builds } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { env } from "../env"

function normalizeHostname(value: string | null | undefined): string {
  const raw = value?.trim()
  if (!raw) return ""
  try {
    const parsed = new URL(raw.includes("://") ? raw : `http://${raw}`)
    return parsed.hostname.replace(/\.$/, "").toLowerCase()
  } catch {
    return raw
      .replace(/^\w+:\/\//, "")
      .replace(/:\d+$/, "")
      .replace(/\.$/, "")
      .toLowerCase()
  }
}

const DOMAIN_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const APP_HOSTNAME_REGEX = new RegExp(
  `^(?:${DOMAIN_LABEL}\\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`,
  "i"
)

export type AppDomainSource = "generated" | "custom"

export type AppDomainCollision = {
  resource: "app" | "service" | "domain"
  hostname: string
  resourceId: string
}

export function normalizeAppHostname(value: string): string | null {
  const raw = value.trim()
  if (!raw || raw.includes("*") || raw.includes("@")) return null

  let hostname: string
  try {
    const parsed = new URL(raw.includes("://") ? raw : `http://${raw}`)
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash
    ) {
      return null
    }
    hostname = parsed.hostname.replace(/\.$/, "").toLowerCase()
  } catch {
    return null
  }

  if (
    hostname.length > 253 ||
    isIP(hostname) !== 0 ||
    !APP_HOSTNAME_REGEX.test(hostname)
  )
    return null
  return hostname
}

export function classifyAppDomain(
  hostname: string,
  domainBase: string
): AppDomainSource {
  const normalizedBase = normalizeHostname(domainBase)
  return normalizedBase &&
    (hostname === normalizedBase || hostname.endsWith(`.${normalizedBase}`))
    ? "generated"
    : "custom"
}

const ACTIVE_APP_STATUSES = ["running", "restarting", "serving"] as const
export const ROUTING_MIGRATION_ERROR =
  "Routing state must be rechecked after migration"

/**
 * Reconcile metadata introduced after apps already existed. The domain source
 * must use the currently configured generated base, while an active runtime
 * starts in an actionable state until a fresh routing inspection supplies DNS
 * and TLS evidence. Only the latest successful build receives the current
 * hostname; older builds remain unknown because they may have used another
 * host and are valid rollback history.
 */
export async function backfillAppDomainMetadata(
  db: Db,
  domainBase: string
): Promise<{ appsUpdated: number; buildsUpdated: number }> {
  const rows = await db
    .select({
      id: apps.id,
      domain: apps.domain,
      domain_source: apps.domain_source,
      status: apps.status,
      routing_status: apps.routing_status,
      routing_error: apps.routing_error,
      routing_dns_status: apps.routing_dns_status,
      routing_tls_status: apps.routing_tls_status,
    })
    .from(apps)
    .where(isNotNull(apps.domain))

  let appsUpdated = 0
  let buildsUpdated = 0
  for (const row of rows) {
    if (!row.domain) continue
    const domainSource = classifyAppDomain(row.domain, domainBase)
    const isActive = (ACTIVE_APP_STATUSES as readonly string[]).includes(
      row.status
    )
    const routingNeedsEvidence =
      isActive &&
      (row.routing_status === "pending" ||
        (row.routing_status === "ready" &&
          (row.routing_dns_status === null || row.routing_tls_status === null)))

    const patch: {
      domain_source?: "generated" | "custom"
      routing_status?: "action_required"
      routing_error?: string
      routing_dns_status?: null
      routing_tls_status?: null
    } = {}
    if (row.domain_source !== domainSource) {
      patch.domain_source = domainSource
    }
    if (routingNeedsEvidence) {
      patch.routing_status = "action_required"
      patch.routing_error = ROUTING_MIGRATION_ERROR
      patch.routing_dns_status = null
      patch.routing_tls_status = null
    }
    if (Object.keys(patch).length > 0) {
      const routingErrorFence =
        row.routing_error === null
          ? isNull(apps.routing_error)
          : eq(apps.routing_error, row.routing_error)
      const changed = await db
        .update(apps)
        .set(patch)
        .where(
          and(
            eq(apps.id, row.id),
            eq(apps.domain, row.domain),
            eq(apps.routing_status, row.routing_status),
            routingErrorFence
          )
        )
        .returning({ id: apps.id })
      if (changed.length > 0) appsUpdated++
    }

    // Only migration-marked rows can safely receive a legacy build fallback.
    // A later domain edit leaves the app pending with a different cause, so
    // it must not make us claim that an old build used the new hostname.
    if (
      !isActive ||
      row.routing_status !== "action_required" ||
      row.routing_error !== ROUTING_MIGRATION_ERROR
    )
      continue
    const latestBuild = await db
      .select({ id: builds.id })
      .from(builds)
      .where(
        and(
          inArray(builds.status, ["succeeded", "succeeded_with_warning"]),
          eq(builds.app_id, row.id)
        )
      )
      .orderBy(desc(builds.created_at), desc(builds.id))
      .limit(1)
    const build = latestBuild[0]
    if (build) {
      const routingErrorFenceSql =
        row.routing_error === null
          ? sql`fence."routing_error" IS NULL`
          : sql`fence."routing_error" = ${row.routing_error}`
      const changed = await db
        .update(builds)
        .set({ routing_domain: row.domain })
        .where(
          // A non-null value is historical evidence and must never be replaced
          // with the app's current domain.
          and(
            eq(builds.id, build.id),
            isNull(builds.routing_domain),
            sql`EXISTS (
              SELECT 1
              FROM "apps" AS fence
              WHERE fence."id" = ${row.id}
                AND fence."domain" = ${row.domain}
                AND fence."routing_status" = ${row.routing_status}
                AND ${routingErrorFenceSql}
            )`
          )
        )
        .returning({ id: builds.id })
      if (changed.length > 0) buildsUpdated++
    }
  }

  return { appsUpdated, buildsUpdated }
}

/**
 * Classify a hostname using the instance's configured generated-domain base.
 * Rollback and runtime workers use this when restoring a build's hostname so
 * `apps.domain` and `apps.domain_source` remain an atomic pair.
 */
export function classifyAppDomainWithInstanceBase(
  hostname: string
): AppDomainSource {
  return classifyAppDomain(
    hostname,
    deriveDefaultAppDomainBase({
      explicitBase: env.PLOYDOK_DOMAIN_BASE,
      publicHost: env.PLOYDOK_PUBLIC_HOST,
    })
  )
}

export function domainCollisionCandidates(hostname: string): string[] {
  if (hostname.startsWith("*.")) return [hostname]
  const candidates = new Set([hostname])
  const labels = hostname.split(".")
  if (labels.length > 2) {
    candidates.add(`*.${labels.slice(1).join(".")}`)
  }
  return [...candidates]
}

function isIpv4Host(host: string): boolean {
  const parts = host.split(".")
  return (
    parts.length === 4 &&
    parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false
      const n = Number(part)
      return n >= 0 && n <= 255
    })
  )
}

export function deriveDefaultAppDomainBase(opts: {
  explicitBase?: string | null | undefined
  publicHost?: string | null | undefined
}): string {
  const explicitBase = normalizeHostname(opts.explicitBase)
  if (explicitBase) return explicitBase

  const publicHost = normalizeHostname(opts.publicHost)
  if (isIpv4Host(publicHost)) {
    return `${publicHost.replace(/\./g, "-")}.sslip.io`
  }

  // `.localhost` resolves to loopback without any DNS or /etc/hosts entry, and
  // wildcards work out of the box. A `.local` base would be swallowed by mDNS
  // on most Linux hosts (`nsswitch` stops at `[NOTFOUND=return]`).
  if (
    !publicHost ||
    publicHost === "localhost" ||
    publicHost.endsWith(".local")
  ) {
    return "demo.localhost"
  }

  return `apps.${publicHost}`
}

export function buildPublicOrigin(opts: {
  scheme: "http" | "https"
  host: string
  port?: number | null | undefined
}): string {
  const host = normalizeHostname(opts.host) || "localhost"
  return buildPublicUrl(host, {
    scheme: opts.scheme,
    port: opts.port,
  })!
}

export function buildPublicUrl(
  host: string | null | undefined,
  opts: { scheme: "http" | "https"; port?: number | null | undefined }
): string | null {
  const normalizedHost = normalizeHostname(host)
  if (!normalizedHost) return null
  const isDefaultPort =
    opts.port == null ||
    (opts.scheme === "http" && opts.port === 80) ||
    (opts.scheme === "https" && opts.port === 443)
  const port = isDefaultPort ? "" : `:${opts.port}`
  return `${opts.scheme}://${normalizedHost}${port}`
}
