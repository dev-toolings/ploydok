// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Endpoint Prometheus minimaliste.
 *
 * Pas de dépendance externe (prom-client) — on génère le format text exposition
 * v0.0.4 directement, ce qui suffit pour des compteurs/gauges process-level.
 *
 * À étendre quand on aura besoin d'histogrammes (latency p95). Pour l'instant
 * la cible DoD = "Metrics Prometheus exposées sur /metrics (auth admin)".
 */

type Labels = Record<string, string>

interface Counter {
  type: "counter"
  help: string
  values: Map<string, number>
}

interface Gauge {
  type: "gauge"
  help: string
  values: Map<string, number>
}

type Metric = Counter | Gauge

const registry = new Map<string, Metric>()

function labelKey(labels: Labels = {}): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return ""
  return entries.map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(",")
}

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

export function counter(
  name: string,
  help: string
): {
  inc: (labels?: Labels, value?: number) => void
} {
  let m = registry.get(name) as Counter | undefined
  if (!m) {
    m = { type: "counter", help, values: new Map() }
    registry.set(name, m)
  }
  return {
    inc(labels: Labels = {}, value = 1) {
      const k = labelKey(labels)
      m!.values.set(k, (m!.values.get(k) ?? 0) + value)
    },
  }
}

export function gauge(
  name: string,
  help: string
): {
  set: (labels: Labels | undefined, value: number) => void
  remove: (labels?: Labels) => void
} {
  let m = registry.get(name) as Gauge | undefined
  if (!m) {
    m = { type: "gauge", help, values: new Map() }
    registry.set(name, m)
  }
  return {
    set(labels: Labels | undefined = {}, value: number) {
      const k = labelKey(labels ?? {})
      m!.values.set(k, value)
    },
    remove(labels: Labels = {}) {
      m!.values.delete(labelKey(labels))
    },
  }
}

/**
 * Sérialise toutes les métriques au format Prometheus text exposition.
 */
export function renderMetrics(): string {
  const lines: string[] = []
  for (const [name, m] of registry) {
    lines.push(`# HELP ${name} ${m.help}`)
    lines.push(`# TYPE ${name} ${m.type}`)
    for (const [labelStr, value] of m.values) {
      const series = labelStr ? `${name}{${labelStr}}` : name
      lines.push(`${series} ${value}`)
    }
  }
  return lines.join("\n") + "\n"
}

// ---------------------------------------------------------------------------
// Métriques process auto-collectées
// ---------------------------------------------------------------------------

const procStartTime = gauge(
  "process_start_time_seconds",
  "Start time of the process since unix epoch in seconds."
)
procStartTime.set(undefined, Math.floor(Date.now() / 1000))

const procUptime = gauge(
  "process_uptime_seconds",
  "Uptime of the process in seconds."
)

const memHeapUsed = gauge(
  "nodejs_heap_size_used_bytes",
  "Process heap memory used (bytes)."
)
const memRss = gauge(
  "nodejs_resident_memory_bytes",
  "Process resident memory size (bytes)."
)

export function collectProcessMetrics(): void {
  procUptime.set(undefined, Math.floor(process.uptime()))
  const m = process.memoryUsage()
  memHeapUsed.set(undefined, m.heapUsed)
  memRss.set(undefined, m.rss)
}

// ---------------------------------------------------------------------------
// Compteurs HTTP
// ---------------------------------------------------------------------------

export const httpRequestsTotal = counter(
  "http_requests_total",
  "Total number of HTTP requests handled, by method and status."
)
