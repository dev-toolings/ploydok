// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import {
  createSafeS3Lookup,
  createS3Client,
  S3_LINK_LOCAL_ENDPOINT_ERROR,
} from "./s3"

type LookupAddress = { address: string; family: number }

const publicAddresses: LookupAddress[] = [
  { address: "10.0.0.8", family: 4 },
  { address: "2001:db8::8", family: 6 },
]

function lookup(
  resolver: ReturnType<typeof createSafeS3Lookup>,
  options: { all?: boolean; family?: number | "IPv4" | "IPv6" }
): Promise<{
  error: NodeJS.ErrnoException | null
  address: string | LookupAddress[]
  family?: number
}> {
  return new Promise((resolve) => {
    resolver("s3.example.test", options, (error, address, family) => {
      resolve({
        error,
        address,
        ...(family === undefined ? {} : { family }),
      })
    })
  })
}

describe("S3 endpoint DNS safety", () => {
  it("respects all-address and family lookup requests", async () => {
    const resolver = createSafeS3Lookup((_host, _options, callback) =>
      callback(null, publicAddresses)
    )

    await expect(lookup(resolver, { all: true })).resolves.toEqual({
      error: null,
      address: publicAddresses,
    })
    await expect(lookup(resolver, { family: 6 })).resolves.toEqual({
      error: null,
      address: "2001:db8::8",
      family: 6,
    })
  })

  it("rejects a DNS answer containing a link-local address", async () => {
    const resolver = createSafeS3Lookup((_host, _options, callback) =>
      callback(null, [
        { address: "203.0.113.8", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ])
    )

    const result = await lookup(resolver, {})
    expect(result.error?.message).toBe(S3_LINK_LOCAL_ENDPOINT_ERROR)
    expect(result.error?.code).toBe("EHOSTUNREACH")
  })

  it("rejects a literal link-local endpoint before creating an SDK client", () => {
    expect(() =>
      createS3Client({
        endpoint: "http://[::ffff:169.254.169.254]:9000",
        region: "auto",
        accessKeyId: "access",
        secretAccessKey: "secret",
      })
    ).toThrow(S3_LINK_LOCAL_ENDPOINT_ERROR)
  })
})
