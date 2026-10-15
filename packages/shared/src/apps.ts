// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

import { GitProviderKindSchema } from "./git-providers"
import {
  FrameworkDetectionSchema,
  FrameworkPresetIdSchema,
} from "./deployment-presets"

// ---------------------------------------------------------------------------
// Status enums
// ---------------------------------------------------------------------------

export const AppStatusSchema = z.enum([
  "created",
  "pending",
  "building",
  "running",
  "serving",
  "restarting",
  "failed",
  "stopped",
  "deleting",
])
export type AppStatus = z.infer<typeof AppStatusSchema>

export const BuildStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "succeeded_with_warning",
  "failed",
  "cancelled",
])
export type BuildStatus = z.infer<typeof BuildStatusSchema>

/**
 * `docker` is the legacy alias for `dockerfile` — kept in the enum so rows
 * written before sprint 3.2 still validate on read. New writes should use
 * `dockerfile`. Normalize via `normalizeBuildMethod()` before any switch.
 */
export const BuildMethodSchema = z.enum([
  "auto",
  "docker",
  "dockerfile",
  "compose",
  "nixpacks",
  "railpack",
  "static",
])
export type BuildMethod = z.infer<typeof BuildMethodSchema>

export type NormalizedBuildMethod = Exclude<BuildMethod, "docker">

export function normalizeBuildMethod(
  value: BuildMethod
): NormalizedBuildMethod {
  return value === "docker" ? "dockerfile" : value
}

export const RestartPolicySchema = z.enum([
  "no",
  "always",
  "unless-stopped",
  "on-failure",
])
export type RestartPolicy = z.infer<typeof RestartPolicySchema>

export const RuntimeModeSchema = z.enum(["docker", "swarm"])
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>

export const UpdateOrderSchema = z.enum(["start-first", "stop-first"])
export type UpdateOrder = z.infer<typeof UpdateOrderSchema>

export const FailureActionSchema = z.enum(["rollback", "pause", "continue"])
export type FailureAction = z.infer<typeof FailureActionSchema>

export const AppRuntimeSettingsSchema = z.object({
  runtimeMode: RuntimeModeSchema.default("swarm"),
  swarmServiceName: z.string().nullable().optional(),
  replicas: z.number().int().min(1).max(10).default(1),
  updateOrder: UpdateOrderSchema.default("start-first"),
  updateParallelism: z.number().int().min(1).max(10).default(1),
  updateDelayS: z.number().int().min(0).max(300).default(10),
  updateMonitorS: z.number().int().min(1).max(600).default(30),
  failureAction: FailureActionSchema.default("rollback"),
  stopGracePeriodS: z.number().int().min(1).max(300).default(10),
})
export type AppRuntimeSettings = z.infer<typeof AppRuntimeSettingsSchema>

export const JobStatusSchema = z.enum(["pending", "running", "done", "failed"])
export type JobStatus = z.infer<typeof JobStatusSchema>

export const JobTypeSchema = z.enum([
  "deploy.requested",
  "gc.registry",
  "cleanup.build",
])
export type JobType = z.infer<typeof JobTypeSchema>

// ---------------------------------------------------------------------------
// HealthcheckConfig
// ---------------------------------------------------------------------------

export const HealthcheckConfigSchema = z.object({
  path: z.string().default("/"),
  port: z.number().int().optional(),
  intervalS: z.number().int().default(5),
  timeoutS: z.number().int().default(3),
  retries: z.number().int().default(6),
  startPeriodS: z.number().int().default(0),
})
export type HealthcheckConfig = z.infer<typeof HealthcheckConfigSchema>

export const ImagePullPolicySchema = z.enum(["always", "if_not_present"])
export type ImagePullPolicy = z.infer<typeof ImagePullPolicySchema>

export const SecretPhaseSchema = z.enum(["build", "runtime", "both"])
export type SecretPhase = z.infer<typeof SecretPhaseSchema>

const APP_VOLUME_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/

