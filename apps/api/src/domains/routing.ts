// SPDX-License-Identifier: AGPL-3.0-only
import { resolve4, resolve6, resolveCname } from "node:dns/promises"
import { connect } from "node:tls"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { apps, builds, domains } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { env } from "../env"
import { classifyAppDomain, deriveDefaultAppDomainBase, normalizeAppHostname } from "./app-domain"
import { isCloudflareProxyAddress } from "./cdn-addresses"
import { verifyDomain } from "./verifier"
import { getCaddyTlsOptionsForDomain } from "./caddy-tls"
import type { CaddyMiddlewares, CaddyTlsOptions } from "../caddy/types"

export type DnsStatus = "valid" | "missing" | "mismatch" | "error" | "unknown"
export type TlsStatus = "issued" | "pending" | "failed" | "not_required"
export type RoutingStatus = "ready" | "action_required"

export type ExpectedDnsRecord = {
  type: "A" | "AAAA" | "CNAME"
  name: string
  value: string
}

export type DnsInspection = {
  status: DnsStatus
  records: Array<{ type: "A" | "AAAA" | "CNAME"; value: string }>
  expectedRecords: ExpectedDnsRecord[]
  checkedAt: string
  error: string | null
}

export type TlsInspection = {
  status: TlsStatus
  checkedAt: string
  error: string | null
}

export type HealthyRouteResult = {
  status: RoutingStatus
  hostname: string
  routeApplied: boolean
  dnsStatus: DnsStatus
  tlsStatus: TlsStatus
  error: string | null
}

export type AliasSyncResult = {
  updated: number
  errors: string[]
}

type DnsFns = {
  resolve4: (hostname: string) => Promise<string[]>
  resolve6: (hostname: string) => Promise<string[]>
  resolveCname: (hostname: string) => Promise<string[]>
}

const dnsFns: DnsFns = { resolve4, resolve6, resolveCname }

