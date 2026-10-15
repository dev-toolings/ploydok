// SPDX-License-Identifier: AGPL-3.0-only
import { resolve4, resolve6, resolveCname } from "node:dns/promises"
import { connect } from "node:tls"
import { eq } from "drizzle-orm"
import { apps, builds, domains } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { env } from "../env"
import { normalizeAppHostname } from "./app-domain"
import { getCaddyTlsOptionsForDomain } from "./caddy-tls"
import type { CaddyMiddlewares, CaddyTlsOptions } from "../caddy/types"

export type DnsStatus = "valid" | "missing" | "mismatch" | "error"
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

export async function inspectDomainDns(
  hostname: string,
  opts: {
    publicHost?: string
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
    port?: number
    timeoutMs?: number
  } = {}
): Promise<TlsInspection> {
  const checkedAt = new Date().toISOString()
  const scheme = opts.scheme ?? env.PLOYDOK_PUBLIC_SCHEME
  if (scheme !== "https") {
    return { status: "not_required", checkedAt, error: null }
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

export async function publishHealthyAppRoute(input: {
  db: Db
  appId: string
  buildId?: string
  hostname: string
  applyRoute: () => Promise<void>
  beforePersist?: () => Promise<void>
  inspectDns?: (hostname: string) => Promise<DnsInspection>
  inspectTls?: (hostname: string) => Promise<TlsInspection>
}): Promise<HealthyRouteResult> {
  const hostname = normalizeAppHostname(input.hostname)
  if (!hostname) throw new Error("Cannot publish route for invalid hostname")

  let dns: DnsInspection
  try {
    dns = await (input.inspectDns ?? inspectDomainDns)(hostname)
  } catch (error) {
    dns = {
      status: "error",
      records: [],
      expectedRecords: expectedDnsRecords(hostname, env.PLOYDOK_PUBLIC_HOST),
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
  }

  let routeError: string | null = null
  try {
    await input.applyRoute()
  } catch (error) {
    if (isDeployControlError(error)) throw error
    routeError = error instanceof Error ? error.message : String(error)
  }

  let tls: TlsInspection
  if (env.PLOYDOK_PUBLIC_SCHEME !== "https") {
    tls = await (input.inspectTls ?? inspectDomainTls)(hostname)
  } else if (dns.status === "valid" && !routeError) {
    try {
      tls = await (input.inspectTls ?? inspectDomainTls)(hostname)
    } catch (error) {
      tls = {
        status: "failed",
        checkedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  } else {
    tls = {
      status: "pending",
      checkedAt: new Date().toISOString(),
      error: dns.status === "valid" ? routeError : "TLS waits for valid DNS",
    }
  }

  const errors = [dns.error, routeError, tls.error].filter(
    (value): value is string => Boolean(value)
  )
  const status: RoutingStatus =
    !routeError &&
    dns.status === "valid" &&
    (tls.status === "issued" || tls.status === "not_required")
      ? "ready"
      : "action_required"
  const result = {
    status,
    hostname,
    dnsStatus: dns.status,
    tlsStatus: tls.status,
    error: errors.length ? errors.join("; ") : null,
  } satisfies HealthyRouteResult

  if (input.beforePersist) await input.beforePersist()
  await input.db
    .update(apps)
    .set({
      routing_status: result.status,
      routing_error: result.error,
      routing_dns_status: result.dnsStatus,
      routing_tls_status: result.tlsStatus,
    })
    .where(eq(apps.id, input.appId))
  if (!routeError && input.buildId) {
    await input.db
      .update(builds)
      .set({ routing_domain: hostname })
      .where(eq(builds.id, input.buildId))
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
