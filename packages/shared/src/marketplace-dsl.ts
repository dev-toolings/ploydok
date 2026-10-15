// SPDX-License-Identifier: AGPL-3.0-only
//
// Uses the isomorphic Web Crypto API (`globalThis.crypto`) instead of
// `node:crypto` so this module can be imported from both server (Bun/Node)
// and client (Vite/browser) bundles without "externalized for browser
// compatibility" errors.

function randomBytesHex(len: number): string {
  const bytes = new Uint8Array(len)
  globalThis.crypto.getRandomValues(bytes)
  let out = ""
  for (const b of bytes) out += b.toString(16).padStart(2, "0")
  return out
}

function randomBytesBase64(len: number): string {
  const bytes = new Uint8Array(len)
  globalThis.crypto.getRandomValues(bytes)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function isomorphicRandomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export interface DslContext {
  projectSlug: string
  domainBase?: string | undefined
  publicOrigin?: string | undefined
  publicScheme?: "http" | "https" | undefined
}

export interface ResolveResult {
  composeResolved: string
  generatedVars: Record<string, string>
  domain: string | null
}

export class UnknownDslHelperError extends Error {
  constructor(token: string) {
    super(`Unknown DSL helper: ${token}`)
    this.name = "UnknownDslHelperError"
  }
}

const HELPER_WHITELIST = new Set([
  "domain",
  "password",
  "base64",
  "hash",
  "uuid",
  "timestamp",
  "timestampms",
  "timestamps",
])

function helperName(varName: string): string {
  const colon = varName.indexOf(":")
  return colon === -1 ? varName : varName.slice(0, colon)
}

function numericArg(varName: string, defaultVal: number): number {
  const colon = varName.indexOf(":")
  if (colon === -1) return defaultVal
  const parsed = Number.parseInt(varName.slice(colon + 1), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal
}

function normalizeDomainBase(domainBase: string | undefined): string {
  const value = domainBase?.trim() ?? ""
  if (!value) return "demo.localhost"
  try {
    const parsed = new URL(value.includes("://") ? value : `http://${value}`)
    return parsed.hostname.replace(/\.$/, "").toLowerCase()
  } catch {
    return value
      .replace(/^\w+:\/\//, "")
      .replace(/\/$/, "")
      .toLowerCase()
  }
}

function generatedDomainOrigin(
  domain: string,
  context: Pick<DslContext, "publicOrigin" | "publicScheme">
): string {
  let port = ""
  let originScheme = context.publicScheme ?? "https"
  if (context.publicOrigin) {
    try {
      const origin = new URL(context.publicOrigin)
      port = origin.port ? `:${origin.port}` : ""
      if (
        !context.publicScheme &&
        (origin.protocol === "http:" || origin.protocol === "https:")
      ) {
        originScheme = origin.protocol.slice(0, -1) as "http" | "https"
      }
    } catch {
      // The explicit scheme remains a safe fallback for malformed optional origins.
    }
  }
  return `${originScheme}://${domain}${port}`
}

export function rewriteGeneratedDomainUrls(
  value: string,
  generatedDomain: string | readonly string[] | null,
  context: Pick<DslContext, "publicOrigin" | "publicScheme">
): string {
  const domains = Array.isArray(generatedDomain)
    ? generatedDomain
    : generatedDomain
      ? [generatedDomain]
      : []
  return domains.reduce((result, domain) => {
    const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const targetOrigin = generatedDomainOrigin(domain, context)
    return result.replace(
      new RegExp(
        `https?://${escapedDomain}(?::\\d+)?(?![A-Za-z0-9.@_:-])`,
        "gi"
      ),
      targetOrigin
    )
  }, value)
}

export function generateDomain(
  projectSlug: string,
  domainBase?: string
): string {
  const hash = randomBytesHex(3)
  return `${projectSlug}-${hash}.${normalizeDomainBase(domainBase)}`
}

function generatePassword(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return out.toLowerCase()
}

export function resolveTemplate(
  compose: string,
  context: DslContext
): ResolveResult {
  if (!compose) {
    return { composeResolved: compose, generatedVars: {}, domain: null }
  }

  const cache = new Map<string, string>()
  const generatedVars: Record<string, string> = {}
  let domain: string | null = null

  const DSL_PATTERN = /\$\{([^}]+)\}/g

  // First pass: validate all helpers
  for (const match of compose.matchAll(DSL_PATTERN)) {
    const varName = match[1] ?? ""
    const name = helperName(varName)
    if (!HELPER_WHITELIST.has(name)) {
      throw new UnknownDslHelperError(match[0])
    }
  }

  // Second pass: resolve with caching
  const composeResolved = compose.replace(DSL_PATTERN, (_match, varName) => {
    const cacheKey = varName

    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)!
    }

    let value: string

    if (varName === "domain") {
      value = generateDomain(context.projectSlug, context.domainBase)
      domain = value
    } else if (varName === "password") {
      value = generatePassword(16)
    } else if (varName.startsWith("password:")) {
      const len = numericArg(varName, 16)
      value = generatePassword(len)
    } else if (varName === "base64") {
      value = randomBytesBase64(32)
    } else if (varName.startsWith("base64:")) {
      const len = numericArg(varName, 32)
      value = randomBytesBase64(len)
    } else if (varName === "hash") {
      value = `${context.projectSlug}-${randomBytesHex(3)}`
    } else if (varName.startsWith("hash:")) {
      const len = numericArg(varName, 3)
      value = `${context.projectSlug}-${randomBytesHex(len)}`
    } else if (varName === "uuid") {
      value = isomorphicRandomUUID()
    } else if (varName === "timestamp" || varName === "timestampms") {
      value = Date.now().toString()
    } else {
      // varName === "timestamps"
      value = Math.round(Date.now() / 1000).toString()
    }

    cache.set(cacheKey, value)
    generatedVars[varName] = value
    return value
  })

  return {
    composeResolved: rewriteGeneratedDomainUrls(
      composeResolved,
      domain,
      context
    ),
    generatedVars,
    domain,
  }
}
