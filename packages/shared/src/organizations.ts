// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"
import { BuildSchema, BuildStatusSchema } from "./apps"

export const OrganizationSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  is_default: z.boolean(),
  created_at: z.string().datetime(),
})
export type OrganizationSummary = z.infer<typeof OrganizationSummarySchema>

export const OrganizationResponseSchema = z.object({
  organization: OrganizationSummarySchema,
})
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>

export const OrganizationsResponseSchema = z.object({
  organizations: z.array(OrganizationSummarySchema),
})
export type OrganizationsResponse = z.infer<typeof OrganizationsResponseSchema>

export const CreateOrganizationBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
})
export type CreateOrganizationBody = z.infer<
  typeof CreateOrganizationBodySchema
>

export const UpdateOrganizationBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  // Opt-in. The server still refuses once the workspace owns anything that
  // pins the slug externally (SSO redirect URIs, outbound webhook consumers).
  reslug: z.boolean().optional().default(false),
})
export type UpdateOrganizationBody = z.infer<
  typeof UpdateOrganizationBodySchema
>

export const SlugFrozenReasonSchema = z.enum(["not_pristine", "not_requested"])
export type SlugFrozenReason = z.infer<typeof SlugFrozenReasonSchema>

export const UpdateOrganizationResponseSchema = z.object({
  organization: OrganizationSummarySchema,
  slug_changed: z.boolean(),
  previous_slug: z.string(),
  slug_frozen_reason: SlugFrozenReasonSchema.nullable(),
})
export type UpdateOrganizationResponse = z.infer<
  typeof UpdateOrganizationResponseSchema
>

// ---------------------------------------------------------------------------
// Workspace deployments
// ---------------------------------------------------------------------------

export const OrganizationDeploymentAppSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
})
export type OrganizationDeploymentApp = z.infer<
  typeof OrganizationDeploymentAppSchema
>

export const OrganizationDeploymentSchema = BuildSchema.extend({
  app: OrganizationDeploymentAppSchema,
})
export type OrganizationDeployment = z.infer<
  typeof OrganizationDeploymentSchema
>

export const OrganizationDeploymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  appId: z.string().min(1).optional(),
  status: BuildStatusSchema.optional(),
  source: z
    .enum([
      "api",
      "webhook:github",
      "webhook:gitlab",
      "cron:gc",
      "cron:cleanup",
      "auto:push",
      "auto:tag",
      "system",
    ])
    .optional(),
  q: z.string().trim().min(1).max(250).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})
export type OrganizationDeploymentsQuery = z.infer<
  typeof OrganizationDeploymentsQuerySchema
>

export const OrganizationDeploymentsResponseSchema = z.object({
  deployments: z.array(OrganizationDeploymentSchema),
  pagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    hasNext: z.boolean(),
  }),
  summary: z.object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    succeededWithWarning: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  canManage: z.boolean(),
})
export type OrganizationDeploymentsResponse = z.infer<
  typeof OrganizationDeploymentsResponseSchema
>

export const DEPLOYMENT_ACTIVITY_RANGES = [7, 30, 90] as const
export type DeploymentActivityRange =
  (typeof DEPLOYMENT_ACTIVITY_RANGES)[number]

export const OrganizationDeploymentActivityQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine(
      (value): value is DeploymentActivityRange =>
        (DEPLOYMENT_ACTIVITY_RANGES as ReadonlyArray<number>).includes(value),
      { message: "days must be 7, 30 or 90" }
    )
    .default(30),
})

export const OrganizationDeploymentActivityBucketSchema = z.object({
  /** UTC calendar day, YYYY-MM-DD. */
  date: z.string(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
})
export type OrganizationDeploymentActivityBucket = z.infer<
  typeof OrganizationDeploymentActivityBucketSchema
>

export const OrganizationDeploymentActivityResponseSchema = z.object({
  days: z.number().int().positive(),
  buckets: z.array(OrganizationDeploymentActivityBucketSchema),
})
export type OrganizationDeploymentActivityResponse = z.infer<
  typeof OrganizationDeploymentActivityResponseSchema
>
