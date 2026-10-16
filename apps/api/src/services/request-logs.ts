// SPDX-License-Identifier: AGPL-3.0-only
import { apps, domains, type Db } from "@ploydok/db"
import type { Agent } from "../agent"
import { pickCaddyIngressContainer } from "../caddy/attachment"
import { REQUEST_LOG_NAME } from "../caddy/access-logging"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"

export type RuntimeLogSource = "app" | "requests" | "all"
export function runtimeLogSource(value?: string): RuntimeLogSource | null {
  return value === undefined || value === "app"
    ? "app"
    : value === "requests" || value === "all"
      ? value
      : null
}
export interface RequestLog {
  t: number
  kind: "request"
  method: string
  host: string
  path: string
  status: number
  durationMs: number
  size: number
  requestId: string
  line: string
}
export function normalizeRequestHost(value: string): string {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return ""
  }
}

/** Allowlist only. Raw headers, query values and client addresses never leave here. */
export function parseCaddyRequest(line: string): RequestLog | null {
  try {
    const data = JSON.parse(line)
    if (data?.logger !== REQUEST_LOG_NAME || !data.request) return null
    const { method, host, uri } = data.request
    if (
      typeof method !== "string" ||
      !/^[A-Z-]{1,32}$/.test(method) ||
      typeof host !== "string" ||
      typeof uri !== "string"
    )
      return null
    if (
      ![data.ts, data.status, data.duration, data.size].every(
        (v: unknown) => typeof v === "number" && Number.isFinite(v)
      )
    )
      return null
    if (
      data.status < 100 ||
      data.status > 599 ||
      data.duration < 0 ||
      data.size < 0
    )
      return null
    const normalizedHost = normalizeRequestHost(host)
    if (!normalizedHost || !uri.startsWith("/")) return null
    const path = uri
      .split(/[?#]/, 1)[0]!
      .replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 8192)
    const requestId =
      typeof data.request_id === "string"
        ? data.request_id.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 128)
        : ""
    const durationMs = Math.round(data.duration * 1000 * 100) / 100
    const level =
      data.status >= 500 ? "error" : data.status >= 400 ? "warn" : "info"
    return {
      t: data.ts * 1000,
      kind: "request",
      method,
      host: normalizedHost,
      path,
      status: data.status,
      durationMs,
      size: data.size,
      requestId,
      line: `[${level}] ${method} ${path}  ${data.status}  ${durationMs} ms  ${normalizedHost}  ${data.size} B${requestId ? `  request_id=${requestId}` : ""}`,
    }
  } catch {
    return null
  }
}

export function mapRequestHosts(
  rows: Array<{ appId: string; host: string | null }>
): Map<string, string> {
  const hosts = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const row of rows) {
    if (!row.host) continue
    const host = normalizeRequestHost(row.host)
    if (!host || ambiguous.has(host)) continue
    if (hosts.has(host) && hosts.get(host) !== row.appId) {
      hosts.set(host, "")
      ambiguous.add(host)
    } else hosts.set(host, row.appId)
  }
  return hosts
}
export function requestApp(
  hosts: Map<string, string>,
  host: string
): string | undefined {
  const normalized = normalizeRequestHost(host)
  const exact = hosts.get(normalized)
  if (exact !== undefined) return exact || undefined
  const dot = normalized.indexOf(".")
  return dot > 0 ? hosts.get(`*${normalized.slice(dot)}`) : undefined
}

type Listener = (entry: RequestLog) => void
interface Dependencies {
  agent: () => Pick<Agent, "listContainers" | "containerLogs">
  loadHosts: () => Promise<Array<{ appId: string; host: string | null }>>
}
const log = childLogger("request-logs")

/** One demand-driven Caddy stream shared by all apps and snapshot callers. */
export class RequestLogs {
  private readonly subscribers = new Map<string, Set<Listener>>()
  private readonly rings = new Map<string, RequestLog[]>()
  private hosts = new Map<string, string>()
  private refreshedAt = 0
  private refresh: Promise<void> | null = null
  private running: Promise<void> | null = null
  private iterator: AsyncIterator<{ line: string }> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  constructor(private readonly deps: Dependencies) {}

