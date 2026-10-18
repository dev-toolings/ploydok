// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildOutcome, parseEnvFile, pickBuild, readConfig } from "./smoke"

const build = (id: string, createdAt: number, status = "running") => ({
  id,
  status,
  createdAt,
  errorMessage: null,
})

describe("pickBuild", () => {
  test("ignores builds created before the deploy request", () => {
    expect(pickBuild([build("old", 900)], 1_000)).toBeUndefined()
  })

  test("takes the newest build of the request window", () => {
    const picked = pickBuild(
      [build("a", 1_100), build("b", 1_300), build("old", 500)],
      1_000
    )
    expect(picked?.id).toBe("b")
  })
})

describe("buildOutcome", () => {
  test("classifies terminal and running statuses", () => {
    expect(buildOutcome("succeeded")).toBe("succeeded")
    expect(buildOutcome("succeeded_with_warning")).toBe("succeeded")
    expect(buildOutcome("failed")).toBe("failed")
    expect(buildOutcome("cancelled")).toBe("failed")
    expect(buildOutcome("running")).toBe("pending")
  })
})

describe("readConfig", () => {
  test("is null until origin, app and token are all set", () => {
    expect(
      readConfig({
        PLOYDOK_SMOKE_URL: "http://staging.test",
        PLOYDOK_SMOKE_ENV_FILE: "/nonexistent",
      })
    ).toBeNull()
  })

  test("trims the trailing slash of the origin", () => {
    expect(
      readConfig({
        PLOYDOK_SMOKE_URL: "http://staging.test/",
        PLOYDOK_SMOKE_APP_ID: "app1",
        PLOYDOK_SMOKE_TOKEN: "plk_x",
        PLOYDOK_SMOKE_ENV_FILE: "/nonexistent",
      })
    ).toEqual({ origin: "http://staging.test", appId: "app1", token: "plk_x" })
  })
})

describe("smoke.env", () => {
  test("is read as data and overridden by the environment", () => {
    const file = join(tmpdir(), `smoke-${crypto.randomUUID()}.env`)
    writeFileSync(
      file,
      '# staging\nPLOYDOK_SMOKE_URL="http://from-file.test"\nPLOYDOK_SMOKE_APP_ID=file-app\nPLOYDOK_SMOKE_TOKEN=plk_file\n'
    )
    expect(parseEnvFile("A=1\n# B=2\n")).toEqual({ A: "1" })
    expect(
      readConfig({
        PLOYDOK_SMOKE_ENV_FILE: file,
        PLOYDOK_SMOKE_APP_ID: "env-app",
      })
    ).toEqual({
      origin: "http://from-file.test",
      appId: "env-app",
      token: "plk_file",
    })
  })
})
