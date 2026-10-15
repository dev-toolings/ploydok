// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  buildRemoteLocation,
  classifyStorageError,
  isRemoteLocation,
  parseRemoteLocation,
} from "./object-store"
import { S3_LINK_LOCAL_ENDPOINT_ERROR } from "./endpoint-guard"

describe("remote backup locations", () => {
  it("round-trips S3 and Azure locations", () => {
    for (const scheme of ["s3", "azure"] as const) {
      const location = buildRemoteLocation(scheme, "backups", "db/1/x.dump")
      expect(isRemoteLocation(location)).toBe(true)
      expect(parseRemoteLocation(location)).toEqual({
        scheme,
        bucket: "backups",
        key: "db/1/x.dump",
      })
    }
    expect(isRemoteLocation("/var/lib/ploydok/backups/x.dump")).toBe(false)
  })
})

describe("classifyStorageError", () => {
  it("maps provider failures to stable reasons", () => {
    expect(classifyStorageError({ name: "InvalidAccessKeyId" })).toBe("auth_failed")
    expect(classifyStorageError({ statusCode: 403, code: "AuthenticationFailed" })).toBe(
      "auth_failed"
    )
    expect(classifyStorageError({ name: "NoSuchBucket" })).toBe("bucket_not_found")
    expect(classifyStorageError({ code: "ContainerNotFound", statusCode: 404 })).toBe(
      "bucket_not_found"
    )
    expect(classifyStorageError({ code: "ENOTFOUND" })).toBe("endpoint_unreachable")
    expect(classifyStorageError({ name: "TimeoutError" })).toBe("timeout")
    expect(classifyStorageError(new Error(S3_LINK_LOCAL_ENDPOINT_ERROR))).toBe(
      "endpoint_blocked"
    )
    expect(classifyStorageError(new Error("boom"))).toBe("unknown")
  })
})
