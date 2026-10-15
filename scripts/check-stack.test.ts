// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test"
import {
  buildSetupUrl,
  checkServices,
  checkSetupToken,
  parseComposePs,
  parseEnvFile,
  setupTokenRequired,
  summarize,
} from "./check-stack"

const psLine = (service: string, state: string, health = ""): string =>
  JSON.stringify({ Service: service, State: state, Health: health })

describe("parseEnvFile", () => {
  test("keeps values containing '=' intact", () => {
    const env = parseEnvFile(
      "DATABASE_URL=postgres://u:p==@127.0.0.1:5434/ploydok\n"
    )
    expect(env.get("DATABASE_URL")).toBe(
      "postgres://u:p==@127.0.0.1:5434/ploydok"
    )
  })

  test("skips comments and blank lines", () => {
    const env = parseEnvFile("# comment\n\nMASTER_KEY=abc\n")
    expect([...env.keys()]).toEqual(["MASTER_KEY"])
  })

  test("strips surrounding quotes", () => {
    expect(parseEnvFile('SESSION_SECRET="abc"').get("SESSION_SECRET")).toBe(
      "abc"
    )
  })
})

describe("setupTokenRequired", () => {
  test("defaults to false when the key is absent", () => {
    expect(setupTokenRequired(undefined)).toBe(false)
  })

  test("mirrors the Zod coercion of apps/api/src/env.ts", () => {
    expect(setupTokenRequired("0")).toBe(false)
    expect(setupTokenRequired("false")).toBe(false)
    expect(setupTokenRequired(" ON ")).toBe(true)
    expect(setupTokenRequired("1")).toBe(true)
  })
})

describe("checkSetupToken", () => {
  test("fails when the token is missing but required", () => {
    expect(checkSetupToken(true, undefined).level).toBe("fail")
  })

  test("fails on a token the API would silently ignore", () => {
    const check = checkSetupToken(true, "short")
    expect(check.level).toBe("fail")
    expect(check.detail).toContain("minimum 16")
  })

  test("accepts a 64-char hex token", () => {
    expect(checkSetupToken(true, "a".repeat(64)).level).toBe("ok")
  })

  test("accepts an open setup when the gate is disabled", () => {
    expect(checkSetupToken(false, undefined).level).toBe("ok")
  })
})

describe("parseComposePs", () => {
  test("reads NDJSON and ignores unparsable lines", () => {
    const statuses = parseComposePs(
      [psLine("postgres", "running", "healthy"), "not json", ""].join("\n")
    )
    expect(statuses.size).toBe(1)
    expect(statuses.get("postgres")).toEqual({
      state: "running",
      health: "healthy",
    })
  })
})

describe("checkServices", () => {
  test("fails on a missing service", () => {
    const check = checkServices(new Map(), ["postgres"])
    expect(check.level).toBe("fail")
    expect(check.detail).toContain("postgres (absent)")
  })

  test("fails on an unhealthy service", () => {
    const statuses = parseComposePs(psLine("redis", "running", "unhealthy"))
    expect(checkServices(statuses, ["redis"]).level).toBe("fail")
  })

  test("points a crashed container at its logs, not at infra-up", () => {
    const statuses = parseComposePs(psLine("buildkitd", "exited"))
    const check = checkServices(statuses, ["buildkitd"])
    expect(check.level).toBe("fail")
    expect(check.detail).toContain("buildkitd (exited)")
    expect(check.detail).toContain("logs buildkitd")
    expect(check.detail).not.toContain("infra-up")
  })

  test("warns while a healthcheck is still starting", () => {
    const statuses = parseComposePs(psLine("agent", "running", "starting"))
    expect(checkServices(statuses, ["agent"]).level).toBe("warn")
  })

  test("accepts a running service without a healthcheck", () => {
    const statuses = parseComposePs(psLine("buildkitd", "running"))
    expect(checkServices(statuses, ["buildkitd"]).level).toBe("ok")
  })
})

describe("buildSetupUrl", () => {
  test("appends the token when nothing else can carry it", () => {
    expect(buildSetupUrl("http://localhost:5173", true, "tok", false)).toBe(
      "http://localhost:5173/setup?token=tok"
    )
  })

  test("omits the query string when the gate is off", () => {
    expect(buildSetupUrl("http://localhost:5173", false, "tok", false)).toBe(
      "http://localhost:5173/setup"
    )
  })

  test("omits the token when the API grants a setup cookie", () => {
    expect(buildSetupUrl("http://localhost:5173", true, "tok", true)).toBe(
      "http://localhost:5173/setup"
    )
  })
})

describe("summarize", () => {
  test("counts failures and warnings separately", () => {
    expect(
      summarize([
        { level: "ok", detail: "" },
        { level: "warn", detail: "" },
        { level: "fail", detail: "" },
        { level: "fail", detail: "" },
      ])
    ).toEqual({ failed: 2, warned: 1 })
  })
})
