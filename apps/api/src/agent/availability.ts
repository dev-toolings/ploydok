// SPDX-License-Identifier: AGPL-3.0-only
import type { Logger } from "pino"
import { childLogger } from "../logger"
import { AgentError, GrpcStatus } from "./errors"

// Process-wide view of agent reachability, fed by every unary call in the
// wrapper. An agent that is starting, restarting or compiling is a state, not
// an error: it is logged once when it goes down and once when it comes back,
// so pollers do not each print a stack trace per tick.

export type AgentAvailabilityState = "unknown" | "up" | "down"

export interface AgentAvailability {
  state: AgentAvailabilityState
  since: number
  lastError: string | null
}

const log = childLogger("agent")

let current: AgentAvailability = {
  state: "unknown",
  since: Date.now(),
  lastError: null,
}

export function isAgentUnavailable(err: unknown): err is AgentError {
  return err instanceof AgentError && err.code === GrpcStatus.UNAVAILABLE
}

export function noteAgentReachable(now: number = Date.now()): void {
  if (current.state === "up") return
  if (current.state === "down") {
    log.info({ downForMs: now - current.since }, "agent available again")
  }
  current = { state: "up", since: now, lastError: null }
}

export function noteAgentUnavailable(
  err: AgentError,
  now: number = Date.now()
): void {
  if (current.state === "down") {
    current = { ...current, lastError: err.details }
    return
  }
  log.warn({ code: err.code, details: err.details }, "agent unavailable")
  current = { state: "down", since: now, lastError: err.details }
}

export function getAgentAvailability(): AgentAvailability {
  return { ...current }
}

/**
 * Logs a failure of a periodic job that depends on the agent. When the agent
 * is unreachable the transition is already reported by this module, so the
 * job only leaves a one-line debug trace instead of a full error.
 */
export function logAgentDependentFailure(
  logger: Logger,
  err: unknown,
  fields: Record<string, unknown>,
  message: string
): void {
  if (isAgentUnavailable(err)) {
    logger.debug({ ...fields, agent: "unavailable" }, message)
    return
  }
  logger.warn({ ...fields, err }, message)
}

export function resetAgentAvailabilityForTests(): void {
  current = { state: "unknown", since: Date.now(), lastError: null }
}
