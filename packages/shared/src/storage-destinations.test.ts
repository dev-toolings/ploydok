// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  CreateStorageDestinationSchema,
  isUnsafeStorageDestinationAddress,
  isUnsafeStorageDestinationEndpoint,
} from "./storage-destinations"

describe("storage destination endpoint safety", () => {
  it("rejects link-local IPv4 and IPv6 addresses, including mapped IPv4", () => {
    for (const address of [
      "169.254.0.1",
      "169.254.169.254",
      "[fe80::1]",
      "[FE80:0:0:0:0:0:0:1]",
      "[::ffff:a9fe:a9fe]",
      "[::ffff:169.254.169.254]",
      "[fd00:ec2::254]",
    ]) {
      expect(isUnsafeStorageDestinationAddress(address)).toBe(true)
      expect(isUnsafeStorageDestinationEndpoint(`https://${address}/s3`)).toBe(
        true
      )
      expect(
        CreateStorageDestinationSchema.safeParse({
          name: "Metadata endpoint",
          kind: "s3",
          endpoint: `https://${address}/s3`,
          bucket: "backups",
          credentials: { accessKeyId: "access", secretAccessKey: "secret" },
        }).success
      ).toBe(false)
    }
  })

  it("keeps loopback and RFC1918 endpoints valid for local S3-compatible stores", () => {
    for (const endpoint of [
      "http://127.0.0.1:9000",
      "http://10.0.0.8:9000",
      "http://192.168.1.20:9000",
      "http://[::1]:9000",
      "http://[fd00::8]:9000",
    ]) {
      expect(isUnsafeStorageDestinationEndpoint(endpoint)).toBe(false)
      expect(
        CreateStorageDestinationSchema.safeParse({
          name: "Local S3",
          kind: "s3",
          endpoint,
          bucket: "backups",
          credentials: { accessKeyId: "access", secretAccessKey: "secret" },
        }).success
      ).toBe(true)
    }
  })
})