export function isValidAppVolumeMountPath(value: string): boolean {
  if (value.length < 2 || value.length > 512) return false
  if (!value.startsWith("/")) return false
  if (value === "/" || value.includes("\0") || value.includes("\\"))
    return false

  const segments = value.slice(1).split("/")
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".."
  )
}

export const AppVolumeNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    APP_VOLUME_NAME_REGEX,
    "must be lowercase alphanumeric and may contain '.', '_' or '-'"
  )

export const AppVolumeMountPathSchema = z
  .string()
  .refine(isValidAppVolumeMountPath, {
    message:
      "must be an absolute Unix path inside the container without empty segments, '.' or '..'",
  })

export const AppVolumeSchema = z.object({
  id: z.string().min(1),
  name: AppVolumeNameSchema,
  mountPath: AppVolumeMountPathSchema,
  hostPath: z.string().min(1),
  sizeLimitBytes: z.number().int().positive().nullable().default(null),
  createdAt: z.string(),
})
export type AppVolume = z.infer<typeof AppVolumeSchema>

export const CreateAppVolumeSchema = z.object({
  name: AppVolumeNameSchema,
  mountPath: AppVolumeMountPathSchema,
  sizeLimitBytes: z.number().int().positive().nullable().optional(),
})
export type CreateAppVolumeInput = z.infer<typeof CreateAppVolumeSchema>

export const UpdateAppVolumeSchema = CreateAppVolumeSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "at least one field must be provided" }
)
export type UpdateAppVolumeInput = z.infer<typeof UpdateAppVolumeSchema>

// ---------------------------------------------------------------------------
// AppConfig
// ---------------------------------------------------------------------------

export const AppConfigSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().min(1),
    organizationId: z.string().optional(),
    projectId: z.string().optional(),
    gitProvider: GitProviderKindSchema,
    repoFullName: z.string(), // 'owner/repo'
    branch: z.string(),
    installationId: z.string().regex(/^\d+$/).optional(),
    rootDir: z.string().optional(),
    dockerfilePath: z.string().optional(),
    nixpacksConfigPath: z.string().optional(),
    nodeVersion: z.string().optional(),
    installCommand: z.string().optional(),
    buildCommand: z.string().optional(),
    startCommand: z.string().optional(),
    frameworkPreset: FrameworkPresetIdSchema.optional(),
    frameworkDetection: FrameworkDetectionSchema.optional(),
    watchPaths: z.array(z.string()).optional(),
    buildMethod: BuildMethodSchema.optional(),
    staticOutputDir: z.string().optional(),
    staticSpaFallback: z.boolean().optional(),
    runtimePort: z.number().int().positive().optional(),
    runtime: AppRuntimeSettingsSchema.partial().optional(),
    restartPolicy: RestartPolicySchema.optional(),
    healthcheck: HealthcheckConfigSchema.optional(),
    domain: z.string().optional(),
  })
  .refine((value) => Boolean(value.organizationId ?? value.projectId), {
    message: "organizationId or projectId is required",
    path: ["organizationId"],
  })
export type AppConfig = z.infer<typeof AppConfigSchema>

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export const BuildSchema = z.object({
  id: z.string(),
  appId: z.string(),
  status: BuildStatusSchema,
  buildMethod: BuildMethodSchema.nullable().optional(),
  imageTag: z.string().optional(),
  containerId: z.string().optional(),
  runtimeRef: z.string().nullable().optional(),
  commitSha: z.string().optional(),
  commitMessage: z.string().nullable().optional(),
  requestedByUserId: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  // Set when post-deploy hook fails (status = succeeded_with_warning)
  postDeployError: z.string().nullable().optional(),
  startedAt: z.number().optional(), // unix ms
  finishedAt: z.number().optional(), // unix ms
  createdAt: z.number(), // unix ms
})
export type Build = z.infer<typeof BuildSchema>

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export const JobSchema = z.object({
  id: z.string(),
  type: JobTypeSchema,
  payload: z.unknown(),
  status: JobStatusSchema,
  runAt: z.number().optional(), // unix ms
  createdAt: z.number(), // unix ms
  updatedAt: z.number(), // unix ms
})
export type Job = z.infer<typeof JobSchema>
