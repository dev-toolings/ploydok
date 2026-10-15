// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, mock, beforeEach } from "bun:test"
import { Hono } from "hono"
import { Readable } from "node:stream"
import type { Db } from "@ploydok/db"

const uploadStream = mock(async () => undefined)
const downloadStream = mock(async () => Readable.from(["witness"]))
const deleteObject = mock(async () => undefined)
const headObject = mock(async () => ({ size: 7, lastModified: new Date() }))
const listObjects = mock(async () => [])
const putObject = mock(async (..._args: unknown[]) => undefined)
const createS3Client = mock(() => ({}) as never)

mock.module("../auth/require-role", () => ({
  requireRole: () => async (_c: unknown, next: () => Promise<unknown>) => next(),
}))
mock.module("../auth/require-scope", () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<unknown>) => next(),
}))
mock.module("../github/app-credentials", () => ({
  encryptField: mock(async () => ({ enc: Buffer.from("encrypted"), nonce: Buffer.from("nonce") })),
}))
mock.module("../secrets/crypto", () => ({
  decryptSecret: mock(async () =>
    JSON.stringify({ accessKeyId: "access", secretAccessKey: "secret" })
  ),
}))
mock.module("../storage/s3", () => ({
  createS3Client,
  uploadStream,
  downloadStream,
  deleteObject,
  headObject,
  listObjects,
  putObject,
}))

const { createStorageDestinationsRouter } = await import("./storage-destinations")

const destination = {
  id: "destination-s3-test",
  org_id: "org-s3-test",
  name: "Witness destination",
  kind: "s3" as const,
  s3_endpoint: "https://s3.example.test",
  s3_bucket: "backups",
  s3_region: "auto",
  credentials_secret_id: "destination-secret",
  last_test_at: null,
  last_test_status: null,
  last_test_error: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  updated_at: new Date("2026-01-01T00:00:00Z"),
}

function fakeDb() {
  const state = {
    selectCalls: 0,
    updated: [] as Array<Record<string, unknown>>,
  }
  const db = {
    select: mock(() => {
      state.selectCalls += 1
      const result = state.selectCalls === 1
        ? [destination]
        : state.selectCalls === 2
          ? [{ id: "destination-secret", value_ciphertext: Buffer.from("cipher"), nonce: Buffer.from("nonce") }]
          : [{ count: "0" }]
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => result,
      }
      return chain
    }),
    update: mock(() => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.updated.push(values)
          return {
            returning: async () => [{ ...destination, ...values }],
          }
        },
      }),
    })),
  }
  return { db: db as unknown as Db, state }
}

function testApp(db: Db) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(c as any).set("user", {
      id: "user-s3-test",
      email: "user-s3-test@example.invalid",
      display_name: "S3 Test",
      session_id: "session-s3-test",
    })
    await next()
  })
  app.route("/orgs", createStorageDestinationsRouter(db))
  return app
}

function testRequest(): Request {
  return new Request(
    "http://localhost/orgs/org-s3-test/storage-destinations/destination-s3-test/test",
    { method: "POST" }
  )
}

describe("S3 destination witness testing", () => {
  beforeEach(() => {
    let storedWitness = ""
    uploadStream.mockReset()
    downloadStream.mockReset()
    deleteObject.mockReset()
    headObject.mockReset()
    listObjects.mockReset()
    putObject.mockReset()
    createS3Client.mockReset()
    uploadStream.mockResolvedValue(undefined)
    putObject.mockImplementation(async (...args: unknown[]) => {
      storedWitness = String(args[3])
    })
    downloadStream.mockImplementation(async () => Readable.from([storedWitness]))
    deleteObject.mockResolvedValue(undefined)
    createS3Client.mockReturnValue({ destroy: mock(() => undefined) } as never)
  })

  it("writes, reads, and deletes the witness object", async () => {
    const { db } = fakeDb()
    const response = await testApp(db).request(testRequest())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
    expect(putObject).toHaveBeenCalledTimes(1)
    expect(downloadStream).toHaveBeenCalledTimes(1)
    expect(deleteObject).toHaveBeenCalledTimes(1)
  })

  it("attempts cleanup when reading the witness fails and records failure", async () => {
    downloadStream.mockRejectedValueOnce(new Error("read failed"))
    const { db, state } = fakeDb()
    const response = await testApp(db).request(testRequest())

    expect(response.status).toBe(502)
    expect(deleteObject).toHaveBeenCalledTimes(1)
    expect(state.updated).toContainEqual(
      expect.objectContaining({ last_test_status: "failure" })
    )
  })

  it("records failure when witness cleanup fails", async () => {
    deleteObject.mockRejectedValueOnce(new Error("delete failed"))
    const { db, state } = fakeDb()
    const response = await testApp(db).request(testRequest())

    expect(response.status).toBe(502)
    expect(state.updated).toContainEqual(
      expect.objectContaining({ last_test_status: "failure" })
    )
  })
})
