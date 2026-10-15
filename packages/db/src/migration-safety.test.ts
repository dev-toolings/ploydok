// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { assertNoCaseInsensitiveAppDomainDuplicates } from "./migration-safety"

function fakeSql(responses: unknown[]): { calls: number; sql: unknown } {
  const state = { calls: 0, sql: null as unknown }
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    state.calls++
    state.sql = { strings: [...strings], values }
    return Promise.resolve(responses.shift() ?? [])
  }
  state.sql = sql
  return state
}

describe("assertNoCaseInsensitiveAppDomainDuplicates", () => {
  it("continues on a fresh database before the apps table exists", async () => {
    const fake = fakeSql([[{ exists: false }]])

    await expect(
      assertNoCaseInsensitiveAppDomainDuplicates(fake.sql as never)
    ).resolves.toBeUndefined()
    expect(fake.calls).toBe(1)
  })

  it("reports duplicate legacy hostnames without modifying data", async () => {
    const fake = fakeSql([
      [{ exists: true }],
      [{ exists: true }],
      [
        {
          hostname: "apps.example.com",
          app_ids: ["app-a", "app-b"],
          duplicate_count: 2,
        },
      ],
    ])

    await expect(
      assertNoCaseInsensitiveAppDomainDuplicates(fake.sql as never)
    ).rejects.toThrow(
      /duplicate hostnames were found: apps\.example\.com \(app ids: app-a, app-b\)/
    )
    expect(fake.calls).toBe(3)
  })

  it("allows a clean legacy table", async () => {
    const fake = fakeSql([[{ exists: true }], [{ exists: true }], []])

    await expect(
      assertNoCaseInsensitiveAppDomainDuplicates(fake.sql as never)
    ).resolves.toBeUndefined()
    expect(fake.calls).toBe(3)
  })
})
