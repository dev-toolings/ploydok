// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useSyncExternalStore } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, apiFetch } from "./api"
import { useEventsStatus, useEventsSubscription } from "./events-provider"

export interface HostStats {
  cpu_percent: number
  cpu_count: number
  mem_total_bytes: number
  mem_used_bytes: number
  mem_available_bytes: number
  // Older APIs omit these. Missing means unknown: readers treat it as 0.
  mem_configured_bytes?: number
  mem_reclaimed_bytes?: number
  swap_total_bytes: number
  swap_used_bytes: number
  load_1: number
  load_5: number
  load_15: number
  disk_total_bytes: number
  disk_used_bytes: number
  disk_free_bytes: number
  inodes_total: number
  inodes_used: number
  uptime_seconds: number
  gpu_count: number
  gpu_utilization_pct: number
  gpu_mem_used_bytes: number
  gpu_mem_total_bytes: number
  gpu_name: string
  thresholds: {
    disk_warn_pct: number
    mem_warn_pct: number
    load_warn_per_cpu: number
  }
  alerts: Array<string>
  error: string
  fetched_at: number
}

const POLL_INTERVAL_MS = 15_000
const WATCH_INTERVAL_MS = 20_000
const QUERY_KEY = ["host-stats"] as const

interface HostStatsStreamEvent {
  data?: unknown
}

function isHostStats(value: unknown): value is HostStats {
  if (typeof value !== "object" || value === null) return false
  const stats = value as Record<string, unknown>
  const thresholds = stats.thresholds
  return (
    typeof stats.cpu_percent === "number" &&
    typeof stats.fetched_at === "number" &&
    typeof thresholds === "object" &&
    thresholds !== null &&
    Array.isArray(stats.alerts)
  )
}

interface WatchLease {
  clientId: string
  refs: number
  generation: number
  timer: ReturnType<typeof setInterval> | null
  live: boolean
  /** 403 is terminal until the last card unmounts and a new lease starts. */
  failed: boolean
  listeners: Set<() => void>
}

// Dashboard and monitoring can mount together. One clientId, one renew
// timer: the API lease key is userId+clientId, so a second POST would
// only add another watcher for the same tab.
let watchLease: WatchLease | null = null

function emitLease(lease: WatchLease): void {
  for (const listener of lease.listeners) listener()
}

function leaseIsLive(): boolean {
  return watchLease?.live === true
}

function serverLeaseIsLive(): boolean {
  return false
}

function stopLeaseTimer(lease: WatchLease): void {
  if (!lease.timer) return
  clearInterval(lease.timer)
  lease.timer = null
}

function releaseClient(clientId: string): void {
  void apiFetch("/host-stats/watch", {
    method: "DELETE",
    body: { clientId },
  }).catch(() => undefined)
}

async function renewLease(clientId: string, generation: number): Promise<void> {
  try {
    await apiFetch("/host-stats/watch", {
      method: "POST",
      body: { clientId },
    })
    const lease = watchLease
    if (
      !lease ||
      lease.generation !== generation ||
      lease.clientId !== clientId
    ) {
      releaseClient(clientId)
      return
    }
    if (!lease.live) {
      lease.live = true
      emitLease(lease)
    }
  } catch (error) {
    const lease = watchLease
    if (!lease || lease.generation !== generation) return
    if (lease.live) {
      lease.live = false
      emitLease(lease)
    }
    // 403: not an owner. Stop renewing and stay on the 15s poll.
    // 503 and anything else: keep the 20s retry, still on the poll,
    // and never surface a toast from this background lease.
    if (error instanceof ApiError && error.status === 403) {
      lease.failed = true
      stopLeaseTimer(lease)
      releaseClient(clientId)
    }
  }
}

function startLeaseTimer(lease: WatchLease): void {
  if (lease.failed || lease.timer) return
  const generation = lease.generation
  void renewLease(lease.clientId, generation)
  lease.timer = setInterval(() => {
    const active = watchLease
    if (!active || active.generation !== generation || active.failed) return
    void renewLease(active.clientId, generation)
  }, WATCH_INTERVAL_MS)
}

// crypto.randomUUID only exists in secure contexts; a plain-HTTP install
// (http://<ip>.sslip.io) must still get a lease id. getRandomValues does not
// have that restriction.
function newClientId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function retainLease(onChange: () => void): () => void {
  if (!watchLease) {
    watchLease = {
      clientId: newClientId(),
      refs: 0,
      generation: 1,
      timer: null,
      live: false,
      failed: false,
      listeners: new Set(),
    }
  }
  const lease = watchLease
  lease.refs += 1
  lease.listeners.add(onChange)
  startLeaseTimer(lease)
  return () => {
    const active = watchLease
    if (!active) return
    active.listeners.delete(onChange)
    active.refs -= 1
    if (active.refs > 0) return
    const clientId = active.clientId
    stopLeaseTimer(active)
    active.generation += 1
    active.live = false
    watchLease = null
    releaseClient(clientId)
  }
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange)
  return () => document.removeEventListener("visibilitychange", onChange)
}

function pageIsVisible(): boolean {
  return document.visibilityState === "visible"
}

function pageIsVisibleOnServer(): boolean {
  return false
}

function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    pageIsVisible,
    pageIsVisibleOnServer
  )
}

export function useHostStats(): {
  data: HostStats | undefined
  isLoading: boolean
  error: Error | null
} {
  const queryClient = useQueryClient()
  const streamOpen = useEventsStatus() === "open"
  const visible = usePageVisible()
  const followLive = streamOpen && visible

  const getSnapshot = useCallback(
    () => (followLive ? leaseIsLive() : false),
    [followLive]
  )
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!followLive) return () => {}
      return retainLease(onChange)
    },
    [followLive]
  )
  const watching = useSyncExternalStore(
    subscribe,
    getSnapshot,
    serverLeaseIsLive
  )

  const applyStats = useCallback(
    (event: unknown) => {
      if (typeof event !== "object" || event === null) return
      const data = (event as HostStatsStreamEvent).data
      if (!isHostStats(data)) return
      queryClient.setQueryData(QUERY_KEY, data)
    },
    [queryClient]
  )
  useEventsSubscription("host.stats", applyStats, followLive)

  const query = useQuery<HostStats>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch<HostStats>("/host-stats"),
    refetchInterval: watching ? false : POLL_INTERVAL_MS,
    staleTime: 5_000,
    retry: 1,
  })

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error,
  }
}
