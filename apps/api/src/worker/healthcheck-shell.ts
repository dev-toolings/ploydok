// SPDX-License-Identifier: AGPL-3.0-only

/** Agent-owned HTTP healthcheck, translated to Docker CMD plus a static probe.
 * The agent owns the shell fallback too, so callers cannot supply shell code.
 * Older agents reject this mode explicitly rather than silently losing the gate.
 */
export function healthcheckTest(port: number, path: string): string[] {
  return ["PLOYDOK-HTTP", String(port), path]
}
