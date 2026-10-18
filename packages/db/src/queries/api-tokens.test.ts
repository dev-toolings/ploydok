// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from "bun:test"
import { createHash } from "crypto"
import { PgDialect } from "drizzle-orm/pg-core"
import type { SQL } from "drizzle-orm"
import type { Db } from "../client"
import { getActiveToken } from "./api-tokens"

describe("api-tokens", () => {
  it("hashes token consistently", () => {
    const token = "ploy_test1234567890"
    const hash1 = createHash("sha256").update(token).digest("hex")
    const hash2 = createHash("sha256").update(token).digest("hex")
    expect(hash1).toBe(hash2)
  })

  it("generates different hashes for different tokens", () => {
    const token1 = "ploy_test1234567890"
    const token2 = "ploy_test0987654321"
    const hash1 = createHash("sha256").update(token1).digest("hex")
    const hash2 = createHash("sha256").update(token2).digest("hex")
    expect(hash1).not.toBe(hash2)
  })

  it("getActiveToken accepts tokens whose expiry is NULL or in the future", async () => {
    let where: SQL | undefined
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: (cond: SQL) => {
            where = cond
            return Promise.resolve([])
          },
        }),
      }),
    } as unknown as Db
    const before = Date.now()
    await getActiveToken(fakeDb, "hash")
    const query = new PgDialect().sqlToQuery(where as SQL)
    expect(query.sql).toMatch(
      /\("api_tokens"\."expires_at" is null or "api_tokens"\."expires_at" > \$\d+\)/
    )
    const bound = query.params.at(-1) as Date | string
    expect(new Date(bound).getTime()).toBeGreaterThanOrEqual(before)
  })
})
