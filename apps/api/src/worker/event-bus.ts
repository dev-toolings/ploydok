// SPDX-License-Identifier: AGPL-3.0-only
//
// EventBus — in-memory pub/sub with per-channel ring-buffer replay.
//
// Channels:
//   user:{userId}        — structured notification events for a user
//                          (also carries container health + provider sync)
//
// Usage:
//   import { eventBus } from "./event-bus";
//   eventBus.publish("user:abc123", { type: "build.started", appId: "x", message: "Build queued" });
//   const unsub = eventBus.subscribe("user:abc123", (event) => ws.send(JSON.stringify(event)));
//   const history = eventBus.replay("user:abc123", 20);
//   unsub();

import { nanoid } from "nanoid"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationType =
  | "host.stats"
  | "build.started"
  | "build.succeeded"
  | "build.failed"
  | "build.cancelled"
  | "deploy.status_change"
  | "container.health"
  | "provider.sync.started"
  | "provider.sync.progress"
  | "provider.sync.completed"
  | "provider.sync.failed"
  | "app.delete.queued"
  | "app.deleted"
  | "app.delete.failed"
  | "app.stop.queued"
  | "app.stopped"
  | "app.stop.failed"

export interface NotificationEvent {
  id: string
  type: NotificationType
  appId?: string
  buildId?: string
  message: string
  /** Unix timestamp in milliseconds */
  t: number
  /** Additional free-form payload (e.g. used by container.health) */
  data?: Record<string, unknown>
}

type Subscriber = (event: NotificationEvent) => void

// ---------------------------------------------------------------------------
// RingBuffer — fixed-capacity FIFO, overwrites oldest entry when full.
// ---------------------------------------------------------------------------

class RingBuffer {
  private readonly buf: NotificationEvent[]
  private readonly cap: number
  private head = 0
  private size = 0

  constructor(capacity: number) {
    this.cap = capacity
    this.buf = new Array<NotificationEvent>(capacity)
  }

  push(event: NotificationEvent): void {
    this.buf[this.head] = event
    this.head = (this.head + 1) % this.cap
    if (this.size < this.cap) this.size++
  }

  /** Returns up to `limit` most recent entries in insertion order. */
  snapshot(limit: number): NotificationEvent[] {
    const count = Math.min(limit, this.size)
    const out: NotificationEvent[] = new Array(count)
    for (let i = 0; i < count; i++) {
      // Walk backwards from (head - 1), then re-order chronologically.
      const idx = (this.head - count + i + this.cap * 2) % this.cap
      out[i] = this.buf[idx]!
    }
    return out
  }

  get length(): number {
    return this.size
  }
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

const RING_CAPACITY = 50

export class EventBus {
  private readonly rings = new Map<string, RingBuffer>()
  private readonly subs = new Map<string, Set<Subscriber>>()

  /**
   * Publish a notification event to the given channel.
   * `id` and `t` are auto-generated if absent.
   * The event is stored in the ring-buffer and forwarded to all live subscribers.
   */
  publish(
    channel: string,
    event: Omit<NotificationEvent, "id" | "t"> &
      Partial<Pick<NotificationEvent, "id" | "t">>
  ): void {
    this.deliver(channel, event, true)
  }

  /** Deliver live data without storing it in notification replay history. */
  publishEphemeral(
    channel: string,
    event: Omit<NotificationEvent, "id" | "t"> &
      Partial<Pick<NotificationEvent, "id" | "t">>
  ): void {
    this.deliver(channel, event, false)
  }

  private deliver(
    channel: string,
    event: Omit<NotificationEvent, "id" | "t"> &
      Partial<Pick<NotificationEvent, "id" | "t">>,
    persist: boolean
  ): void {
    const full: NotificationEvent = {
      id: event.id ?? nanoid(),
      t: event.t ?? Date.now(),
      type: event.type,
      message: event.message,
      ...(event.appId !== undefined && { appId: event.appId }),
      ...(event.buildId !== undefined && { buildId: event.buildId }),
      ...(event.data !== undefined && { data: event.data }),
    }

    if (persist) {
      let ring = this.rings.get(channel)
      if (!ring) {
        ring = new RingBuffer(RING_CAPACITY)
        this.rings.set(channel, ring)
      }
      ring.push(full)
    }

    // Notify all current subscribers.
    const set = this.subs.get(channel)
    if (set) {
      for (const cb of set) {
        try {
          cb(full)
        } catch {
          // Individual subscriber errors must not crash the bus.
        }
      }
    }
  }

  /**
   * Subscribe to a channel.
   * Returns an unsubscribe function — always call it when done to avoid memory leaks.
   */
  subscribe(channel: string, cb: Subscriber): () => void {
    let set = this.subs.get(channel)
    if (!set) {
      set = new Set<Subscriber>()
      this.subs.set(channel, set)
    }
    set.add(cb)

    return () => {
      const s = this.subs.get(channel)
      if (s) {
        s.delete(cb)
        if (s.size === 0) this.subs.delete(channel)
      }
    }
  }

  /**
   * Replay the last `limit` events for a channel.
   * Returns an empty array if no events have been published on that channel yet.
   */
  replay(channel: string, limit = 20): NotificationEvent[] {
    const ring = this.rings.get(channel)
    if (!ring) return []
    return ring.snapshot(limit)
  }

  /**
   * Drop the ring-buffer for a channel (e.g. after a user session ends).
   * Existing subscribers are NOT affected.
   */
  evict(channel: string): void {
    this.rings.delete(channel)
  }

  /** Number of active subscribers across all channels. */
  get subscriberCount(): number {
    let n = 0
    for (const set of this.subs.values()) n += set.size
    return n
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const eventBus = new EventBus()
