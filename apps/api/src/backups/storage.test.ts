// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, mock } from "bun:test"
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import type { S3Client } from "@aws-sdk/client-s3"
import type { Db } from "@ploydok/db"
import {
  inspectBackupArtifact,
  type BackupS3Probe,
  writeBackupStream,
} from "./storage"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe("writeBackupStream", () => {
  it("writes local backup streams atomically and counts bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ploydok-backup-storage-"))
    tempDirs.push(dir)

    const location = path.join(dir, "backup.dump")
    const source = Readable.from([Buffer.from("hello "), Buffer.from("world")])

    const result = await writeBackupStream(
      {} as Db,
      {
        destination_kind: "local",
        s3_endpoint: null,
        s3_bucket: null,
        s3_prefix: null,
        s3_region: null,
        s3_credentials_secret_id: null,
      },
      location,
      source
    )

    expect(result.sizeBytes).toBe(11)
    expect(await readFile(location, "utf8")).toBe("hello world")
  })
})

describe("inspectBackupArtifact", () => {
  it("returns destination metadata for an existing local artifact", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ploydok-backup-storage-"))
    tempDirs.push(dir)

    const location = path.join(dir, "backup.dump")
    const modifiedAt = new Date("2026-10-15T10:00:00.000Z")
    await writeFile(location, "verified backup")
    await utimes(location, modifiedAt, modifiedAt)

    await expect(
      inspectBackupArtifact({} as Db, location, null)
    ).resolves.toEqual({
      sizeBytes: Buffer.byteLength("verified backup"),
      lastModifiedAt: modifiedAt,
    })
    await expect(
      inspectBackupArtifact({} as Db, path.join(dir, "missing.dump"), null)
    ).resolves.toBeNull()
  })

  it("accepts a reused S3 probe without resolving credentials again", async () => {
    const send = mock(async () => ({
      ContentLength: 17,
      LastModified: new Date("2026-10-15T10:00:00.000Z"),
    }))
    const probe: BackupS3Probe = {
      client: { send } as unknown as S3Client,
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
    }
    const db = {
      select: () => {
        throw new Error("credentials should be resolved once per request")
      },
    } as unknown as Db
    const config = {
      s3_endpoint: "http://localhost:9000",
      s3_region: "us-east-1",
      s3_credentials_secret_id: null,
    }

    await expect(
      inspectBackupArtifact(db, "s3://bucket/one.dump", config, probe)
    ).resolves.toEqual({
      sizeBytes: 17,
      lastModifiedAt: new Date("2026-10-15T10:00:00.000Z"),
    })
    await expect(
      inspectBackupArtifact(db, "s3://bucket/two.dump", config, probe)
    ).resolves.toEqual({
      sizeBytes: 17,
      lastModifiedAt: new Date("2026-10-15T10:00:00.000Z"),
    })
    expect(send).toHaveBeenCalledTimes(2)
  })
})
