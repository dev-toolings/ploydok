// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

export const StorageDestinationKindSchema = z.enum(["s3", "local"])

function parseIpv4Address(value: string): [number, number, number, number] | null {
  const parts = value.split(".")
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return null
  }
  const octets = parts.map(Number)
  if (octets.some((octet) => octet < 0 || octet > 255)) return null
  return octets as [number, number, number, number]
}

function parseIpv6Address(value: string): number[] | null {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "")
  const zoneIndex = normalized.indexOf("%")
  const withoutZone = zoneIndex >= 0 ? normalized.slice(0, zoneIndex) : normalized
  const sections = withoutZone.split("::")
  if (sections.length > 2) return null

  const parseSection = (section: string): number[] | null => {
    if (!section) return []
    const groups = section.split(":")
    const parsed: number[] = []
    for (const group of groups) {
      if (group.includes(".")) {
        const octets = parseIpv4Address(group)
        if (!octets || group !== groups.at(-1)) return null
        parsed.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      parsed.push(Number.parseInt(group, 16))
    }
    return parsed
  }

  const left = parseSection(sections[0] ?? "")
  const right = parseSection(sections[1] ?? "")
  if (!left || !right) return null
  if (sections.length === 1) return left.length === 8 ? left : null

  const missing = 8 - left.length - right.length
  if (missing < 1) return null
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}

/**
 * Returns true for link-local IPv4/IPv6 addresses, including IPv4-mapped IPv6.
 * Loopback and RFC1918 private addresses remain valid S3 endpoints because
 * local S3-compatible services are a supported use case.
 */
export function isUnsafeStorageDestinationAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, "")
  const ipv4 = parseIpv4Address(normalized)
  if (ipv4) return ipv4[0] === 169 && ipv4[1] === 254

  if (!normalized.includes(":")) return false
  const ipv6 = parseIpv6Address(normalized)
  if (!ipv6) return false

  // fe80::/10 is link-local IPv6.
  if ((ipv6[0]! & 0xffc0) === 0xfe80) return true

  // AWS also exposes instance metadata at this IPv6 ULA address. Keep other
  // RFC4193 private addresses valid for local S3-compatible services.
  if (
    ipv6[0] === 0xfd00 &&
    ipv6[1] === 0x0ec2 &&
    ipv6.slice(2, 7).every((group) => group === 0) &&
    ipv6[7] === 0x0254
  ) {
    return true
  }

  // ::ffff:0:0/96 is the IPv4-mapped range. Check its embedded address too.
  const isMapped = ipv6.slice(0, 5).every((group) => group === 0) && ipv6[5] === 0xffff
  if (!isMapped) return false
  const mapped = [
    ipv6[6]! >> 8,
    ipv6[6]! & 0xff,
    ipv6[7]! >> 8,
    ipv6[7]! & 0xff,
  ] as [number, number, number, number]
  return mapped[0] === 169 && mapped[1] === 254
}

export function isUnsafeStorageDestinationEndpoint(value: string): boolean {
  try {
    return isUnsafeStorageDestinationAddress(new URL(value).hostname)
  } catch {
    return false
  }
}

const S3CredentialInputSchema = z.object({
  accessKeyId: z.string().min(1).max(512),
  secretAccessKey: z.string().min(1).max(4096),
})

/** Shared validation for configured S3-compatible endpoint URLs. */
export const S3EndpointSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .superRefine((value, ctx) => {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      return
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "Endpoint must use http or https" })
    }
    if (parsed.username || parsed.password) {
      ctx.addIssue({ code: "custom", message: "Endpoint must not contain credentials" })
    }
    if (isUnsafeStorageDestinationEndpoint(value)) {
      ctx.addIssue({
        code: "custom",
        message: "Endpoint must not use a link-local address",
      })
    }
  })

export const CreateStorageDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: StorageDestinationKindSchema,
    endpoint: S3EndpointSchema.optional(),
    bucket: z.string().trim().min(1).max(255).optional(),
    region: z.string().trim().min(1).max(255).optional(),
    credentials: S3CredentialInputSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "local") {
      if (value.credentials) {
        ctx.addIssue({
          code: "custom",
          path: ["credentials"],
          message: "Local destinations do not accept S3 credentials",
        })
      }
      return
    }
    if (!value.bucket) {
      ctx.addIssue({ code: "custom", path: ["bucket"], message: "Bucket is required for S3 destinations" })
    }
    if (!value.credentials) {
      ctx.addIssue({ code: "custom", path: ["credentials"], message: "S3 credentials are required" })
    }
  })

export const UpdateStorageDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    endpoint: S3EndpointSchema.optional().nullable(),
    bucket: z.string().trim().min(1).max(255).optional().nullable(),
    region: z.string().trim().min(1).max(255).optional().nullable(),
    credentials: S3CredentialInputSchema.optional().nullable(),
  })

export type CreateStorageDestinationInput = z.infer<typeof CreateStorageDestinationSchema>
export type UpdateStorageDestinationInput = z.infer<typeof UpdateStorageDestinationSchema>