  private async refreshHosts(): Promise<void> {
    if (Date.now() - this.refreshedAt < 10_000) return
    if (!this.refresh)
      this.refresh = this.deps
        .loadHosts()
        .then((rows) => {
          this.hosts = mapRequestHosts(rows)
          this.refreshedAt = Date.now()
          for (const [appId, ring] of this.rings) {
            const kept = ring.filter(
              (entry) =>
                requestApp(this.hosts, entry.host) === appId &&
                entry.t > Date.now() - 600_000
            )
            if (kept.length) this.rings.set(appId, kept)
            else this.rings.delete(appId)
          }
        })
        .finally(() => {
          this.refresh = null
        })
    await this.refresh
  }

  async replay(appId: string, limit = 500): Promise<RequestLog[]> {
    await this.refreshHosts()
    return (this.rings.get(appId) ?? [])
      .filter((entry) => entry.t > Date.now() - 600_000)
      .slice(-limit)
  }

  subscribe(appId: string, listener: Listener): () => void {
    const listeners = this.subscribers.get(appId) ?? new Set<Listener>()
    listeners.add(listener)
    this.subscribers.set(appId, listeners)
    this.start()
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.subscribers.delete(appId)
      if (!this.subscribers.size) {
        this.generation++
        if (this.retry) clearTimeout(this.retry)
        this.retry = null
        const iterator = this.iterator
        this.iterator = null
        void iterator?.return?.()
      }
    }
  }

  private start(): void {
    if (this.running || this.retry || !this.subscribers.size) return
    const generation = this.generation
    this.running = this.read(generation)
      .catch((err) => {
        if (generation === this.generation)
          log.warn({ err }, "Caddy request stream interrupted")
      })
      .finally(() => {
        this.running = null
        this.iterator = null
        if (this.subscribers.size)
          this.retry = setTimeout(() => {
            this.retry = null
            this.start()
          }, 1_000)
      })
  }

  private async read(generation: number): Promise<void> {
    await this.refreshHosts()
    const agent = this.deps.agent()
    const { containers } = await agent.listContainers({ kindFilter: "" })
    const caddy = pickCaddyIngressContainer(
      containers.filter((c) => c.status === "running")
    )
    if (!caddy) throw new Error("Caddy ingress container not found")
    if (generation !== this.generation || !this.subscribers.size) return
    const iterator = agent
      .containerLogs({
        containerId: caddy.id,
        follow: true,
        sinceUnix: 0,
        tail: 5000,
      })
      [Symbol.asyncIterator]()
    this.iterator = iterator
    try {
      while (generation === this.generation && this.subscribers.size) {
        const next = await iterator.next()
        if (next.done || generation !== this.generation) break
        const entry = parseCaddyRequest(next.value.line)
        if (!entry) continue
        await this.refreshHosts()
        if (generation !== this.generation) break
        const appId = requestApp(this.hosts, entry.host)
        if (!appId || entry.t < Date.now() - 600_000) continue
        const ring = this.rings.get(appId) ?? []
        if (
          ring.some(
            (e) =>
              e.t === entry.t &&
              e.requestId === entry.requestId &&
              e.line === entry.line
          )
        )
          continue
        ring.push(entry)
        if (ring.length > 500) ring.shift()
        this.rings.delete(appId)
        this.rings.set(appId, ring)
        if (this.rings.size > 100)
          this.rings.delete(this.rings.keys().next().value!)
        for (const listener of this.subscribers.get(appId) ?? []) {
          try {
            listener(entry)
          } catch {
            /* A disconnected client must not stop the reader. */
          }
        }
      }
    } finally {
      if (this.iterator === iterator) {
        this.iterator = null
        void iterator.return?.()
      }
    }
  }

  async snapshot(appId: string, limit: number): Promise<RequestLog[]> {
    const stop = this.subscribe(appId, () => {})
    try {
      // Allow the shared follow reader to ingest Docker's recent tail. Bounded
      // best-effort snapshot, never a second independent containerLogs reader.
      await new Promise((resolve) => setTimeout(resolve, 500))
      return await this.replay(appId, limit)
    } finally {
      stop()
    }
  }
}

let shared: RequestLogs | undefined
export function getRequestLogs(db: Db): RequestLogs {
  return (shared ??= new RequestLogs({
    agent: getSharedAgent,
    loadHosts: async () => {
      const [primary, extra] = await Promise.all([
        db.select({ appId: apps.id, host: apps.domain }).from(apps),
        db
          .select({ appId: domains.app_id, host: domains.hostname })
          .from(domains),
      ])
      return [...primary, ...extra]
    },
  }))
}