function hostFromValue(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`)
      .hostname.replace(/\.$/, "")
      .toLowerCase()
  } catch {
    return value.trim().replace(/\.$/, "").toLowerCase()
  }
}

function isIp(value: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(":")
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === "string" ? code : null
}

export function expectedDnsRecords(
  hostname: string,
  publicHost: string
): ExpectedDnsRecord[] {
  const target = hostFromValue(publicHost)
  if (isIp(target)) {
    const type = target.includes(":") ? "AAAA" : "A"
    return [{ type, name: hostname, value: target }]
  }
  return [{ type: "CNAME", name: hostname, value: target }]
}

export function isInstanceManagedDomain(hostname: string, publicHost = env.PLOYDOK_PUBLIC_HOST, domainBase?: string): boolean {
  const base = domainBase ?? deriveDefaultAppDomainBase({
    explicitBase: env.PLOYDOK_DOMAIN_BASE,
    publicHost,
  })
  return hostname === "localhost" || hostname.endsWith(".localhost") ||
    classifyAppDomain(hostname, base) === "generated"
}

export async function inspectDomainDns(
  hostname: string,
  opts: {
    publicHost?: string
    domainBase?: string
    proxied?: boolean
    timeoutMs?: number
    functions?: DnsFns
  } = {}
): Promise<DnsInspection> {
  const normalized = normalizeAppHostname(hostname) ?? hostFromValue(hostname)
  const publicHost = opts.publicHost ?? env.PLOYDOK_PUBLIC_HOST
  const expectedRecords = expectedDnsRecords(normalized, publicHost)
  const functions = opts.functions ?? dnsFns
  const timeoutMs = opts.timeoutMs ?? 1_500
  const checkedAt = new Date().toISOString()
  if (isInstanceManagedDomain(normalized, publicHost, opts.domainBase)) {
    const local = normalized === "localhost" || normalized.endsWith(".localhost")
    return { status: "unknown", records: [], expectedRecords: local ? [] : expectedRecords, checkedAt, error: null }
  }

  const lookups = await Promise.allSettled([
    withTimeout(functions.resolve4(normalized), timeoutMs),
    withTimeout(functions.resolve6(normalized), timeoutMs),
    withTimeout(functions.resolveCname(normalized), timeoutMs),
  ])
  const records: DnsInspection["records"] = []
  const errors: unknown[] = []
  const target = hostFromValue(publicHost)
  const targetAddresses = new Set<string>()

  for (const result of lookups) {
    if (result.status === "rejected") {
      errors.push(result.reason)
      continue
    }
    const index = lookups.indexOf(result)
    const type = index === 0 ? "A" : index === 1 ? "AAAA" : "CNAME"
    for (const value of result.value) records.push({ type, value })
  }

  if (!isIp(target)) {
    const targetLookups = await Promise.allSettled([
      withTimeout(functions.resolve4(target), timeoutMs),
      withTimeout(functions.resolve6(target), timeoutMs),
    ])
    for (const result of targetLookups) {
      if (result.status === "fulfilled") {
        for (const value of result.value) targetAddresses.add(value)
      }
    }
  } else {
    targetAddresses.add(target)
  }

  const addresses = records.filter(
    (record) => record.type === "A" || record.type === "AAAA"
  )
  const matches = addresses.length > 0 && addresses.every(
    (record) => targetAddresses.has(record.value)
  )
  const allMissing = records.length === 0
  const meaningfulError = errors.find((error) => {
    const code = errorCode(error)
    return code !== "ENOTFOUND" && code !== "ENODATA" && code !== "ENXDOMAIN"
  })
  let status: DnsStatus
  let error: string | null = null
  if (matches) {
    status = "valid"
  } else if (addresses.length > 0 && (opts.proxied || addresses.every((record) => isCloudflareProxyAddress(record.value)))) {
    status = "unknown"
  } else if (allMissing && !meaningfulError) {
    status = "missing"
  } else if (meaningfulError) {
    status = "error"
    error = meaningfulError instanceof Error ? meaningfulError.message : String(meaningfulError)
  } else {
    status = "mismatch"
    error = "DNS records do not point to the configured public host"
  }

  return { status, records, expectedRecords, checkedAt, error }
}

export async function inspectDomainTls(
  hostname: string,
  opts: {
    scheme?: "http" | "https"
    /** Set only after ownership and healthy route registration, never in preview. */
    allowProvisioning?: boolean
    port?: number
    timeoutMs?: number
  } = {}
): Promise<TlsInspection> {
  const checkedAt = new Date().toISOString()
  const scheme = opts.scheme ?? env.PLOYDOK_PUBLIC_SCHEME
  if (scheme !== "https") {
    return { status: "not_required", checkedAt, error: null }
  }

  if (!opts.allowProvisioning) {
    return { status: "pending", checkedAt, error: null }
  }
  const normalized = normalizeAppHostname(hostname) ?? hostFromValue(hostname)
  const port = opts.port ?? 443
  const timeoutMs = opts.timeoutMs ?? 3_000
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({
      // Connect to Ploydok's configured public listener while preserving the
      // requested hostname as SNI. This avoids DNS rebinding an arbitrary
      // user-supplied host into an internal address during the check.
      host: hostFromValue(env.PLOYDOK_PUBLIC_HOST),
      port: env.PLOYDOK_PUBLIC_PORT ?? port,
      servername: normalized,
      rejectUnauthorized: true,
    })
    const finish = (result: TlsInspection) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ...result, checkedAt })
    }
    const timer = setTimeout(
      () => finish({ status: "failed", checkedAt, error: "TLS handshake timed out" }),
      timeoutMs
    )
    socket.once("secureConnect", () => {
      clearTimeout(timer)
      finish({ status: "issued", checkedAt, error: null })
    })
    socket.once("error", (error) => {
      clearTimeout(timer)
      finish({
        status: "failed",
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })
}

function isDeployControlError(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown; message?: unknown }
  const marker = `${String(value?.name ?? "")} ${String(value?.code ?? "")} ${String(value?.message ?? "")}`
  return /lease.?lost|deploy.?cancel|cancelled/i.test(marker)
}

async function hasCustomDomainTxtProof(db: Db, appId: string, hostname: string): Promise<boolean> {
  try {
    const rows = await db.select({ id: domains.id }).from(domains).where(and(
      eq(domains.app_id, appId), eq(domains.hostname, hostname)
    )).limit(1)
    if (!rows[0]) return false
    return (await withTimeout(verifyDomain(db, rows[0].id), 1_500)).ok
  } catch {
    return false
  }
}

/**
 * A DNS inspection can be inconclusive for a hostname behind a CDN. In that
 * case, an app may still publish the host when there is durable evidence that
 * this app already served it. Successful build snapshots cover rollbacks and
 * route reads cover installations created before routing_domain was tracked.
 * The route reader must be scoped to the app's primary Caddy route.
 */
async function hasPreviouslyServedSameAppHost(input: {
  db: Db
  appId: string
  hostname: string
  getCurrentRouteHost?: () => Promise<string | null>
}): Promise<boolean> {
  const [appRows, buildRows] = await Promise.all([
    (async () => {
      try {
        return await input.db
          .select({
            domain: apps.domain,
            routing_status: apps.routing_status,
          })
          .from(apps)
          .where(eq(apps.id, input.appId))
          .limit(1)
      } catch {
        return []
      }
    })(),
    (async () => {
      try {
        // Do not limit this to the newest build. A rollback can legitimately
        // restore a hostname from an older successful build.
        return await input.db
          .select({ routing_domain: builds.routing_domain })
          .from(builds)
          .where(and(
            eq(builds.app_id, input.appId),
            inArray(builds.status, ["succeeded", "succeeded_with_warning"]),
            eq(builds.routing_domain, input.hostname),
          ))
          .orderBy(desc(builds.created_at), desc(builds.id))
          .limit(1)
      } catch {
        return []
      }
    })(),
  ])

  const app = appRows[0]
  const currentDomainWasReady = Boolean(
    app &&
    (normalizeAppHostname(app.domain ?? "") ?? "") === input.hostname &&
    app.routing_status === "ready"
  )
  if (currentDomainWasReady || buildRows.length > 0) return true

  let currentRouteHost: string | null = null
  if (input.getCurrentRouteHost) {
    try {
      currentRouteHost = await input.getCurrentRouteHost()
    } catch {
      // A stale/unavailable Caddy admin API is a soft ownership-proof miss.
      // The DNS/TXT evidence and primary route application retain their own
      // error handling below.
    }
  }

  const routeMatches = currentRouteHost !== null &&
    (normalizeAppHostname(currentRouteHost) ?? currentRouteHost.trim().toLowerCase()) === input.hostname
  return routeMatches
}

export async function publishHealthyAppRoute(input: {
  db: Db
  appId: string
  buildId?: string
  hostname: string
  applyRoute: () => Promise<void>
  /** Alias publication is secondary to the primary route and may need follow-up. */
  afterRoute?: () => Promise<void>
  proxied?: boolean
  beforePersist?: () => Promise<void>
  inspectDns?: (hostname: string) => Promise<DnsInspection>
  inspectTls?: (hostname: string) => Promise<TlsInspection>
  verifyOwnership?: (hostname: string) => Promise<boolean>
  /** Reads the host on Caddy's `ploydok-${appId}` primary route, if present. */
  getCurrentRouteHost?: () => Promise<string | null>
}): Promise<HealthyRouteResult> {
  const hostname = normalizeAppHostname(input.hostname)
  if (!hostname) throw new Error("Cannot publish route for invalid hostname")

  let dns: DnsInspection
  try {
    dns = input.inspectDns
      ? await input.inspectDns(hostname)
      : await inspectDomainDns(hostname, input.proxied === undefined ? {} : { proxied: input.proxied })
  } catch (error) {
    if (isDeployControlError(error)) throw error
    dns = {
      status: "error", records: [],
      expectedRecords: expectedDnsRecords(hostname, env.PLOYDOK_PUBLIC_HOST),
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const managed = isInstanceManagedDomain(hostname)
  let ownershipVerified = false
  if (!managed && dns.status !== "valid") {
    try {
      ownershipVerified = await (input.verifyOwnership ??
        ((host) => hasCustomDomainTxtProof(input.db, input.appId, host)))(hostname)
    } catch (error) {
      if (isDeployControlError(error)) throw error
      // Failed proof lookups leave the healthy runtime awaiting user action.
    }
  }
  let previouslyServed = false
  if (!managed && dns.status !== "valid" && !ownershipVerified) {
    previouslyServed = await hasPreviouslyServedSameAppHost({
      db: input.db,
      appId: input.appId,
      hostname,
      ...(input.getCurrentRouteHost ? { getCurrentRouteHost: input.getCurrentRouteHost } : {}),
    })
  }
  const authorized = managed || dns.status === "valid" || ownershipVerified || previouslyServed
  let aliasError: string | null = null
  let routeApplied = false
  if (authorized) {
    // Primary routing is part of the runtime switch. Propagate failures so the
    // caller reconciles the new slot and retains its previously live runtime.
    await input.applyRoute()
    routeApplied = true
    if (input.afterRoute) {
      try {
        await input.afterRoute()
      } catch (error) {
        if (isDeployControlError(error)) throw error
        aliasError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  let tls: TlsInspection
  if (env.PLOYDOK_PUBLIC_SCHEME !== "https") {
    tls = { status: "not_required", checkedAt: new Date().toISOString(), error: null }
  } else if (routeApplied) {
    try {
      tls = input.inspectTls
        ? await input.inspectTls(hostname)
        : await inspectDomainTls(hostname, { allowProvisioning: true })
    } catch (error) {
      if (isDeployControlError(error)) throw error
      tls = {
        status: "failed", checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  } else {
    tls = { status: "pending", checkedAt: new Date().toISOString(), error: null }
  }

  const gateError = authorized ? null :
    dns.status === "unknown" ? "DOMAIN_OWNERSHIP_REQUIRED" : "DOMAIN_DNS_REQUIRED"
  const errors = [gateError, dns.error, aliasError, tls.error].filter(
    (value): value is string => Boolean(value)
  )
  const status: RoutingStatus = routeApplied && !aliasError &&
    (tls.status === "issued" || tls.status === "not_required")
    ? "ready" : "action_required"
  const result: HealthyRouteResult = {
    status, hostname, routeApplied, dnsStatus: dns.status, tlsStatus: tls.status,
    error: errors.length ? errors.join("; ") : null,
  }
  if (input.beforePersist) await input.beforePersist()
  await input.db.update(apps).set({
    routing_status: result.status,
    routing_error: result.error,
    routing_dns_status: result.dnsStatus,
    routing_tls_status: result.tlsStatus,
  }).where(eq(apps.id, input.appId))
  if (routeApplied && input.buildId) {
    await input.db.update(builds).set({ routing_domain: hostname }).where(and(
      eq(builds.id, input.buildId), eq(builds.app_id, input.appId),
      isNull(builds.routing_domain)
    ))
  }
  return result
}

/**
 * Repoints only verified custom aliases after a blue-green or rollback switch.
 * Unverified aliases remain absent from Caddy until their own verification
 * succeeds, so a rollback cannot accidentally publish a claimed hostname.
 */
export async function syncAppDomainAliases(input: {
  db: Db
  appId: string
  upstream?: { host: string; port: number }
  static?: { root: string; spaFallback: boolean }
  cdn?: CaddyMiddlewares["cdn"]
  caddy: {
    upsertRoute: (route: {
      host: string
      upstream: string
      appId: string
      tls?: CaddyTlsOptions
      middlewares?: { cdn: NonNullable<CaddyMiddlewares["cdn"]> }
    }) => Promise<void>
    upsertStaticRoute?: (route: {
      host: string
      root: string
      appId: string
      spaFallback?: boolean
      cdn?: CaddyMiddlewares["cdn"]
    }) => Promise<void>
  }
  beforeSideEffect?: () => Promise<void>
}): Promise<AliasSyncResult> {
  if (!input.upstream && !input.static) {
    throw new Error("Alias routing requires a runtime upstream or static root")
  }
  const appRows = await input.db
    .select({
      cdn_mode: apps.cdn_mode,
      cdn_cache_ttl_s: apps.cdn_cache_ttl_s,
      cdn_cache_paths: apps.cdn_cache_paths,
      cdn_compression: apps.cdn_compression,
      cdn_image_optim: apps.cdn_image_optim,
      cdn_headers: apps.cdn_headers,
      cdn_external_provider: apps.cdn_external_provider,
    })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1)
  const appCdn = appRows[0]
    ? {
        cdn_mode: appRows[0].cdn_mode,
        cdn_cache_ttl_s: appRows[0].cdn_cache_ttl_s,
        cdn_cache_paths: appRows[0].cdn_cache_paths,
        cdn_compression: appRows[0].cdn_compression,
        cdn_image_optim: appRows[0].cdn_image_optim,
        cdn_headers: appRows[0].cdn_headers,
        cdn_external_provider: appRows[0].cdn_external_provider,
      }
    : undefined
  const cdn = input.cdn ?? appCdn
  const aliases = await input.db
    .select()
    .from(domains)
    .where(eq(domains.app_id, input.appId))
  let updated = 0
  const errors: string[] = []
  for (const alias of aliases) {
    if (alias.tls_status !== "issued" && alias.tls_status !== "not_required") continue
    if (input.beforeSideEffect) await input.beforeSideEffect()
    try {
      const tls = await getCaddyTlsOptionsForDomain(
        input.db,
        input.appId,
        alias.tls_mode,
        alias.dns01_provider
      )
      if (input.static) {
        if (!input.caddy.upsertStaticRoute) {
          throw new Error("Static alias routing is unavailable")
        }
        await input.caddy.upsertStaticRoute({
          host: alias.hostname,
          root: input.static.root,
          appId: `domain-${alias.id}`,
          spaFallback: input.static.spaFallback,
          ...(cdn ? { cdn } : {}),
        })
      } else {
        await input.caddy.upsertRoute({
          host: alias.hostname,
          upstream: `${input.upstream!.host}:${input.upstream!.port}`,
          appId: `domain-${alias.id}`,
          ...(tls ? { tls } : {}),
          ...(cdn ? { middlewares: { cdn } } : {}),
        })
      }
      updated++
    } catch (error) {
      if (isDeployControlError(error)) throw error
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { updated, errors }
}
