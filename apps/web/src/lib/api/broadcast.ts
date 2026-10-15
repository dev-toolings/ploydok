// SPDX-License-Identifier: AGPL-3.0-only
// Client-only. BroadcastChannel does not exist in Node SSR — every export is
// guarded by typeof window !== "undefined" so this module is safe to import
// from isomorphic code.

const CHANNEL_NAME = "ploydok-auth"

export type AuthEvent =
  | { type: "token_refreshed" }
  | { type: "logged_out" }

let _channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null
  if (typeof BroadcastChannel === "undefined") return null
  if (_channel) return _channel
  _channel = new BroadcastChannel(CHANNEL_NAME)
  return _channel
}

// postMessage on a BroadcastChannel does NOT deliver to the sender. Other tabs
// (same origin) receive it via their `message` listener.
export function broadcastAuthEvent(event: AuthEvent): void {
  const ch = getChannel()
  if (!ch) return
  try {
    ch.postMessage(event)
  } catch {
    // ignore — closed channel or serialization edge
  }
}

interface AuthEventHandlers {
  onTokenRefreshed: () => void
  onLoggedOut: () => void
}

// Returns a cleanup function.
export function subscribeAuthEvents(handlers: AuthEventHandlers): () => void {
  const ch = getChannel()
  if (!ch) return () => undefined
  const listener = (e: MessageEvent<AuthEvent>): void => {
    const data: unknown = e.data
    if (!data || typeof data !== "object" || !("type" in data)) return
    const type = data.type
    if (type === "token_refreshed") handlers.onTokenRefreshed()
    else if (type === "logged_out") handlers.onLoggedOut()
  }
  ch.addEventListener("message", listener)
  return () => ch.removeEventListener("message", listener)
}

// Test-only: drops the cached singleton so tests can install a fake
// BroadcastChannel and re-create the channel from scratch.
export function __resetChannelForTests(): void {
  if (_channel) {
    try {
      _channel.close()
    } catch {
      // ignore
    }
  }
  _channel = null
}
