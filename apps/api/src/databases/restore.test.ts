// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock } from "bun:test"
import type { Db } from "@ploydok/db"

const restoreDatabaseMock = mock(async () => ({ ok: true as const }))

mock.module("../logger", () => ({
  childLogger: () => ({
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

mock.module("../debug/singletons", () => ({
  getSharedAgent: () => ({ restoreDatabase: restoreDatabaseMock }),
}))

mock.module("../storage/s3", () => ({
  createS3Client: mock(() => ({})),
  downloadStream: mock(async () => {
    throw new Error("download must not be reached")
  }),
}))

mock.module("../secrets/crypto", () => ({
  decryptSecret: mock(async () => {
    throw new Error("secret decryption must not be reached")
  }),
}))

const { runRestore } = await import("./restore")

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(result),
    then: (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled),
  }
  return chain
}

function buildDb(selectResults: unknown[]) {
  const db = {
    select: mock(() => makeSelectChain(selectResults.shift() ?? [])),
  }
  return { db: db as unknown as Db, select: db.select }
}

describe("runRestore ownership", () => {
  it("rejects a backup belonging to another database before reading or restoring it", async () => {
    restoreDatabaseMock.mockClear()
    const { db, select } = buildDb([
      [
        {
          id: "backup-b",
          database_id: "db-b",
          status: "succeeded",
          location: "/path/that-must-not-be-read.dump",
        },
      ],
    ])

    await expect(
      runRestore(db, {
        backupId: "backup-b",
        databaseId: "db-a",
        ageIdentity: "AGE-PRIVATE-KEY-MUST-NOT-BE-USED",
      })
    ).rejects.toThrow("Backup backup-b does not belong to database db-a")

    expect(select).toHaveBeenCalledTimes(1)
    expect(restoreDatabaseMock).not.toHaveBeenCalled()
  })
})
