// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stripe cannot send Ploydok's browser CSRF token. Only its exact signed
 * webhook endpoint is exempt; sibling paths and other methods remain covered
 * by the global double-submit protection.
 */
export function isStripeWebhookRequest(method: string, path: string): boolean {
  return method === "POST" && path === "/stripe"
}

/**
 * MCP clients authenticate with a Bearer token they send explicitly, never
 * with ambient cookies, so a cross-site page cannot forge their requests.
 * The exemption is exact on method and path, and refused when a session
 * cookie rides along: a Bearer header must not unlock a cookie request.
 */
export function isMcpRequest(
  method: string,
  path: string,
  headers: Headers
): boolean {
  if (method !== "POST" || path !== "/mcp") return false
  if (!headers.get("authorization")?.startsWith("Bearer ")) return false
  const cookie = headers.get("cookie") ?? ""
  return !/(?:^|;\s*)ploydok_(?:access|refresh)=/.test(cookie)
}
