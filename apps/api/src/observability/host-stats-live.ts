// SPDX-License-Identifier: AGPL-3.0-only
import type { HostStatsResponse } from "@ploydok/agent-proto"
import { getSharedAgent } from "../debug/singletons"
import { childLogger } from "../logger"
import { eventBus, type EventBus } from "../worker/event-bus"
import { buildHostStatsBody, type HostStatsBody } from "./host-stats-body"

const log = childLogger("host-stats.live")
const LEASE_MS = 45_000
const INTERVAL_MS = 2000

interface Dependencies {
  fetch: () => Promise<HostStatsResponse>
  bus: Pick<EventBus, "publishEphemeral">
  now: () => number
  schedule: (tick: () => void, intervalMs: number) => () => void
  warn: (error: unknown) => void
}

/** One collector shared by all owner tabs, active only while leases exist. */
export class HostStatsLive {
  private readonly leases = new Map<string, Map<string, number>>()
  private stopTimer: (() => void) | undefined
  private snapshot?: HostStatsBody
  private collecting = false
  private lastWarning = -Infinity

  constructor(private readonly deps: Dependencies) {}

  renew(userId: string, clientId: string): void {
    this.prune()
    let clients = this.leases.get(userId)
    if (!clients) {
      clients = new Map()
      this.leases.set(userId, clients)
    }
    clients.set(clientId, this.deps.now() + LEASE_MS)
    if (!this.stopTimer) {
      this.stopTimer = this.deps.schedule(() => {
        void this.tick()
      }, INTERVAL_MS)
    }
  }

  release(userId: string, clientId: string): void {
    this.leases.get(userId)?.delete(clientId)
    this.prune()
  }

  freshSnapshot(): HostStatsBody | undefined {
    return this.snapshot && this.deps.now() - this.snapshot.fetched_at < 3000
      ? this.snapshot
      : undefined
  }

  private prune(): void {
    const now = this.deps.now()
    for (const [userId, clients] of this.leases) {
      for (const [clientId, expires] of clients) {
        if (expires <= now) clients.delete(clientId)
      }
      if (!clients.size) this.leases.delete(userId)
    }
    if (!this.leases.size) {
      this.stopTimer?.()
      this.stopTimer = undefined
    }
  }

  async tick(): Promise<void> {
    this.prune()
    if (!this.leases.size || this.collecting) return
    this.collecting = true
    try {
      const response = await this.deps.fetch()
      this.prune()
      if (!this.leases.size) return
      this.snapshot = buildHostStatsBody(response, this.deps.now())
      for (const userId of this.leases.keys()) {
        this.deps.bus.publishEphemeral(`user:${userId}`, {
          type: "host.stats",
          message: "",
          t: this.snapshot.fetched_at,
          data: { ...this.snapshot },
        })
      }
    } catch (error) {
      if (this.deps.now() - this.lastWarning >= 30_000) {
        this.lastWarning = this.deps.now()
        this.deps.warn(error)
      }
    } finally {
      this.collecting = false
    }
  }
}

export const hostStatsLive = new HostStatsLive({
  fetch: () => getSharedAgent().hostStats({}, 1500),
  bus: eventBus,
  now: Date.now,
  schedule: (tick, intervalMs) => {
    const timer = setInterval(tick, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  },
  warn: (err) => log.warn({ err }, "host_stats.live_failed"),
})
