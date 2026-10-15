// SPDX-License-Identifier: AGPL-3.0-only
import { isIP } from "node:net"

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
