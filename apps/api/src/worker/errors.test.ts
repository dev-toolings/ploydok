// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { Metadata } from "@grpc/grpc-js"
import { AgentError, GrpcStatus } from "../agent/errors"
import {
  TransientDeployError,
  FatalDeployError,
  classifyAgentError,
} from "./errors"

describe("classifyAgentError", () => {
  it("classifies agent invalid arguments and policy refusals as fatal through causes", () => {
    for (const code of [GrpcStatus.INVALID_ARGUMENT, GrpcStatus.PERMISSION_DENIED, GrpcStatus.UNAUTHENTICATED]) {
      const original = new AgentError(Object.assign(new Error("refused"), {
        code, details: "policy refusal", metadata: new Metadata(),
      }))
      expect(classifyAgentError(original)).toBeInstanceOf(FatalDeployError)
      const wrapped = new Error("Failed to create pre_deploy hook container", { cause: original })
      expect(classifyAgentError(wrapped)).toBeInstanceOf(FatalDeployError)
      expect(classifyAgentError(wrapped).cause).toBe(wrapped)
    }
  })

  it("recognizes legacy string-wrapped invalid argument and policy errors", () => {
    for (const message of [
      "Failed to create pre_deploy hook container: [agent] code gRPC 3 : container_name_prefix",
      "3 INVALID_ARGUMENT: invalid name",
      "[agent] action refusée par allowlist",
    ]) {
      expect(classifyAgentError(new Error(message))).toBeInstanceOf(FatalDeployError)
    }
  })

  it("keeps agent availability failures transient and handles circular causes", () => {
    const original = new AgentError(Object.assign(new Error("offline"), {
      code: GrpcStatus.UNAVAILABLE, details: "offline", metadata: new Metadata(),
    }))
    const wrapped = new Error("hook creation failed", { cause: original })
    expect(classifyAgentError(wrapped)).toBeInstanceOf(TransientDeployError)
    const circular = new Error("unknown")
    circular.cause = circular
    expect(classifyAgentError(circular)).toBeInstanceOf(TransientDeployError)
  })

  // ── Transient ──────────────────────────────────────────────────────────────

  it("classifies ECONNREFUSED as transient", () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:2375")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("classifies ETIMEDOUT as transient", () => {
    const err = new Error("connect ETIMEDOUT")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("classifies ECONNRESET as transient", () => {
    const err = new Error("read ECONNRESET")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("classifies gRPC UNAVAILABLE as transient", () => {
    const err = new Error("14 UNAVAILABLE: No connection established")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("classifies gRPC DEADLINE_EXCEEDED as transient", () => {
    const err = new Error("4 DEADLINE_EXCEEDED: Deadline exceeded")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("classifies Redis timeout as transient", () => {
    const err = new Error("redis connection timeout")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("classifies Docker registry 500 as transient", () => {
    const err = new Error("docker registry responded with 500")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("classifies socket hang up as transient", () => {
    const err = new Error("socket hang up")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  // ── Fatal ──────────────────────────────────────────────────────────────────

  it("classifies Dockerfile parse error as fatal", () => {
    const err = new Error("dockerfile parse error: invalid syntax at line 3")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies nixpacks failed as fatal", () => {
    const err = new Error("nixpacks failed: cannot detect runtime")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies image manifest not found as fatal", () => {
    const err = new Error("manifest unknown: manifest unknown")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies image not found as fatal", () => {
    const err = new Error("image not found: nginx:999")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies registry 401 unauthorized as fatal", () => {
    const err = new Error("unauthorized registry: authentication required")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies registry denied (403) as fatal", () => {
    const err = new Error("denied registry: access denied")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies no such image as fatal", () => {
    const err = new Error("no such image: alpine:does-not-exist")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies app not found as fatal", () => {
    const err = new Error("App not found: abc123")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies missing repo_full_name as fatal", () => {
    const err = new Error("App abc has no repo_full_name — missing repo_full_name")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies image_ref missing as fatal", () => {
    const err = new Error("App abc has git_provider='image' but no image_ref set")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies EACCES as fatal", () => {
    const err = new Error(
      "EACCES: permission denied, mkdir '/var/lib/ploydok/static/app-1'"
    )
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  it("classifies a read-only filesystem as fatal", () => {
    const err = new Error("EROFS: read-only file system, mkdir '/.ploydok-dev'")
    expect(classifyAgentError(err)).toBeInstanceOf(FatalDeployError)
  })

  // ── Default (unknown) ──────────────────────────────────────────────────────

  it("defaults unknown errors to transient", () => {
    const err = new Error("some completely unknown failure")
    expect(classifyAgentError(err)).toBeInstanceOf(TransientDeployError)
  })

  it("handles non-Error values", () => {
    const result = classifyAgentError("string error")
    expect(result).toBeInstanceOf(TransientDeployError)
  })

  // ── Cause preservation ─────────────────────────────────────────────────────

  it("preserves original error as cause", () => {
    const original = new Error("ECONNREFUSED")
    const classified = classifyAgentError(original)
    expect(classified.cause).toBe(original)
  })

  it("preserves message from original error", () => {
    const original = new Error("connect ECONNREFUSED 127.0.0.1:2375")
    const classified = classifyAgentError(original)
    expect(classified.message).toBe(original.message)
  })
  it("ignores application output quoted in a rollout failure", () => {
    // Without classifyMessage the app's "permission denied" line would make
    // the failure fatal; only the Ploydok summary decides.
    const summary =
      "Swarm service x did not reach 1 healthy task(s): task a state=exited exit=1"
    const err = Object.assign(
      new Error(
        `${summary}\nLast container output:\nError: open /data/db: permission denied`
      ),
      { classifyMessage: summary }
    )
    const classified = classifyAgentError(err)
    expect(classified).toBeInstanceOf(TransientDeployError)
    expect(classified.message).toContain("open /data/db: permission denied")
  })
})
