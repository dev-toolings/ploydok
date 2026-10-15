// SPDX-License-Identifier: AGPL-3.0-only
import { or, sql } from "drizzle-orm"
import type { AnyColumn } from "drizzle-orm/column"
import { apps, domains, services } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { env } from "../env"
import {
  domainCollisionCandidates,
  normalizeAppHostname,
} from "./app-domain"
import type { AppDomainCollision } from "./app-domain"

function normalizeClaimedHostname(value: string): string | null {
  const raw = value.trim().toLowerCase()
  if (!raw.startsWith("*.")) return normalizeAppHostname(raw)
  const base = normalizeAppHostname(raw.slice(2))
  return base ? `*.${base}` : null
}

export class DomainCollisionError extends Error {
  readonly code = "DOMAIN_CONFLICT"
  readonly collisions: AppDomainCollision[]

  constructor(collisions: AppDomainCollision[]) {
    super("Hostname is already in use")
    this.name = "DomainCollisionError"
    this.collisions = collisions
  }
}

export class InvalidAppDomainError extends Error {
  readonly code = "INVALID_DOMAIN"

  constructor() {
    super("Domain must be a hostname without a path, port, or credentials")
    this.name = "InvalidAppDomainError"
  }
}

/**
 * Serializes all domain ownership changes for the same hostname. PostgreSQL's
 * advisory lock lets app, service, and custom-domain transactions share one
 * race boundary even though the legacy owners live in separate tables.
 */
export async function lockDomain(db: Db, hostname: string): Promise<void> {
  const candidate = db as unknown as {
    execute?: (query: unknown) => Promise<unknown>
  }
  if (typeof candidate.execute === "function") {
    for (const candidateHostname of domainCollisionCandidates(hostname).sort()) {
      await candidate.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${candidateHostname}, 0))`
      )
    }
  }
}

function hostnameCondition(
  column: AnyColumn,
  candidates: string[],
  wildcardRequested: boolean
) {
  return or(
    ...candidates.flatMap((candidate) => {
      if (wildcardRequested && candidate.startsWith("*.")) {
        return [
          sql`lower(${column}) = ${candidate}`,
          sql`lower(${column}) like ${`%.${candidate.slice(2)}`} and lower(${column}) not like ${`%.%.${candidate.slice(2)}`}`,
        ]
      }
      return [sql`lower(${column}) = ${candidate}`]
    })
  )
}

export async function findDomainCollisions(
  db: Db,
  rawHostname: string,
  opts: { excludeAppId?: string } = {}
): Promise<AppDomainCollision[]> {
  const hostname = normalizeClaimedHostname(rawHostname)
  if (!hostname) throw new InvalidAppDomainError()
  const instanceHostname = normalizeAppHostname(env.PLOYDOK_PUBLIC_HOST)
  if (instanceHostname && domainCollisionCandidates(instanceHostname).includes(hostname)) {
    return [{ resource: "domain", resourceId: "instance", hostname }]
  }
  const candidates = domainCollisionCandidates(hostname)
  const wildcardRequested = hostname.startsWith("*.")

  const [appRows, domainRows, serviceRows] = await Promise.all([
    db
      .select({ id: apps.id, hostname: apps.domain })
      .from(apps)
      .where(hostnameCondition(apps.domain, candidates, wildcardRequested))
      .limit(32),
    db
      .select({ id: domains.id, appId: domains.app_id, hostname: domains.hostname })
      .from(domains)
      .where(hostnameCondition(domains.hostname, candidates, wildcardRequested))
      .limit(32),
    db
      .select({ id: services.id, hostname: services.domain })
      .from(services)
      .where(hostnameCondition(services.domain, candidates, wildcardRequested))
      .limit(32),
  ])

  return [
    ...appRows
      .filter((row) => row.id !== opts.excludeAppId && row.hostname)
      .map((row) => ({
        resource: "app" as const,
        resourceId: row.id,
        hostname: row.hostname!,
      })),
    ...domainRows
      .filter((row) => row.appId !== opts.excludeAppId)
      .map((row) => ({
      resource: "domain" as const,
      resourceId: row.id,
      hostname: row.hostname,
      })),
    ...serviceRows
      .filter((row) => row.hostname)
      .map((row) => ({
        resource: "service" as const,
        resourceId: row.id,
        hostname: row.hostname!,
      })),
  ]
}

export async function assertDomainAvailable(
  db: Db,
  rawHostname: string,
  opts: { excludeAppId?: string } = {}
): Promise<string> {
  const hostname = normalizeClaimedHostname(rawHostname)
  if (!hostname) throw new InvalidAppDomainError()
  const collisions = await findDomainCollisions(db, hostname, opts)
  if (collisions.length > 0) throw new DomainCollisionError(collisions)
  return hostname
}

export function isUniqueDomainConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const record = error as Record<string, unknown>
  const message = String(record.message ?? "")
  const constraint = String(record.constraint ?? "")
  return (
    record.code === "23505" &&
    (constraint.includes("apps_domain_unique") ||
      message.includes("apps_domain_unique") ||
      constraint.includes("domains_hostname_unique") ||
      message.includes("domains_hostname_unique"))
  )
}

export async function withDomainLock<T>(
  db: Db,
  rawHostname: string,
  operation: (lockedDb: Db, hostname: string) => Promise<T>
): Promise<T> {
  const hostname = normalizeClaimedHostname(rawHostname)
  if (!hostname) throw new InvalidAppDomainError()
  return db.transaction(async (tx) => {
    const lockedDb = tx as unknown as Db
    await lockDomain(lockedDb, hostname)
    return operation(lockedDb, hostname)
  })
}

export function isDomainInCandidates(
  hostname: string,
  target: string
): boolean {
  return domainCollisionCandidates(hostname).includes(target)
}
