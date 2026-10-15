// SPDX-License-Identifier: AGPL-3.0-only

// ---------------------------------------------------------------------------
// Marketplace catalog proxy
//
// The upstream registry serves the whole catalog as a single meta.json. Fetching
// it from every browser makes the page depend on a third party being reachable,
// leaks each visitor's IP to that third party, and re-downloads the payload per
// tab. This module fetches it once per TTL for the whole instance and keeps
// serving the last known-good copy when upstream breaks.
// ---------------------------------------------------------------------------

import { z } from "zod"
import type {
  MarketplaceTemplate,
  MarketplaceTemplateFiles,
} from "@ploydok/shared"
import { env } from "../env"
import { childLogger } from "../logger"
import { repairMojibake } from "./text-repair"

const log = childLogger("marketplace.catalog")

const CATALOG_TTL_MS = 10 * 60 * 1000
const FILES_TTL_MS = 30 * 60 * 1000
const UPSTREAM_TIMEOUT_MS = 10_000
// After an upstream failure, keep serving stale data but retry no more than
// once a minute instead of hammering a registry that is already down.
const FAILURE_BACKOFF_MS = 60 * 1000
const FILES_MAX_BYTES = 512 * 1024
const DEFAULT_BASE_URL = "https://templates.dokploy.com"

export class UpstreamUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UpstreamUnavailableError"
  }
}

// Upstream entries are parsed leniently: one malformed template must not take
// the whole catalog down, and optional fields drift over time.
const UpstreamTemplate = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.string().default(""),
  logo: z.string().optional(),
  tags: z.array(z.string()).default([]),
  links: z
    .object({
      github: z.string().optional(),
      website: z.string().optional(),
      docs: z.string().optional(),
    })
    .default({}),
})

interface CacheEntry<T> {
  data: T
  etag: string | undefined
  expiresAt: number
}

let catalogCache: CacheEntry<Array<MarketplaceTemplate>> | null = null
const filesCache = new Map<string, CacheEntry<MarketplaceTemplateFiles>>()

// The env schema already defaults this, but several suites replace the whole
// env module with a partial literal via mock.module (process-global in Bun), so
// reading it defensively keeps this module usable under those mocks.
export function baseUrl(): string {
  const configured = env.PLOYDOK_MARKETPLACE_BASE_URL || DEFAULT_BASE_URL
  return configured.replace(/\/+$/, "")
}

// Template ids are interpolated into upstream URLs, so they must never be able
// to escape the blueprints/ prefix.
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function isSafeTemplateId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..")
}

function toTemplate(
  raw: z.infer<typeof UpstreamTemplate>
): MarketplaceTemplate {
  return {
    id: raw.id,
    name: repairMojibake(raw.name),
    description: repairMojibake(raw.description),
    version: raw.version,
    logoUrl: raw.logo ? `${baseUrl()}/blueprints/${raw.id}/${raw.logo}` : null,
    tags: raw.tags,
    links: raw.links,
  }
}

async function upstreamFetch(url: string, etag?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (etag) headers["If-None-Match"] = etag
  return fetch(url, {
    headers,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
}

export interface CatalogResult {
  templates: Array<MarketplaceTemplate>
  stale: boolean
}

export async function getCatalog(): Promise<CatalogResult> {
  const now = Date.now()
  if (catalogCache && catalogCache.expiresAt > now) {
    return { templates: catalogCache.data, stale: false }
  }

  try {
    const res = await upstreamFetch(
      `${baseUrl()}/meta.json`,
      catalogCache?.etag
    )

    if (res.status === 304 && catalogCache) {
      catalogCache = { ...catalogCache, expiresAt: now + CATALOG_TTL_MS }
      return { templates: catalogCache.data, stale: false }
    }

    if (!res.ok) {
      throw new Error(`upstream responded ${res.status}`)
    }

    const payload: unknown = await res.json()
    if (!Array.isArray(payload)) {
      throw new Error("upstream payload is not an array")
    }

    const templates: Array<MarketplaceTemplate> = []
    let skipped = 0
    for (const item of payload) {
      const parsed = UpstreamTemplate.safeParse(item)
      if (!parsed.success) {
        skipped += 1
        continue
      }
      templates.push(toTemplate(parsed.data))
    }

    if (templates.length === 0) {
      throw new Error("upstream catalog contained no usable template")
    }
    if (skipped > 0) {
      log.warn({ skipped }, "skipped malformed upstream templates")
    }

    catalogCache = {
      data: templates,
      etag: res.headers.get("etag") ?? undefined,
      expiresAt: now + CATALOG_TTL_MS,
    }
    return { templates, stale: false }
  } catch (err) {
    if (catalogCache) {
      log.warn(
        { err: (err as Error).message },
        "catalog upstream unreachable, serving stale cache"
      )
      catalogCache = { ...catalogCache, expiresAt: now + FAILURE_BACKOFF_MS }
      return { templates: catalogCache.data, stale: true }
    }
    log.error(
      { err: (err as Error).message },
      "catalog upstream unreachable and no cache available"
    )
    throw new UpstreamUnavailableError((err as Error).message)
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`upstream responded ${res.status} for ${url}`)
  const text = await res.text()
  if (text.length > FILES_MAX_BYTES) {
    throw new Error(`upstream file exceeds ${FILES_MAX_BYTES} bytes`)
  }
  return text
}

export async function getTemplateFiles(
  id: string
): Promise<MarketplaceTemplateFiles> {
  const now = Date.now()
  const cached = filesCache.get(id)
  if (cached && cached.expiresAt > now) return cached.data

  try {
    const [templateToml, dockerCompose] = await Promise.all([
      fetchText(`${baseUrl()}/blueprints/${id}/template.toml`),
      fetchText(`${baseUrl()}/blueprints/${id}/docker-compose.yml`),
    ])
    const data: MarketplaceTemplateFiles = { templateToml, dockerCompose }
    filesCache.set(id, {
      data,
      etag: undefined,
      expiresAt: now + FILES_TTL_MS,
    })
    return data
  } catch (err) {
    if (cached) {
      log.warn(
        { id, err: (err as Error).message },
        "template files upstream unreachable, serving stale cache"
      )
      filesCache.set(id, { ...cached, expiresAt: now + FAILURE_BACKOFF_MS })
      return cached.data
    }
    throw new UpstreamUnavailableError((err as Error).message)
  }
}

export function matchesQuery(
  template: MarketplaceTemplate,
  q: string
): boolean {
  if (template.name.toLowerCase().includes(q)) return true
  if (template.description.toLowerCase().includes(q)) return true
  return template.tags.some((tag) => tag.toLowerCase().includes(q))
}

// Test seam: the module-level caches would otherwise leak between test cases.
export function resetCatalogCacheForTests(): void {
  catalogCache = null
  filesCache.clear()
}

// Test seam: expire the TTL while keeping the data, so the stale-on-error path
// can be exercised without manipulating the clock.
export function expireCatalogCacheForTests(): void {
  if (catalogCache) catalogCache = { ...catalogCache, expiresAt: 0 }
  for (const [key, entry] of filesCache) {
    filesCache.set(key, { ...entry, expiresAt: 0 })
  }
}
