// SPDX-License-Identifier: AGPL-3.0-only

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
