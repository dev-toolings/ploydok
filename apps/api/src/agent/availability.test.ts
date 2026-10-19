// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from "bun:test"
import { Metadata, type ServiceError } from "@grpc/grpc-js"
import type { Logger } from "pino"
import { AgentError, GrpcStatus } from "./errors"
import {
  getAgentAvailability,
  logAgentDependentFailure,
  noteAgentReachable,
  noteAgentUnavailable,
  resetAgentAvailabilityForTests,
} from "./availability"

function agentError(code: number, details: string): AgentError {
  const cause = Object.assign(new Error(details), {
    code,
    details,
    metadata: new Metadata(),
  }) as ServiceError
  return new AgentError(cause)
}

function recordingLogger() {
  const calls: Array<{ level: string; fields: Record<string, unknown> }> = []
  const record =
    (level: string) => (fields: Record<string, unknown>, _msg: string) => {
      calls.push({ level, fields })
    }
  const logger = { debug: record("debug"), warn: record("warn") }
  return { calls, logger: logger as unknown as Logger }
}

describe("agent availability", () => {
  beforeEach(() => resetAgentAvailabilityForTests())

  it("tracks one down period across repeated failures and recovers", () => {
    const enoent = agentError(GrpcStatus.UNAVAILABLE, "connect ENOENT")
    noteAgentUnavailable(enoent, 1_000)
    noteAgentUnavailable(enoent, 6_000)
    expect(getAgentAvailability()).toMatchObject({
      state: "down",
      since: 1_000,
    })

    noteAgentReachable(10_000)
    expect(getAgentAvailability()).toMatchObject({
      state: "up",
      since: 10_000,
      lastError: null,
    })
  })

  it("logs an unreachable agent as a one-line debug, other errors with err", () => {
    const { calls, logger } = recordingLogger()
    logAgentDependentFailure(
      logger,
      agentError(GrpcStatus.UNAVAILABLE, "connect ENOENT"),
      { tick: 1 },
      "job failed"
    )
    const internal = agentError(GrpcStatus.INTERNAL, "boom")
    logAgentDependentFailure(logger, internal, { tick: 2 }, "job failed")

    expect(calls).toEqual([
      { level: "debug", fields: { tick: 1, agent: "unavailable" } },
      { level: "warn", fields: { tick: 2, err: internal } },
    ])
  })
})
