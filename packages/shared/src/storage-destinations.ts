// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

export const StorageDestinationKindSchema = z.enum(["s3", "local"])

const S3CredentialInputSchema = z.object({
  accessKeyId: z.string().min(1).max(512),
  secretAccessKey: z.string().min(1).max(4096),
})

const S3EndpointSchema = z
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
