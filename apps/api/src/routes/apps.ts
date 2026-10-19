// SPDX-License-Identifier: AGPL-3.0-only
import { getRequestLogs, runtimeLogSource } from "../services/request-logs"
import { readFile, stat } from "node:fs/promises"
import * as nodePath from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { Hono } from "hono"
import type { MiddlewareHandler } from "hono"
import type { Queue } from "bullmq"
import { z } from "zod"
import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm"
import { nanoid } from "nanoid"
import { createDb } from "@ploydok/db"
import {
  apps,
  app_db_links,
  databases,
  projects,
  memberships,
  builds,
  secrets,
  app_delete_jobs,
  system_jobs,
  app_deploy_leases,
} from "@ploydok/db"
import {
  BuildMethodSchema,
  AppRuntimeSettingsSchema,
  CommandSchema,
  GitProviderKindSchema,
  HealthcheckConfigSchema,
  ImagePullPolicySchema,
  RestartPolicySchema,
  RuntimePortSchema,
  ALL_PROBE_KEYS,
  MANIFEST_FILE_PROBE_KEYS,
  classifyStackWithManifests,
  getFrameworkPreset,
  FrameworkDetectionSchema,
  FrameworkPresetIdSchema,
  classificationForPreset,
  AppQuickLinkSchema,
  SafeHttpUrlSchema,
} from "@ploydok/shared"
import type {
  FrameworkDetection,
  ManifestContents,
  StackClassification,
} from "@ploydok/shared"
import {
  getAppActivity,
  getAppForOwner,
  getAppForUser,
  getBuildForApp,
  getBuildLogPath,
  updateBuildStatus,
  requestBuildCancellation,
  insertAuditLog,
  insertApp,
  listAppsForUser,
  listBuildsForApp,
  rotateAppWebhookSecret,
  uniqueSlug,
  updateApp,
  type AppRow,
  completeClaimedCreationSaga,
  createCreationSaga,
  claimCreationSaga,
  getCreationSaga,
  fenceCreationSaga,
  recordClaimedCreationSagaStep,
} from "@ploydok/db/queries"
import {
  organizationHasGitHubInstallationGrant,
  userOwnsPersonalGitHubInstallation,
} from "@ploydok/db/queries"
import {
  assertGitLabProjectSelection,
  resolveGitLabConnection,
} from "../gitlab/connection"
import { listDeliveriesByApp, getDeliveryById } from "@ploydok/db/queries"
import { decompressLog } from "../services/build-log-archive"
import {
  replayDelivery,
  ReplayLimitError,
  ReplayPayloadMissingError,
} from "../webhooks/deliveries"
import { env } from "../env"
import { deployQueue, appDeleteQueue, gcQueue } from "../worker/queues"
import { enqueueWithDbRow } from "../worker/queue-enqueue"
import { eventBus } from "../worker/event-bus"
import { childLogger } from "../logger"
import type { Db } from "@ploydok/db"
import type { AuthUser } from "../auth/middleware"
import { requireSecondFactor } from "../auth/middleware"
import { requireTotpVerified } from "../auth/second-factor"
import { requireScope } from "../auth/require-scope"
import { resumeApplicationConfiguration } from "../services/application-creation-saga"
import { encryptField, decryptField } from "../github/app-credentials"
import { ghProvider } from "./github"
import { getSharedAgent } from "../debug/singletons"
import { isNotFound, toAgentError } from "../agent/errors"
import { appLogSource } from "../services/log-provenance"
import { runningBuildMatch } from "../services/runtime-build"
import { resolveAppRuntimeContainerId } from "../services/runtime-target"
import {
  reconcileAppStatus,
  reconcileAppStatusList,
} from "../services/app-status-reconciler"
import { dispatch as notifyDispatch } from "../notify/index"
import { createRedis } from "@ploydok/db"
import { ensureDefaultOrganizationForUser } from "../services/organizations"
import {
  frameworkPresetCreateFields,
  frameworkPresetPatchFields,
} from "../services/framework-preset"
import { ensureFrameworkEnvVars } from "../services/framework-env"
import { encryptSecret } from "../secrets/crypto"
import { getConnectionString } from "../databases/spawner"
import {
  DEFAULT_DATABASE_ENV_PREFIX,
  parseConnectionString,
} from "./apps-databases-link"
import {
  buildPublicUrl as buildDomainPublicUrl,
  deriveDefaultAppDomainBase,
  normalizeAppHostname,
  classifyAppDomain,
} from "../domains/app-domain"
import {
  assertDomainAvailable,
  DomainCollisionError,
  InvalidAppDomainError,
  findDomainCollisions,
  isUniqueDomainConstraintError,
  lockDomain,
} from "../domains/availability"
import {
  inspectDomainDns,
  publishHealthyAppRoute,
  syncAppDomainAliases,
} from "../domains/routing"
import { CaddyClient } from "../caddy/client"
import { ContainerHealthStatus } from "@ploydok/agent-proto"
import { listSwarmTasks, taskIsHealthy } from "../worker/swarm-runner"
import {
  caddyStaticRootForApp,
  staticRootForApp,
} from "../worker/handlers/build-static"
import { createRateLimiter } from "../webhooks/rate-limit"
import { runtimeContainerNameCandidates } from "../services/runtime-containers"
import {
  currentDeployLease,
  fenceDeploySideEffect,
  withRoutingDeployLease as fenceRoutingBuild,
} from "../worker/app-deploy-lock"

export { deriveDefaultAppDomainBase } from "../domains/app-domain"

const domainPreviewRateLimit = createRateLimiter({
  redis: createRedis(env.REDIS_URL),
  windowSec: 60,
  max: 60,
  keyPrefix: "rl:apps-domain-preview",
  keyFrom: (c) => {
    const user = c.get("user") as AuthUser | undefined
    return user?.id ? `user:${user.id}` : { key: "user:unknown", max: 1 }
  },
})

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const PlanSchema = z.enum(["nano", "small", "medium", "large", "custom"])

function frameworkEnvClassificationForExplicitNixpacks(
  classification: StackClassification,
  probes: Record<string, boolean>
): StackClassification {
  if (classification.stack !== "compose") return classification
  if (!probes["symfony.lock"] && !probes["bin/console"]) return classification
  return {
    ...classification,
    stack: "symfony",
    framework: "Symfony",
    presetId: "symfony",
    preset: getFrameworkPreset("symfony")!,
    confidence: "high",
    signals: [
      ...classification.signals,
      ...(probes["symfony.lock"] ? (["symfony.lock"] as const) : []),
      ...(probes["bin/console"] ? (["bin/console"] as const) : []),
    ],
    suggestedEnvVars: {
      APP_ENV: "prod",
      APP_DEBUG: "0",
      NIXPACKS_PHP_ROOT_DIR: "/app/public",
      NIXPACKS_PHP_FALLBACK_PATH: "/index.php",
      NIXPACKS_INSTALL_CMD:
        "mkdir -p /var/log/nginx /var/cache/nginx && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction --no-progress --prefer-dist --ignore-platform-reqs --optimize-autoloader",
    },
  }
}

export async function enqueueAppDeleteJob(opts: {
  db: Db
  appId: string
  requestedByUserId: string
  flags: {
    deleteImages: boolean
    dockerCleanup: boolean
    deleteBuildArtifacts: boolean
    deleteCaddyRoutes: boolean
  }
  queue?: import("../worker/queue-enqueue").QueuePublisher
  dispatchAfterCommit?: Parameters<
    typeof enqueueWithDbRow
  >[0]["dispatchAfterCommit"]
}) {
  const queue = opts.queue ?? appDeleteQueue
  const { jobId } = await enqueueWithDbRow({
    db: opts.db,
    queue,
    jobName: "app.delete.requested",
    insertRow: async (tx) => {
      await tx
        .update(apps)
        .set({ status: "deleting", updated_at: new Date() })
        .where(eq(apps.id, opts.appId))
      return tx
        .insert(app_delete_jobs)
        .values({
          id: nanoid(),
          app_id: opts.appId,
          requested_by_user_id: opts.requestedByUserId,
          source: "api",
          options: opts.flags,
        })
        .returning()
        .then((rows: (typeof app_delete_jobs.$inferSelect)[]) => rows[0]!)
    },
    buildPayload: (row) => ({ jobId: row.id }),
    ...(opts.dispatchAfterCommit
      ? { dispatchAfterCommit: opts.dispatchAfterCommit }
      : {}),
  })
  return { jobId }
}

// nixpacks_config_path is joined with workspacePath at build time and fed to
// nixpacks --config. An attacker controlling this field could point to any
// readable file on the build host. Require a relative path with no traversal.
const NixpacksConfigPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\0][^\0]*$/, "must be a relative path")
  .refine(
    (v) =>
      !v.split("/").some((seg) => seg === "" || seg === "." || seg === ".."),
    { message: "path traversal segments are not allowed" }
  )

// node_version is injected verbatim into the build environment. Restrict it to
// a dotted numeric (optionally prefixed by the letter v) to rule out env
// injection via newlines or equals signs.
const NodeVersionSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^v?\d+(\.\d+){0,2}$/, "must look like '20', '20.10', or '20.10.0'")

const RelativeWorkspacePathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => {
      if (value.includes("\0") || value.includes("\\")) return false
      if (value.startsWith("/")) return false

      const segments = value.split("/")
      return !segments.some((segment) => segment === "" || segment === "..")
    },
    {
      message:
        "must be a safe relative path inside the workspace (no absolute paths, '..', empty segments, or backslashes)",
    }
  )

const StaticOutputDirSchema = RelativeWorkspacePathSchema.optional()
const IdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/, "Invalid idempotency key")

const DeployableBuildMethodSchema = BuildMethodSchema.refine(
  (method) => method !== "railpack",
  { message: "Railpack is planned but not available in agent-only production" }
)

// Base object schema (no .refine so it stays composable with .omit/.extend).
const CreateAppBodyBase = z.object({
  name: z.string().min(1).max(64),
  organizationId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  gitProvider: GitProviderKindSchema,
  // repoFullName + branch are only required for git sources (github / gitlab).
  repoFullName: z
    .string()
    .regex(/^[^/]+(?:\/[^/]+)+$/)
    .optional(),
  branch: z.string().min(1).optional(),
  installationId: z.string().regex(/^\d+$/).optional(),
  gitlabProjectId: z.number().int().positive().optional(),
  // Image source (gitProvider === 'image') fields.
  imageRef: z.string().min(1).optional(),
  imagePullPolicy: ImagePullPolicySchema.optional(),
  registryCredentialId: z.string().min(1).optional(),
  trackLatest: z.boolean().optional(),
  iconUrl: SafeHttpUrlSchema.nullable().optional(),
  quickLinks: z.array(AppQuickLinkSchema).max(8).optional(),
  // Quotas (Phase 1.C). `custom` disables enforcement.
  plan: PlanSchema.optional(),
  cpuLimit: z.number().positive().optional(),
  memLimitMB: z.number().int().positive().optional(),
  pidsLimit: z.number().int().positive().optional(),
  rootDir: RelativeWorkspacePathSchema.optional(),
  dockerfilePath: RelativeWorkspacePathSchema.optional(),
  nixpacksConfigPath: NixpacksConfigPathSchema.optional(),
  nodeVersion: NodeVersionSchema.optional(),
  installCommand: CommandSchema.optional(),
  buildCommand: CommandSchema.optional(),
  startCommand: CommandSchema.optional(),
  frameworkPreset: FrameworkPresetIdSchema.nullable().optional(),
  watchPaths: z.array(z.string()).optional(),
  buildMethod: DeployableBuildMethodSchema.optional(),
  staticOutputDir: StaticOutputDirSchema.optional(),
  staticSpaFallback: z.boolean().optional(),
  runtimePort: RuntimePortSchema.nullable().optional(),
  runtime: AppRuntimeSettingsSchema.partial().optional(),
  restartPolicy: RestartPolicySchema.optional(),
  healthcheck: HealthcheckConfigSchema.partial().optional(),
  domain: z.string().optional(),
  idempotencyKey: IdempotencyKeySchema.optional(),
  initialSecrets: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Z_][A-Z0-9_]*$/),
        value: z.string().max(16_384),
        scope: z
          .enum(["shared", "prod", "preview"])
          .optional()
          .default("shared"),
        phase: z
          .enum(["runtime", "build", "both"])
          .optional()
          .default("runtime"),
      })
    )
    .max(50)
    .optional(),
  initialDatabaseLink: z
    .object({
      databaseId: z.string().min(1),
      envPrefix: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[A-Z0-9_]+$/)
        .default(DEFAULT_DATABASE_ENV_PREFIX),
    })
    .optional(),
  /** Per-app GC override. null clears the override (falls back to default 3). */
  keepPerRepo: z.number().int().min(0).max(50).nullable().optional(),
})

const CreateAppBody = CreateAppBodyBase

// PATCH accepts the same fields except name and projectId are not updatable here
const PatchAppBody = CreateAppBodyBase.omit({
  name: true,
  organizationId: true,
  projectId: true,
  initialSecrets: true,
  initialDatabaseLink: true,
  idempotencyKey: true,
})
  .extend({
    auto_deploy_enabled: z.boolean().optional(),
    post_commit_status: z.boolean().optional(),
    coalesce_pushes: z.boolean().optional(),
    deploy_on_tag: z.boolean().optional(),
    // Deploy hooks (Wave 5)
    hooksPreDeploy: z.string().nullable().optional(),
    hooksPostDeploy: z.string().nullable().optional(),
    hooksTimeoutS: z.number().int().min(10).max(3600).optional(),
    // tag_pattern must be a valid regex when provided
    tag_pattern: z
      .string()
      .nullable()
      .optional()
      .refine(
        (v) => {
          if (v === null || v === undefined) return true
          try {
            new RegExp(v)
            return true
          } catch {
            return false
          }
        },
        { message: "tag_pattern must be a valid regular expression" }
      ),
  })
  .partial()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
}

export async function removeQueuedDeployBuild(
  queue: Pick<Queue, "getJobs">,
  buildId: string
): Promise<void> {
  const jobs = await queue.getJobs([
    "waiting",
    "delayed",
    "active",
    "paused",
    "prioritized",
  ])
  for (const job of jobs) {
    const data = job.data
    if (
      typeof data === "object" &&
      data !== null &&
      "buildId" in data &&
      (data as { buildId?: unknown }).buildId === buildId
    ) {
      await job.remove().catch(() => undefined)
    }
  }
}

function dnsSafeToken(value: string, length: number): string {
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, length)
    .replace(/-$/, "a")
  return (
    token ||
    nanoid(length)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "a")
  )
}

export function buildDefaultAppDomain(params: {
  slug: string
  appId: string
  explicitBase?: string | null | undefined
  publicHost?: string | null | undefined
}): string {
  const base = deriveDefaultAppDomainBase({
    explicitBase: params.explicitBase,
    publicHost: params.publicHost,
  })
  const suffix = dnsSafeToken(params.appId, 8)
  const safeSlug = slugify(params.slug) || "app"
  const maxSlugLength = Math.max(1, 63 - suffix.length - 1)
  const label = `${safeSlug.slice(0, maxSlugLength)}-${suffix}`
  return `${label}.${base}`
}

function defaultAppDomain(slug: string, appId: string): string {
  return buildDefaultAppDomain({
    slug,
    appId,
    explicitBase: env.PLOYDOK_DOMAIN_BASE,
    publicHost: env.PLOYDOK_PUBLIC_HOST,
  })
}

function isUniqueConstraintError(err: unknown, constraint: string): boolean {
  if (!err || typeof err !== "object") return false
  const record = err as Record<string, unknown>
  return (
    record["code"] === "23505" &&
    (record["constraint"] === constraint ||
      String(record["message"] ?? "").includes(constraint))
  )
}

async function findAppByCreationKey(
  db: Db,
  projectId: string,
  key: string
): Promise<AppRow | null> {
  const rows = await db
    .select()
    .from(apps)
    .where(
      and(
        eq(apps.project_id, projectId),
        eq(apps.creation_idempotency_key, key)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function nullToUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined
}

function parseFrameworkDetection(
  raw: string | null
): FrameworkDetection | undefined {
  if (!raw) return undefined
  try {
    const parsed = FrameworkDetectionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function frameworkDetectionForClassification(
  classification: StackClassification,
  rootDir?: string | null
): FrameworkDetection {
  const parsedPresetId = FrameworkPresetIdSchema.safeParse(
    classification.presetId
  )
  return {
    stack: classification.stack,
    ...(classification.framework
      ? { framework: classification.framework }
      : {}),
    presetId: parsedPresetId.success ? parsedPresetId.data : "unknown",
    confidence: classification.confidence,
    signals: [...classification.signals],
    evidence: [...(classification.evidence ?? classification.signals)],
    ...(classification.ambiguous !== undefined
      ? { ambiguous: classification.ambiguous }
      : {}),
    ...(classification.candidates
      ? { candidates: classification.candidates }
      : {}),
    ...(rootDir ? { rootDir } : {}),
  }
}

async function resolveDeployJobAppIdFromPayload(
  db: Db,
  data: unknown
): Promise<string | null> {
  let payload: unknown
  try {
    payload = typeof data === "string" ? JSON.parse(data) : data
  } catch {
    return null
  }

  if (!payload || typeof payload !== "object") return null

  const buildId = (payload as { buildId?: unknown }).buildId
  if (typeof buildId === "string") {
    const rows = await db
      .select({ app_id: builds.app_id })
      .from(builds)
      .where(eq(builds.id, buildId))
      .limit(1)

    return rows[0]?.app_id ?? null
  }

  const appId = (payload as { appId?: unknown }).appId
  return typeof appId === "string" ? appId : null
}

function buildPublicUrl(domain: string | null): string | null {
  return buildDomainPublicUrl(domain, {
    scheme: env.PLOYDOK_PUBLIC_SCHEME,
    port: env.PLOYDOK_PUBLIC_PORT,
  })
}

export function deriveCurrentBuildMetadata(
  buildRows: Array<Pick<BuildRow, "id" | "status" | "commit_sha">>
): { currentCommitSha?: string; latestBuildId?: string } {
  const currentBuild = buildRows.find(
    (build) =>
      (build.status === "succeeded" ||
        build.status === "succeeded_with_warning") &&
      build.commit_sha
  )

  const metadata: { currentCommitSha?: string; latestBuildId?: string } = {}
  if (currentBuild?.commit_sha)
    metadata.currentCommitSha = currentBuild.commit_sha
  if (buildRows[0]?.id) metadata.latestBuildId = buildRows[0].id
  return metadata
}

function serializeApp(
  row: AppRow,
  buildMetadata: { currentCommitSha?: string; latestBuildId?: string } = {}
) {
  return {
    id: row.id,
    // organizationId and projectId are currently both projections of the same
    // underlying `projects.id` column. The backend models an organization as
    // a project row (is_default=true marks the user's default workspace) so
    // the two names are aliases. Kept for the transitional period where the
    // frontend is moving to org-scoped URLs; once the web never requests
    // projectId we drop that field.
    organizationId: row.project_id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    gitProvider: row.git_provider,
    imageRef: row.image_ref,
    imagePullPolicy: row.image_pull_policy,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    githubInstallationId: row.github_installation_id,
    gitlabProjectId: row.gitlab_project_id,
    providerInstallationId: row.git_provider_installation_id,
    rootDir: nullToUndefined(row.root_dir),
    dockerfilePath: nullToUndefined(row.dockerfile_path),
    nixpacksConfigPath: nullToUndefined(row.nixpacks_config_path),
    nodeVersion: nullToUndefined(row.node_version),
    installCommand: nullToUndefined(row.install_command),
    buildCommand: nullToUndefined(row.build_command),
    startCommand: nullToUndefined(row.start_command),
    frameworkPreset: nullToUndefined(row.framework_preset),
    frameworkDetection: parseFrameworkDetection(row.framework_detection),
    watchPaths: row.watch_paths
      ? (JSON.parse(row.watch_paths) as string[])
      : undefined,
    buildMethod: row.build_method,
    staticOutputDir: row.static_output_dir,
    staticSpaFallback: row.static_spa_fallback,
    runtimePort: row.runtime_port,
    runtime: {
      runtimeMode: row.runtime_mode,
      swarmServiceName: row.swarm_service_name,
      replicas: row.replicas,
      updateOrder: row.update_order,
      updateParallelism: row.update_parallelism,
      updateDelayS: row.update_delay_s,
      updateMonitorS: row.update_monitor_s,
      failureAction: row.failure_action,
      stopGracePeriodS: row.stop_grace_period_s,
    },
    restartPolicy: row.restart_policy,
    domain: row.domain,
    publicUrl: buildPublicUrl(row.domain),
    domainSource: row.domain_source,
    routing: {
      status: row.routing_status,
      error: row.routing_error,
      dnsStatus: row.routing_dns_status ?? "unknown",
      tlsStatus: row.routing_tls_status ?? "unknown",
      issue:
        row.routing_dns_status && row.routing_dns_status !== "valid"
          ? "dns"
          : row.routing_tls_status &&
              row.routing_tls_status !== "issued" &&
              row.routing_tls_status !== "not_required"
            ? "tls"
            : row.routing_status === "action_required"
              ? "runtime"
              : null,
    },
    containerId: row.container_id,
    currentCommitSha: buildMetadata.currentCommitSha,
    latestBuildId: buildMetadata.latestBuildId,
    iconUrl: row.icon_url,
    quickLinks: parseQuickLinks(row.quick_links),
    trackLatest: row.track_latest,
    lastImageDigest: row.last_image_digest,
    pendingImageDigest: row.pending_image_digest,
    keepPerRepo: nullToUndefined(row.keep_per_repo),
    autoDeployEnabled: row.auto_deploy_enabled,
    postCommitStatus: row.post_commit_status,
    coalescePushes: row.coalesce_pushes,
    deployOnTag: row.deploy_on_tag,
    tagPattern: nullToUndefined(row.tag_pattern),
    healthcheck: {
      path: row.healthcheck_path,
      port: row.healthcheck_port,
      intervalS: row.healthcheck_interval_s,
      timeoutS: row.healthcheck_timeout_s,
      retries: row.healthcheck_retries,
      startPeriodS: row.healthcheck_start_period_s,
    },
    // Deploy hooks (Wave 5)
    hooksPreDeploy: row.hooks_pre_deploy ?? null,
    hooksPostDeploy: row.hooks_post_deploy ?? null,
    hooksTimeoutS: row.hooks_timeout_s ?? 300,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
  }
}

type AppPartialRow = {
  id: string
  project_id: string
  name: string
  slug: string
  status: string | null
  git_provider: string | null
  repo_full_name: string | null
  image_ref: string | null
  branch: string | null
  build_method: string | null
  framework_preset: string | null
  framework_detection: string | null
  domain: string | null
  container_id: string | null
  icon_url: string | null
  quick_links: string | null
  track_latest: boolean
  last_image_digest: string | null
  pending_image_digest: string | null
  created_at: Date | null
  updated_at: Date | null
}

function serializeAppPartial(row: AppPartialRow) {
  return {
    id: row.id,
    organizationId: row.project_id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    gitProvider: row.git_provider,
    repoFullName: row.repo_full_name,
    imageRef: row.image_ref,
    branch: nullToUndefined(row.branch),
    buildMethod: nullToUndefined(row.build_method),
    frameworkPreset: nullToUndefined(row.framework_preset),
    frameworkDetection: parseFrameworkDetection(row.framework_detection),
    domain: nullToUndefined(row.domain),
    publicUrl: nullToUndefined(buildPublicUrl(row.domain)),
    // Exposed so the dashboard can pin runtime/health to the canonical container
    // and ignore orphan slots left behind by failed deploys (Sprint 7-bis fix).
    containerId: row.container_id,
    iconUrl: row.icon_url,
    quickLinks: parseQuickLinks(row.quick_links),
    trackLatest: row.track_latest,
    lastImageDigest: row.last_image_digest,
    pendingImageDigest: row.pending_image_digest,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : row.updated_at,
  }
}

function parseQuickLinks(raw: string | null) {
  if (!raw) return []
  try {
    const parsed = z.array(AppQuickLinkSchema).max(8).safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

type BuildRow = {
  id: string
  app_id: string
  status: string
  build_method: string | null
  image_tag: string | null
  container_id: string | null
  runtime_ref: string | null
  commit_sha: string | null
  commit_message: string | null
  error_message: string | null
  post_deploy_error: string | null
  started_at: Date | null
  finished_at: Date | null
  created_at: Date | null
  requested_by_user_id: string | null
  source: string
}

function serializeBuild(row: BuildRow) {
  return {
    id: row.id,
    appId: row.app_id,
    status: row.status,
    buildMethod: row.build_method,
    imageTag: row.image_tag,
    containerId: row.container_id,
    runtimeRef: row.runtime_ref,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    errorMessage: row.error_message ?? null,
    postDeployError: row.post_deploy_error ?? null,
    requestedByUserId: row.requested_by_user_id ?? null,
    source: row.source,
    startedAt:
      row.started_at instanceof Date
        ? row.started_at.getTime()
        : row.started_at,
    finishedAt:
      row.finished_at instanceof Date
        ? row.finished_at.getTime()
        : row.finished_at,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.getTime()
        : row.created_at,
  }
}

type RecheckTarget =
  | { kind: "proxy"; upstream: { host: string; port: number } }
  | { kind: "static"; root: string; spaFallback: boolean }

function appHasConfiguredHealthcheck(app: AppRow): boolean {
  if (app.runtime_has_healthcheck !== null && app.runtime_has_healthcheck !== undefined) {
    return app.runtime_has_healthcheck
  }
  if (app.build_method !== "compose") return true
  return [
    app.healthcheck_path,
    app.healthcheck_port,
    app.healthcheck_interval_s,
    app.healthcheck_timeout_s,
    app.healthcheck_retries,
    app.healthcheck_start_period_s,
  ].some((value) => value !== null && value !== undefined)
}

async function hasActiveDeployLease(db: Db, appId: string): Promise<boolean> {
  const rows = await db
    .select({ app_id: app_deploy_leases.app_id })
    .from(app_deploy_leases)
    .where(
      and(
        eq(app_deploy_leases.app_id, appId),
        gt(app_deploy_leases.lease_until, new Date())
      )
    )
    .limit(1)
  return rows.length > 0
}

type RoutingApp = Pick<
  AppRow,
  "id" | "container_id" | "runtime_mode" | "swarm_service_name"
>

async function currentRoutingBuildId(
  db: Db,
  app: RoutingApp
): Promise<string | null> {
  const buildFilter = and(
    eq(builds.app_id, app.id),
    inArray(builds.status, ["succeeded", "succeeded_with_warning"]),
    runningBuildMatch(app)
  )
  const rows = await db
    .select({ id: builds.id })
    .from(builds)
    .where(buildFilter)
    .orderBy(desc(builds.created_at), desc(builds.id))
    .limit(1)
  return rows[0]?.id ?? null
}

async function withRoutingDeployLease<T>(opts: {
  db: Db
  app: RoutingApp
  task: () => Promise<T>
}): Promise<T | null> {
  const buildId = await currentRoutingBuildId(opts.db, opts.app)
  if (!buildId) return null
  return fenceRoutingBuild(opts.db, opts.app.id, buildId, opts.task)
}

async function cleanupRetainedDockerSlot(
  app: AppRow,
  previousUpstream: { host: string; port: number } | null,
  currentUpstream: { host: string; port: number }
): Promise<void> {
  const ownedSlots = new Set([
    ...runtimeContainerNameCandidates(app, "blue"),
    ...runtimeContainerNameCandidates(app, "green"),
  ])
  const agent = getSharedAgent()
  const listed = await agent.listContainers({ kindFilter: "app" })
  const retained = listed.containers.filter(
    (container) =>
      container.appId === app.id &&
      ownedSlots.has(container.name) &&
      container.name !== currentUpstream.host
  )
  if (
    retained.length === 0 &&
    previousUpstream &&
    ownedSlots.has(previousUpstream.host)
  ) {
    return
  }
  for (const container of retained) {
    try {
      await fenceDeploySideEffect()
      await agent.containerStop({
        containerId: container.id,
        timeoutSeconds: 10,
      })
    } catch (error) {
      if (isNotFound(toAgentError(error))) continue
      throw error
    }
    try {
      await fenceDeploySideEffect()
      await agent.containerRemove({
        containerId: container.id,
        force: true,
        removeVolumes: false,
      })
    } catch (error) {
      if (isNotFound(toAgentError(error))) continue
      throw error
    }
  }
}

export async function resolveHealthyRecheckTarget(
  db: Db,
  app: AppRow
): Promise<RecheckTarget> {
  if (app.build_method === "static" || app.status === "serving") {
    const root = caddyStaticRootForApp(app.id)
    const artifact = await stat(staticRootForApp(app.id)).catch(() => null)
    if (!artifact?.isDirectory()) {
      throw new Error("Static runtime artifact is unavailable")
    }
    return {
      kind: "static",
      root,
      spaFallback: app.static_spa_fallback ?? true,
    }
  }

  const port = app.runtime_port ?? 3000
  if (app.runtime_mode === "swarm" && app.swarm_service_name) {
    const tasks = await listSwarmTasks(app.id, db)
    if (
      tasks.filter((task) =>
        taskIsHealthy(task, appHasConfiguredHealthcheck(app))
      ).length < Math.max(1, app.replicas ?? 1)
    ) {
      throw new Error("Runtime is not healthy")
    }
    return {
      kind: "proxy",
      upstream: { host: app.swarm_service_name, port },
    }
  }

  if (!app.container_id) {
    throw new Error("Runtime container is unavailable")
  }
  const health = await getSharedAgent().inspectContainerHealth({
    containerId: app.container_id,
  })
  const hasHealthcheck = appHasConfiguredHealthcheck(app)
  if (
    health.containerMissing ||
    health.running !== true ||
    (health.status !== ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY &&
      !(
        !hasHealthcheck &&
        health.status === ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE
      ))
  ) {
    throw new Error("Runtime is not healthy")
  }
  return {
    kind: "proxy",
    upstream: { host: app.container_id, port },
  }
}

// ---------------------------------------------------------------------------
// Router factory — accepts an injected DB for testability
// ---------------------------------------------------------------------------

export function createAppsRouter(db: Db): Hono {
  const router = new Hono()

  // Second-factor enforcement middleware (must be called after requireAuth).
  // Applied on all state-mutating endpoints except POST /apps (creation).
  const sf = requireSecondFactor(db)
  const appsRead = requireScope("apps:read")
  const appsWrite = requireScope("apps:write")
  const appsDeploy = requireScope("apps:deploy")
  const ownerOnly: MiddlewareHandler = async (c, next) => {
    const user = getUser(c)
    if (!(await getAppForOwner(db, c.req.param("id")!, user.id))) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }
    await next()
  }

  // Preview the final host before an app exists. DNS is checked against the
  // real resolver with a short timeout; an unavailable DNS record is reported
  // as a pending action and never treated as proof that the host is ready.
  router.get("/domain-preview", appsRead, domainPreviewRateLimit, async (c) => {
    const rawDomain = c.req.query("domain") ?? c.req.query("hostname")
    if (!rawDomain) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: "domain is required" } },
        400
      )
    }

    const hostname = normalizeAppHostname(rawDomain)
    if (!hostname) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Domain must be a hostname without a path, port, or credentials",
          },
        },
        400
      )
    }

    const appId = c.req.query("appId")
    if (appId && !(await getAppForUser(db, appId, getUser(c).id))) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const domainBase = deriveDefaultAppDomainBase({
      explicitBase: env.PLOYDOK_DOMAIN_BASE,
      publicHost: env.PLOYDOK_PUBLIC_HOST,
    })
    const [collisions, dns] = await Promise.all([
      findDomainCollisions(db, hostname, appId ? { excludeAppId: appId } : {}),
      inspectDomainDns(hostname),
    ])
    // A preview must not perform an arbitrary-SNI TLS handshake. TLS becomes
    // evidence only after the route has been published and rechecked.
    const tls = {
      status:
        env.PLOYDOK_PUBLIC_SCHEME === "https"
          ? ("pending" as const)
          : ("not_required" as const),
      checkedAt: new Date().toISOString(),
      error:
        env.PLOYDOK_PUBLIC_SCHEME === "https"
          ? "TLS is checked after route publication"
          : null,
    }

    return c.json({
      available: collisions.length === 0,
      normalizedHostname: hostname,
      kind: classifyAppDomain(hostname, domainBase),
      publicUrl: buildPublicUrl(hostname),
      expectedRecords: dns.expectedRecords,
      dns,
      tls,
    })
  })

  router.get("/default-domain-config", appsRead, (c) => {
    const domainBase = deriveDefaultAppDomainBase({
      explicitBase: env.PLOYDOK_DOMAIN_BASE,
      publicHost: env.PLOYDOK_PUBLIC_HOST,
    })
    return c.json({
      domainBase,
      publicScheme: env.PLOYDOK_PUBLIC_SCHEME,
      publicPort: env.PLOYDOK_PUBLIC_PORT ?? null,
    })
  })

  router.post("/:id/routing/recheck", appsWrite, ownerOnly, sf, async (c) => {
    const appId = c.req.param("id")!
    const app = await getAppForOwner(db, appId, getUser(c).id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }
    if (await hasActiveDeployLease(db, appId)) {
      return c.json({
        routing: {
          status: "action_required",
          issue: "runtime",
          error: "Deployment is still in progress",
          dnsStatus: app.routing_dns_status ?? "unknown",
          tlsStatus: app.routing_tls_status ?? "unknown",
        },
      })
    }
    if (!app.domain) {
      return c.json(
        {
          routing: {
            status: "action_required",
            issue: "runtime",
            error: "Application has no public domain",
            dnsStatus: "unknown",
            tlsStatus: "unknown",
          },
        }
      )
    }

    let target: RecheckTarget
    try {
      target = await resolveHealthyRecheckTarget(db, app)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await db
        .update(apps)
        .set({
          routing_status: "action_required",
          routing_error: message,
        })
        .where(eq(apps.id, appId))
      return c.json({
        routing: {
          status: "action_required",
          issue: "runtime",
          error: message,
          dnsStatus: app.routing_dns_status ?? "unknown",
          tlsStatus: app.routing_tls_status ?? "unknown",
        },
      })
    }

    const caddy = new CaddyClient()
    let previousUpstream: { host: string; port: number } | null = null
    if (await hasActiveDeployLease(db, appId)) {
      return c.json({
        routing: {
          status: "action_required",
          issue: "runtime",
          error: "Deployment is still in progress",
          dnsStatus: app.routing_dns_status ?? "unknown",
          tlsStatus: app.routing_tls_status ?? "unknown",
        },
      })
    }
    const result = await withRoutingDeployLease({
      db,
      app,
      task: async () => {
        const currentApp = await getAppForOwner(db, appId, getUser(c).id)
        if (
          !currentApp ||
          currentApp.container_id !== app.container_id ||
          currentApp.domain !== app.domain ||
          currentApp.status !== app.status ||
          currentApp.updated_at?.getTime() !== app.updated_at?.getTime()
        ) {
          return null
        }
        try {
          target = await resolveHealthyRecheckTarget(db, currentApp)
        } catch {
          return null
        }
        previousUpstream =
          target.kind === "proxy" ? await caddy.getUpstream(appId) : null
        const routingLease = currentDeployLease()
        const routeResult = await publishHealthyAppRoute({
          db,
          appId,
          ...(routingLease?.buildId ? { buildId: routingLease.buildId } : {}),
          hostname: app.domain!,
          getCurrentRouteHost: () => caddy.getRouteHost(appId),
          proxied: app.cdn_mode === "external",
          beforePersist: fenceDeploySideEffect,
          applyRoute: async () => {
            if (target.kind === "static") {
              await fenceDeploySideEffect()
              await caddy.upsertStaticRoute({
                appId,
                host: app.domain!,
                root: target.root,
                spaFallback: target.spaFallback,
                cdn: app,
              })
              return
            }
            await fenceDeploySideEffect()
            await caddy.setUpstream(appId, app.domain!, target.upstream, {
              cdn: app,
            })
          },
          afterRoute: async () => {
            const aliases =
              target.kind === "static"
                ? await syncAppDomainAliases({
                    db,
                    appId,
                    static: {
                      root: target.root,
                      spaFallback: target.spaFallback,
                    },
                    caddy,
                    beforeSideEffect: fenceDeploySideEffect,
                  })
                : await syncAppDomainAliases({
                    db,
                    appId,
                    upstream: target.upstream,
                    caddy,
                    beforeSideEffect: fenceDeploySideEffect,
                  })
            if (aliases.errors.length) {
              throw new Error("Alias routing requires attention")
            }
          },
        })
        if (routeResult.routeApplied && target.kind === "proxy") {
          await cleanupRetainedDockerSlot(
            app,
            previousUpstream,
            target.upstream
          )
        }
        return routeResult
      },
    })
    if (!result) {
      return c.json({
        routing: {
          status: "action_required",
          issue: "runtime",
          error: "Deployment is still in progress",
          dnsStatus: app.routing_dns_status ?? "unknown",
          tlsStatus: app.routing_tls_status ?? "unknown",
        },
      })
    }
    const issue =
      result.dnsStatus !== "valid"
        ? "dns"
        : result.tlsStatus === "failed" || result.tlsStatus === "pending"
          ? "tls"
          : result.status === "action_required"
            ? "runtime"
            : null
    return c.json({
      routing: {
        status: result.status,
        issue,
        error: result.error,
        dnsStatus:
          result.dnsStatus === "error" ? "unknown" : result.dnsStatus,
        tlsStatus: result.tlsStatus,
      },
    })
  })

  // -------------------------------------------------------------------------
  // POST /apps — Create a new app
  // -------------------------------------------------------------------------

  router.post("/", appsWrite, appsDeploy, async (c) => {
    const user = getUser(c)

    let body: z.infer<typeof CreateAppBody>
    try {
      body = CreateAppBody.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }

    // Per-source-type field requirements (Phase 1.A/1.B).
    if (body.gitProvider === "image") {
      if (!body.imageRef) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "imageRef is required for image source",
            },
          },
          400
        )
      }
    } else if (!body.repoFullName || !body.branch) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "repoFullName and branch are required for git sources",
          },
        },
        400
      )
    }
    if (body.gitProvider === "gitlab" && !body.gitlabProjectId) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "gitlabProjectId is required for GitLab sources",
          },
        },
        400
      )
    }
    if (body.trackLatest && body.gitProvider !== "image") {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "trackLatest is only supported for image sources",
          },
        },
        400
      )
    }

    const gitLabConnected = await resolveGitLabConnection(db, user.id).then(
      () => true,
      () => false
    )
    if (body.gitProvider === "gitlab" && !gitLabConnected) {
      return c.json(
        {
          error: {
            code: "GIT_PROVIDER_NOT_CONNECTED",
            message: "Connect GitLab before creating a GitLab app",
          },
        },
        412
      )
    }
    if (
      body.gitProvider === "gitlab" &&
      body.gitlabProjectId &&
      body.repoFullName
    ) {
      try {
        await assertGitLabProjectSelection(db, {
          credentialUserId: user.id,
          projectId: body.gitlabProjectId,
          fullName: body.repoFullName,
          branch: body.branch!,
        })
      } catch {
        return c.json(
          {
            error: {
              code: "GITLAB_PROJECT_NOT_ACCESSIBLE",
              message:
                "The selected GitLab project is not accessible to this user",
            },
          },
          412
        )
      }
    }

    const now = new Date()

    // 1. Resolve organization/project id.
    let projectId: string
    const requestedOrganizationId = body.organizationId ?? body.projectId
    if (requestedOrganizationId) {
      const projectRows = await db
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(
          memberships,
          and(
            eq(memberships.org_id, projects.id),
            eq(memberships.user_id, user.id),
            eq(memberships.role, "owner"),
            isNotNull(memberships.accepted_at)
          )
        )
        .where(eq(projects.id, requestedOrganizationId))
        .limit(1)

      if (!projectRows[0]) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Organization not found" } },
          404
        )
      }
      projectId = projectRows[0].id
    } else {
      const organization = await ensureDefaultOrganizationForUser(
        db,
        user.id,
        user.display_name
      )
      projectId = organization.id
    }

    if (
      body.gitProvider === "github" &&
      (!body.installationId ||
        (!(await organizationHasGitHubInstallationGrant(
          db,
          projectId,
          body.installationId
        )) &&
          !(await userOwnsPersonalGitHubInstallation(
            db,
            user.id,
            body.installationId
          ))))
    ) {
      return c.json(
        {
          error: {
            code: "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
            message:
              "The selected GitHub installation is neither granted to this organization nor owned personally by this user",
          },
        },
        412
      )
    }

    const creationKey = body.idempotencyKey ?? null
    let existingCreationApp: AppRow | null = null
    if (creationKey) {
      const existing = await findAppByCreationKey(db, projectId, creationKey)
      if (existing) {
        existingCreationApp = existing
      }
    }

    let initialDatabaseVars: Record<string, string> | null = null
    let initialDatabaseId: string | null = null
    let initialDatabaseEnvPrefix: string | null = null
    if (body.initialDatabaseLink) {
      const dbRows = await db
        .select({ db: databases })
        .from(databases)
        .innerJoin(projects, eq(databases.project_id, projects.id))
        .innerJoin(
          memberships,
          and(
            eq(memberships.org_id, projects.id),
            eq(memberships.user_id, user.id),
            isNotNull(memberships.accepted_at)
          )
        )
        .where(eq(databases.id, body.initialDatabaseLink.databaseId))
        .limit(1)
      const dbRow = dbRows[0]?.db
      if (!dbRow || dbRow.project_id !== projectId) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Database not found" } },
          404
        )
      }
      if (dbRow.status !== "running") {
        return c.json(
          {
            error: {
              code: "DATABASE_NOT_READY",
              message: "Database must be running before linking",
            },
          },
          409
        )
      }

      let connString: string
      try {
        connString = await getConnectionString(dbRow)
      } catch {
        return c.json(
          {
            error: {
              code: "DATABASE_UNAVAILABLE",
              message: "Connection string not available",
            },
          },
          503
        )
      }

      initialDatabaseVars = parseConnectionString(
        dbRow.kind as
          "postgres" | "mysql" | "mariadb" | "redis" | "mongo" | "libsql",
        connString,
        body.initialDatabaseLink.envPrefix
      )
      initialDatabaseId = body.initialDatabaseLink.databaseId
      initialDatabaseEnvPrefix = body.initialDatabaseLink.envPrefix
    }

    // 2. Generate id + slug (unique within project)
    const id = existingCreationApp?.id ?? nanoid()
    const baseSlug = slugify(body.name) || "app"
    const slug =
      existingCreationApp?.slug ?? (await uniqueSlug(db, projectId, baseSlug))

    // 3. Compute and normalize the final host before persisting the app.
    const requestedDomain =
      existingCreationApp?.domain ?? body.domain ?? defaultAppDomain(slug, id)
    const domain = normalizeAppHostname(requestedDomain)
    if (!domain) {
      return c.json(
        {
          error: {
            code: "INVALID_DOMAIN",
            message:
              "Domain must be a hostname without a path, port, or credentials",
          },
        },
        400
      )
    }
    const domainSource = classifyAppDomain(
      domain,
      deriveDefaultAppDomainBase({
        explicitBase: env.PLOYDOK_DOMAIN_BASE,
        publicHost: env.PLOYDOK_PUBLIC_HOST,
      })
    )

    // Snapshot registry defaults alongside explicit user values.
    const presetFields = frameworkPresetCreateFields(body)
    const initialSecretRows = initialDatabaseVars
      ? (body.initialSecrets ?? []).filter(
          (item) => !Object.hasOwn(initialDatabaseVars!, item.key)
        )
      : (body.initialSecrets ?? [])
    const creationInput = JSON.stringify({
      initialSecrets: initialSecretRows,
      databaseVars: initialDatabaseVars,
      databaseId: initialDatabaseId,
      databaseEnvPrefix: initialDatabaseEnvPrefix,
    })
    const creationInputDigest = createHash("sha256")
      .update(creationInput)
      .digest("hex")
    const creationInputEncrypted = await encryptSecret(creationInput)
    let creationSaga = existingCreationApp
      ? await getCreationSaga(db, "application", id)
      : null
    if (existingCreationApp && !creationSaga) {
      return c.json({ app: serializeApp(existingCreationApp) }, 200)
    }

    // 5. INSERT
    let newApp: AppRow
    try {
      newApp =
        existingCreationApp ??
        (await db.transaction(async (tx) => {
          const txDb = tx as unknown as Db
          await lockDomain(txDb, domain)
          await assertDomainAvailable(txDb, domain)
          const inserted = await insertApp(tx as unknown as Db, {
            id,
            project_id: projectId,
            name: body.name,
            slug,
            status: "created",
            created_at: now,
            updated_at: now,
            git_provider: body.gitProvider,
            repo_full_name: body.repoFullName ?? null,
            branch: body.branch ?? null,
            github_installation_id: body.installationId ?? null,
            gitlab_project_id: body.gitlabProjectId ?? null,
            git_provider_installation_id:
              body.gitProvider === "github" && body.installationId
                ? `github:${body.installationId}`
                : body.gitProvider === "gitlab"
                  ? `gitlab:user:${user.id}`
                  : null,
            gitlab_credential_user_id:
              body.gitProvider === "gitlab" ? user.id : null,
            image_ref: body.imageRef ?? null,
            image_pull_policy: body.imagePullPolicy ?? null,
            registry_credential_id: body.registryCredentialId ?? null,
            track_latest: body.trackLatest ?? false,
            icon_url: body.iconUrl ?? null,
            quick_links: body.quickLinks
              ? JSON.stringify(body.quickLinks)
              : null,
            plan: body.plan ?? "custom",
            cpu_limit: body.cpuLimit ?? null,
            mem_limit_bytes: body.memLimitMB
              ? body.memLimitMB * 1024 * 1024
              : null,
            pids_limit: body.pidsLimit ?? null,
            root_dir: body.rootDir ?? null,
            dockerfile_path: body.dockerfilePath ?? null,
            nixpacks_config_path: body.nixpacksConfigPath ?? null,
            node_version: body.nodeVersion ?? null,
            framework_detection: null,
            watch_paths: body.watchPaths
              ? JSON.stringify(body.watchPaths)
              : null,
            ...presetFields,
            static_spa_fallback: body.staticSpaFallback ?? true,
            runtime_mode: body.runtime?.runtimeMode ?? "swarm",
            replicas: body.runtime?.replicas ?? 1,
            update_order: body.runtime?.updateOrder ?? "start-first",
            update_parallelism: body.runtime?.updateParallelism ?? 1,
            update_delay_s: body.runtime?.updateDelayS ?? 10,
            update_monitor_s: body.runtime?.updateMonitorS ?? 30,
            failure_action: body.runtime?.failureAction ?? "rollback",
            stop_grace_period_s: body.runtime?.stopGracePeriodS ?? 10,
            restart_policy: body.restartPolicy ?? "unless-stopped",
            domain,
            domain_source: domainSource,
            creation_idempotency_key: creationKey,
          })
          await createCreationSaga(tx, {
            resourceType: "application",
            resourceId: id,
            projectId,
            requestedByUserId: user.id,
            completedSteps: ["row_persisted"],
            inputCiphertext: creationInputEncrypted.enc,
            inputNonce: creationInputEncrypted.nonce,
            inputDigest: creationInputDigest,
          })
          return inserted
        }))
    } catch (err) {
      if (err instanceof InvalidAppDomainError || err instanceof DomainCollisionError) {
        return c.json(
          {
            error: {
              code: err.code,
              message: err.message,
              ...(err instanceof DomainCollisionError
                ? {
                    collisions: err.collisions.map((collision) => ({
                      resource: collision.resource,
                    })),
                  }
                : {}),
            },
          },
          err instanceof InvalidAppDomainError ? 400 : 409
        )
      }
      if (isUniqueDomainConstraintError(err)) {
        return c.json(
          {
            error: {
              code: "DOMAIN_CONFLICT",
              message: "Hostname is already in use",
            },
          },
          409
        )
      }
      if (
        creationKey &&
        isUniqueConstraintError(
          err,
          "apps_project_creation_idempotency_key_unique"
        )
      ) {
        const existing = await findAppByCreationKey(db, projectId, creationKey)
        if (existing) {
          return c.json({ app: serializeApp(existing) }, 200)
        }
      }
      throw err
    }

    await createCreationSaga(db, {
      resourceType: "application",
      resourceId: id,
      projectId,
      requestedByUserId: user.id,
      completedSteps: ["row_persisted"],
      inputCiphertext: creationInputEncrypted.enc,
      inputNonce: creationInputEncrypted.nonce,
      inputDigest: creationInputDigest,
    })
    creationSaga = await getCreationSaga(db, "application", id)
    if (existingCreationApp && creationSaga?.state === "complete") {
      return c.json({ app: serializeApp(existingCreationApp) }, 200)
    }
    const creationClaim = await claimCreationSaga(db, "application", id)
    if (!creationClaim) {
      return c.json(
        {
          error: {
            code: "CREATION_IN_PROGRESS",
            message: "Application creation is already being resumed",
          },
        },
        409
      )
    }
    await resumeApplicationConfiguration(
      db,
      creationClaim.saga,
      creationClaim.token
    )
    creationSaga = await getCreationSaga(db, "application", id)

    // Auto-inject framework-aware env vars (Nixpacks only, git sources only).
    // Runs best-effort — failure must never block app creation.
    const resolvedBuildMethod = presetFields.build_method ?? "auto"
    const shouldAutoInject =
      body.gitProvider === "github" &&
      body.installationId &&
      body.repoFullName &&
      body.branch &&
      (resolvedBuildMethod === "nixpacks" || resolvedBuildMethod === "auto")
    if (shouldAutoInject) {
      try {
        const probeResults: Record<string, boolean> = {}
        const probeKeys = Array.from(
          new Set([...ALL_PROBE_KEYS, ...MANIFEST_FILE_PROBE_KEYS])
        )
        await Promise.all(
          probeKeys.map(async (key) => {
            try {
              probeResults[key] = await ghProvider.fileExists(
                body.installationId!,
                body.repoFullName!,
                body.rootDir && body.rootDir !== "."
                  ? `${body.rootDir}/${key}`
                  : key,
                body.branch!
              )
            } catch {
              probeResults[key] = false
            }
          })
        )
        const manifests: ManifestContents = {}
        await Promise.all(
          MANIFEST_FILE_PROBE_KEYS.map(async (key) => {
            if (!probeResults[key]) return
            try {
              manifests[key] = await ghProvider.readFile(
                body.installationId!,
                body.repoFullName!,
                body.rootDir && body.rootDir !== "."
                  ? `${body.rootDir}/${key}`
                  : key,
                body.branch!
              )
            } catch {
              // best-effort manifest enrichment
            }
          })
        )
        const baseClassification = classifyStackWithManifests(
          probeResults,
          manifests
        )
        const detectedClassification = baseClassification
        const runtimeClassification = resolvedBuildMethod === "nixpacks"
          ? frameworkEnvClassificationForExplicitNixpacks(baseClassification, probeResults)
          : baseClassification
        const classification = body.frameworkPreset
          ? classificationForPreset(body.frameworkPreset, runtimeClassification)
          : runtimeClassification
        const detection = frameworkDetectionForClassification(
          detectedClassification,
          body.rootDir
        )
        newApp = await updateApp(db, id, {
          framework_detection: JSON.stringify(detection),
        })
        const { injected, skipped, repaired } = await ensureFrameworkEnvVars({
          db,
          appId: id,
          projectId,
          classification,
        })
        if (injected.length > 0 || skipped.length > 0 || repaired.length > 0) {
          childLogger("apps-autoinject").info(
            {
              appId: id,
              stack: classification.stack,
              injected,
              skipped,
              repaired,
            },
            "auto-inject env vars for detected framework (user values preserved)"
          )
        }
      } catch (err) {
        childLogger("apps-autoinject").warn(
          { err, appId: id },
          "auto-inject failed (non-fatal)"
        )
      }
    }

    const existingBuildRows = existingCreationApp
      ? await db
          .select({ id: builds.id })
          .from(builds)
          .where(eq(builds.app_id, id))
          .limit(1)
      : []
    const queuedAt = new Date()
    if (
      !(await fenceCreationSaga(db, "application", id, creationClaim.token))
    ) {
      return c.json(
        {
          error: {
            code: "CREATION_LEASE_LOST",
            message: "Application creation will be retried",
          },
        },
        409
      )
    }
    const accepted = existingBuildRows[0]
      ? { jobId: existingBuildRows[0].id }
      : await enqueueWithDbRow({
          db,
          queue: deployQueue,
          jobName: "deploy.requested",
          insertRow: async (tx) => {
            await tx
              .update(apps)
              .set({ status: "pending", updated_at: queuedAt })
              .where(eq(apps.id, id))

            return tx
              .insert(builds)
              .values({
                id: nanoid(),
                app_id: id,
                requested_by_user_id: user.id,
                source: "api",
              })
              .returning()
              .then((r: any[]) => r[0])
          },
          buildPayload: (row) => ({ buildId: row.id }),
          jobOptions: { attempts: 1 },
        })
    const jobRecorded = await recordClaimedCreationSagaStep(
      db,
      "application",
      id,
      creationClaim.token,
      "deploy_job_persisted",
      {
        jobId: accepted.jobId,
      }
    )
    if (
      !jobRecorded ||
      !(await completeClaimedCreationSaga(
        db,
        "application",
        id,
        creationClaim.token
      ))
    ) {
      return c.json(
        {
          error: {
            code: "CREATION_LEASE_LOST",
            message: "Application creation will be reconciled",
          },
        },
        409
      )
    }

    return c.json(
      {
        app: serializeApp({
          ...newApp,
          status: "pending",
          updated_at: queuedAt,
        }),
      },
      existingCreationApp ? 200 : 201
    )
  })

  // -------------------------------------------------------------------------
  // GET /apps — List apps for the authenticated user
  // -------------------------------------------------------------------------

  router.get("/", appsRead, async (c) => {
    const user = getUser(c)
    const organizationId =
      c.req.query("organizationId") ?? c.req.query("projectId") ?? undefined
    const rows = await listAppsForUser(db, user.id, organizationId)
    const reconciled = await reconcileAppStatusList(db, getSharedAgent(), rows)
    return c.json({ apps: reconciled.map(serializeAppPartial) })
  })

  // -------------------------------------------------------------------------
  // GET /apps/:id — App details + last 10 builds
  // -------------------------------------------------------------------------

  router.get("/:id", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const found = await getAppForUser(db, appId, user.id)
    if (!found) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const app = await reconcileAppStatus(db, getSharedAgent(), found)
    const appBuilds = await listBuildsForApp(db, appId, 10)

    return c.json({
      app: serializeApp(app, deriveCurrentBuildMetadata(appBuilds)),
      builds: appBuilds.map(serializeBuild),
    })
  })

  // -------------------------------------------------------------------------
  // PATCH /apps/:id — Update app config
  // -------------------------------------------------------------------------

  router.patch("/:id", appsWrite, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    // Verify ownership
    const existing = await getAppForOwner(db, appId, user.id)
    if (!existing) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    let body: z.infer<typeof PatchAppBody>
    try {
      body = PatchAppBody.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }
    if (
      body.trackLatest &&
      (body.gitProvider ?? existing.git_provider) !== "image"
    ) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "trackLatest is only supported for image sources",
          },
        },
        400
      )
    }

    const effectiveProvider = body.gitProvider ?? existing.git_provider
    const sourceSelectionChanged =
      body.gitProvider !== undefined ||
      body.repoFullName !== undefined ||
      body.branch !== undefined ||
      body.installationId !== undefined ||
      body.gitlabProjectId !== undefined
    if (sourceSelectionChanged && effectiveProvider === "github") {
      const installationId =
        body.installationId ?? existing.github_installation_id
      if (
        !installationId ||
        (!(await organizationHasGitHubInstallationGrant(
          db,
          existing.project_id,
          installationId
        )) &&
          !(await userOwnsPersonalGitHubInstallation(
            db,
            user.id,
            installationId
          )))
      ) {
        return c.json(
          {
            error: {
              code: "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
              message:
                "The selected GitHub installation is neither granted to this organization nor owned personally by this user",
            },
          },
          412
        )
      }
    }
    if (sourceSelectionChanged && effectiveProvider === "gitlab") {
      const projectId = body.gitlabProjectId ?? existing.gitlab_project_id
      const fullName = body.repoFullName ?? existing.repo_full_name
      const branch = body.branch ?? existing.branch
      if (!projectId || !fullName || !branch) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "GitLab project, repository and branch are required",
            },
          },
          400
        )
      }
      try {
        await assertGitLabProjectSelection(db, {
          credentialUserId: user.id,
          projectId,
          fullName,
          branch,
        })
      } catch {
        return c.json(
          {
            error: {
              code: "GITLAB_PROJECT_NOT_ACCESSIBLE",
              message:
                "The selected GitLab project or branch is not accessible",
            },
          },
          412
        )
      }
    }

    // Build update set — only provided fields
    const patch: Record<string, unknown> = { updated_at: new Date() }
    const restartPolicyChanged =
      body.restartPolicy !== undefined &&
      body.restartPolicy !== existing.restart_policy

    if (body.gitProvider !== undefined) patch.git_provider = body.gitProvider
    if (body.repoFullName !== undefined)
      patch.repo_full_name = body.repoFullName
    if (body.branch !== undefined) patch.branch = body.branch
    if (body.imageRef !== undefined) patch.image_ref = body.imageRef
    if (body.imagePullPolicy !== undefined)
      patch.image_pull_policy = body.imagePullPolicy
    if (body.registryCredentialId !== undefined)
      patch.registry_credential_id = body.registryCredentialId
    if (body.trackLatest !== undefined) {
      patch.track_latest = body.trackLatest
      if (!body.trackLatest) patch.pending_image_digest = null
    }
    if (body.iconUrl !== undefined) patch.icon_url = body.iconUrl
    if (body.quickLinks !== undefined)
      patch.quick_links = JSON.stringify(body.quickLinks)
    if (body.installationId !== undefined)
      patch.github_installation_id = body.installationId
    if (body.gitlabProjectId !== undefined)
      patch.gitlab_project_id = body.gitlabProjectId
    if (sourceSelectionChanged && effectiveProvider === "gitlab") {
      patch.git_provider_installation_id = `gitlab:user:${user.id}`
      patch.gitlab_credential_user_id = user.id
      patch.github_installation_id = null
    } else if (
      sourceSelectionChanged &&
      effectiveProvider === "github" &&
      (body.installationId ?? existing.github_installation_id)
    ) {
      patch.git_provider_installation_id = `github:${body.installationId ?? existing.github_installation_id}`
      patch.gitlab_credential_user_id = null
      patch.gitlab_project_id = null
    } else if (sourceSelectionChanged && effectiveProvider === "image") {
      patch.git_provider_installation_id = null
      patch.gitlab_credential_user_id = null
      patch.gitlab_project_id = null
      patch.github_installation_id = null
    }
    if (body.rootDir !== undefined) patch.root_dir = body.rootDir
    if (body.dockerfilePath !== undefined)
      patch.dockerfile_path = body.dockerfilePath
    if (body.nixpacksConfigPath !== undefined)
      patch.nixpacks_config_path = body.nixpacksConfigPath
    if (body.nodeVersion !== undefined) patch.node_version = body.nodeVersion
    if (body.watchPaths !== undefined)
      patch.watch_paths = JSON.stringify(body.watchPaths)
    if (body.staticSpaFallback !== undefined)
      patch.static_spa_fallback = body.staticSpaFallback
    if (body.runtime?.runtimeMode !== undefined)
      patch.runtime_mode = body.runtime.runtimeMode
    if (body.runtime?.replicas !== undefined)
      patch.replicas = body.runtime.replicas
    if (body.runtime?.updateOrder !== undefined)
      patch.update_order = body.runtime.updateOrder
    if (body.runtime?.updateParallelism !== undefined)
      patch.update_parallelism = body.runtime.updateParallelism
    if (body.runtime?.updateDelayS !== undefined)
      patch.update_delay_s = body.runtime.updateDelayS
    if (body.runtime?.updateMonitorS !== undefined)
      patch.update_monitor_s = body.runtime.updateMonitorS
    if (body.runtime?.failureAction !== undefined)
      patch.failure_action = body.runtime.failureAction
    if (body.runtime?.stopGracePeriodS !== undefined)
      patch.stop_grace_period_s = body.runtime.stopGracePeriodS
    if (body.restartPolicy !== undefined)
      patch.restart_policy = body.restartPolicy
    let domainChange: string | null = null
    if (body.domain !== undefined) {
      domainChange = normalizeAppHostname(body.domain)
      if (!domainChange) {
        return c.json(
          {
            error: {
              code: "INVALID_DOMAIN",
              message:
                "Domain must be a hostname without a path, port, or credentials",
            },
          },
          400
        )
      }
      patch.domain = domainChange
      patch.domain_source = classifyAppDomain(
        domainChange,
        deriveDefaultAppDomainBase({
          explicitBase: env.PLOYDOK_DOMAIN_BASE,
          publicHost: env.PLOYDOK_PUBLIC_HOST,
        })
      )
      patch.routing_status = "pending"
      patch.routing_error = null
      patch.routing_dns_status = null
      patch.routing_tls_status = null
    }
    if (body.keepPerRepo !== undefined) patch.keep_per_repo = body.keepPerRepo
    if (body.auto_deploy_enabled !== undefined)
      patch.auto_deploy_enabled = body.auto_deploy_enabled
    if (body.post_commit_status !== undefined)
      patch.post_commit_status = body.post_commit_status
    if (body.coalesce_pushes !== undefined)
      patch.coalesce_pushes = body.coalesce_pushes
    if (body.deploy_on_tag !== undefined)
      patch.deploy_on_tag = body.deploy_on_tag
    if (body.tag_pattern !== undefined) patch.tag_pattern = body.tag_pattern

    // Deploy hooks (Wave 5)
    if ("hooksPreDeploy" in body && body.hooksPreDeploy !== undefined)
      patch.hooks_pre_deploy = body.hooksPreDeploy
    if ("hooksPostDeploy" in body && body.hooksPostDeploy !== undefined)
      patch.hooks_post_deploy = body.hooksPostDeploy
    if ("hooksTimeoutS" in body && body.hooksTimeoutS !== undefined)
      patch.hooks_timeout_s = body.hooksTimeoutS

    Object.assign(patch, frameworkPresetPatchFields(existing, body))

    let updated: AppRow | null
    try {
      updated = domainChange
        ? await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db
            await lockDomain(txDb, domainChange!)
            await assertDomainAvailable(txDb, domainChange!, {
              excludeAppId: appId,
            })
            return updateApp(txDb, appId, patch)
          })
        : await updateApp(db, appId, patch)
    } catch (err) {
      if (err instanceof DomainCollisionError || isUniqueDomainConstraintError(err)) {
        return c.json(
          {
            error: {
              code: "DOMAIN_CONFLICT",
              message: "Hostname is already in use",
            },
          },
          409
        )
      }
      throw err
    }

    // Docker only applies restart policy at container creation time.
    // If a running app changes policy, immediately recreate the runtime so the
    // new policy from the DB becomes effective right away.
    let restartTriggered = false
    if (restartPolicyChanged && existing.status === "running") {
      const { restartApp } = await import("../worker/runner.js")
      // Background restart so the PATCH response (and the toast tied to it)
      // doesn't block on runBlueGreen — the badge transitions via SSE.
      await restartApp(appId, db, user.id, { background: true })
      restartTriggered = true
    }

    return c.json({ app: serializeApp(updated), restartTriggered })
  })

  // -------------------------------------------------------------------------
  // DELETE /apps/:id — Cascade delete (Coolify-style, async via job queue)
  //
  // Marks the app as 'deleting', enqueues an `app.delete.requested` job, and
  // returns 202. The worker performs: stop+rm containers, wipe registry
  // manifests and local images, remove Caddy route, rm build artifacts, delete
  // DB row (cascades builds/env_vars/domains via FK).
  // Scheduled registry GC reclaims orphan blobs separately.
  //
  // Coolify-style query flags (all default true):
  //   ?deleteImages=false        : keep registry manifests and local images
  //   ?dockerCleanup=false       — leave the container running
  //   ?deleteBuildArtifacts=false — keep ~/.ploydok-dev/builds/<appId>/
  //   ?deleteCaddyRoutes=false   — leave the Caddy upstream wired
  // -------------------------------------------------------------------------

  const DeleteAppQuery = z.object({
    deleteImages: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    dockerCleanup: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    deleteBuildArtifacts: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
    deleteCaddyRoutes: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === "true")),
  })

  router.get("/deletion-jobs/:jobId", appsRead, async (c) => {
    const user = getUser(c)
    const [job] = await db
      .select({
        id: app_delete_jobs.id,
        appId: app_delete_jobs.app_id,
        status: app_delete_jobs.status,
        errorMessage: app_delete_jobs.error_message,
        finishedAt: app_delete_jobs.finished_at,
      })
      .from(app_delete_jobs)
      .where(
        and(
          eq(app_delete_jobs.id, c.req.param("jobId")!),
          eq(app_delete_jobs.requested_by_user_id, user.id)
        )
      )
      .limit(1)
    if (!job) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Deletion job not found" } },
        404
      )
    }
    return c.json({
      job: {
        ...job,
        errorMessage: env.NODE_ENV === "prod" ? null : job.errorMessage,
      },
    })
  })

  router.delete("/:id", appsWrite, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const existing = await getAppForUser(db, appId, user.id)
    if (!existing) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    let flags: z.infer<typeof DeleteAppQuery>
    try {
      flags = DeleteAppQuery.parse({
        deleteImages: c.req.query("deleteImages"),
        dockerCleanup: c.req.query("dockerCleanup"),
        deleteBuildArtifacts: c.req.query("deleteBuildArtifacts"),
        deleteCaddyRoutes: c.req.query("deleteCaddyRoutes"),
      })
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }

    const normalizedFlags = {
      deleteImages: flags.deleteImages ?? true,
      dockerCleanup: flags.dockerCleanup ?? true,
      deleteBuildArtifacts: flags.deleteBuildArtifacts ?? true,
      deleteCaddyRoutes: flags.deleteCaddyRoutes ?? true,
    }

    const { jobId } = await enqueueAppDeleteJob({
      db,
      appId,
      requestedByUserId: user.id,
      flags: normalizedFlags,
    })

    childLogger("apps-delete").info(
      { appId, jobId, flags },
      "delete cascade enqueued"
    )

    try {
      eventBus.publish(`user:${user.id}`, {
        type: "app.delete.queued",
        appId,
        message: `${existing.name} suppression en file`,
        data: { jobId },
      })
    } catch (err) {
      childLogger("apps-delete").warn(
        { appId, jobId, err },
        "eventBus publish app.delete.queued failed (non-fatal)"
      )
    }

    return c.json({ ok: true, jobId, status: "deleting" }, 202)
  })

  // -------------------------------------------------------------------------
  // Stubs for endpoints owned by other milestones
  // -------------------------------------------------------------------------

  router.post("/:id/deploy", appsDeploy, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const { jobId, row } = await enqueueWithDbRow({
      db,
      queue: deployQueue,
      jobName: "deploy.requested",
      insertRow: (tx) =>
        tx
          .insert(builds)
          .values({
            id: nanoid(),
            app_id: appId,
            requested_by_user_id: user.id,
            source: "api",
          })
          .returning()
          .then((r: any[]) => r[0]),
      buildPayload: (row) => ({ buildId: row.id }),
      jobOptions: { attempts: 1 },
    })

    return c.json({ ok: true, jobId, buildId: row.id }, 202)
  })
  // stop / restart / rollback are implemented in the [M3.3 lifecycle] block below.
  router.get("/:id/builds", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100)
    const appBuilds = await listBuildsForApp(db, appId, limit)
    return c.json({ builds: appBuilds.map(serializeBuild) })
  })
  router.get("/:id/stats", appsRead, (c) =>
    c.json({ error: "not_implemented_m3_4" }, 501)
  )

  // GET /apps/:id/activity — historical activity timeline derived from builds.
  // Front-end seeds the SSE-driven feed with this so users see recent builds
  // even when the in-memory event ring buffer is cold (e.g. after API restart).
  router.get("/:id/activity", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100)
    const events = await getAppActivity(db, appId, limit)
    return c.json({ events })
  })
  // registry-usage implemented in [M4.2 registry — BEGIN/END] block below.

  // [M3.2 logs — BEGIN]
  // GET /apps/:id/logs?buildId=<buildId>
  // Downloads the archived log file for a build.
  // The file path is stored in builds.log_path (set by the build worker).
  // Returns the raw log as text/plain.
  router.get("/:id/logs", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const buildId = c.req.query("buildId")

    if (!buildId) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "buildId query param is required",
          },
        },
        400
      )
    }

    // Verify app ownership.
    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    // Load build row and verify it belongs to this app.
    const build = await getBuildLogPath(db, buildId, appId)
    if (!build) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Build not found" } },
        404
      )
    }

    // Resolution order:
    //   1. log_purged_at non-null → return explanatory body (purge happened).
    //   2. log_archive non-null  → decompress from DB (resilient: works even
    //      if the on-disk file was rm'd by the purge cron or volume loss).
    //   3. log_path or convention path on disk (live builds, freshly finished
    //      builds before the async archive job ran).
    //   4. Empty body, status 200.
    if (build.log_purged_at) {
      return new Response(
        `[Logs purged after ${env.PLOYDOK_BUILD_LOG_RETENTION_DAYS} days retention]`,
        {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "x-log-source": "purged",
          },
        }
      )
    }

    if (build.log_archive) {
      try {
        const decompressed = decompressLog(build.log_archive)
        return new Response(decompressed, {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": `attachment; filename="build-${buildId}.log"`,
            "x-log-source": "archive",
          },
        })
      } catch (err) {
        // Archive corrupt — fall through to filesystem fallback.
        console.warn(
          `decompressLog failed for buildId=${buildId}:`,
          err instanceof Error ? err.message : err
        )
      }
    }

    const conventionPath = nodePath.join(
      env.PLOYDOK_BUILD_DIR,
      appId,
      `${buildId}.log`
    )
    const candidatePath = build.log_path ?? conventionPath

    let content: Buffer | null = null
    try {
      content = await readFile(candidatePath)
    } catch {
      if (build.log_path && build.log_path !== conventionPath) {
        try {
          content = await readFile(conventionPath)
        } catch {
          // both paths missing — fall through to empty body
        }
      }
    }

    if (!content) {
      return new Response("(no logs captured)", {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "x-log-source": "empty",
        },
      })
    }

    return new Response(content, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="build-${buildId}.log"`,
        "x-log-source": "file",
      },
    })
  })

  router.get("/:id/runtime-logs", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const source = runtimeLogSource(c.req.query("source"))
    if (!source)
      return c.json(
        { error: { code: "INVALID_SOURCE", message: "Invalid log source" } },
        400
      )
    const tailRaw = Number(c.req.query("tail") ?? 200)
    const tail = Number.isFinite(tailRaw)
      ? Math.max(1, Math.min(Math.floor(tailRaw), 1_000))
      : 200

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    if (source !== "app" && !(await getAppForOwner(db, appId, user.id))) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }
    try {
      const requestLines =
        source === "app" ? [] : await getRequestLogs(db).snapshot(appId, tail)
      if (source === "requests") {
        return c.json({ lines: requestLines, containerFound: true })
      }
      const agent = getSharedAgent()
      const resolvedContainerId = await resolveAppRuntimeContainerId(
        db,
        appId,
        app.container_id
      )
      const provenance = await appLogSource(
        agent,
        appId,
        resolvedContainerId,
        c.req.query("container")
      )
      const container = provenance?.containers[provenance.index]
      if (!container) {
        return c.json({ lines: requestLines, containerFound: source === "all" })
      }

      const lines: Array<{
        t: number
        line: string
        stream?: "stdout" | "stderr"
      }> = []
      for await (const line of agent.containerLogs({
        containerId: container.id,
        follow: false,
        sinceUnix: 0,
        tail,
      })) {
        const entry: { t: number; line: string; stream?: "stdout" | "stderr" } =
          {
            t: Date.parse(line.timestamp) || Date.now(),
            line: line.line,
          }
        if (line.stream === "stdout" || line.stream === "stderr") {
          entry.stream = line.stream
        }
        lines.push(entry)
      }

      return c.json({
        lines: [...lines, ...requestLines]
          .sort((a, b) => a.t - b.t)
          .slice(-tail),
        containerFound: true,
        ...provenance,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "RUNTIME_LOGS_ERROR", message } }, 500)
    }
  })

  // Also replace the former stub for /:id/builds/:buildId/logs with a redirect
  // to the canonical log download endpoint above.
  router.get("/:id/builds/:buildId/logs", appsRead, (c) => {
    const appId = c.req.param("id") ?? ""
    const buildId = c.req.param("buildId") ?? ""
    return c.redirect(`/apps/${appId}/logs?buildId=${buildId}`, 302)
  })

  // POST /:id/builds/:buildId/cancel — cancel a running build.
  // Persists cancellation intent, removes only this build's queued job, and
  // lets the lease heartbeat abort supported active child processes.
  router.post(
    "/:id/builds/:buildId/cancel",
    appsDeploy,
    ownerOnly,
    sf,
    async (c) => {
      const user = getUser(c)
      const appId = c.req.param("id")!
      const buildId = c.req.param("buildId")!

      const app = await getAppForUser(db, appId, user.id)
      if (!app) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "App not found" } },
          404
        )
      }

      const build = await getBuildForApp(db, buildId, appId)
      if (!build) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Build not found" } },
          404
        )
      }

      if (
        build.status === "succeeded" ||
        build.status === "succeeded_with_warning" ||
        build.status === "failed" ||
        build.status === "cancelled"
      ) {
        return c.json(
          {
            error: {
              code: "INVALID_STATE",
              message: `Build is already in terminal state: ${build.status}`,
            },
          },
          409
        )
      }

      // Persist intent before touching BullMQ. An active worker observes this
      // through its heartbeat/fence and aborts cancellable child processes.
      const cancellation = await requestBuildCancellation(db, {
        buildId,
        appId,
        requestedByUserId: user.id,
        reason: `Cancelled by user ${user.email ?? user.id}`,
      })
      if (!cancellation) {
        return c.json(
          {
            error: {
              code: "INVALID_STATE",
              message: "Build reached a terminal state before cancellation",
            },
          },
          409
        )
      }

      // Remove only this build's BullMQ job. A later deployment for the same
      // app is a legitimate successor and must remain queued.
      try {
        await removeQueuedDeployBuild(deployQueue, buildId)
      } catch (err) {
        childLogger("apps-cancel-build").warn(
          { err, appId, buildId },
          "failed to remove BullMQ jobs (non-fatal)"
        )
      }

      try {
        eventBus.publish(`user:${user.id}`, {
          type: "build.cancelled",
          appId,
          buildId,
          message: "Build annulé",
          data: { status: "cancelled" },
        })
      } catch (pubErr) {
        childLogger("apps-cancel-build").warn(
          { pubErr, appId, buildId, userId: user.id },
          "eventBus publish build.cancelled failed (non-fatal)"
        )
      }

      childLogger("apps-cancel-build").info(
        { appId, buildId, userId: user.id },
        "build cancelled by user"
      )

      return c.json({ ok: true })
    }
  )
  // [M3.2 logs — END]

  // [M3.3 lifecycle — BEGIN]
  const RuntimePatchBody = AppRuntimeSettingsSchema.partial()
  const ScaleBody = z.object({ replicas: z.number().int().min(1).max(10) })

  router.get("/:id/runtime", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }
    const { listSwarmTasks } = await import("../worker/swarm-runner.js")
    const tasks =
      app.runtime_mode === "swarm" ? await listSwarmTasks(appId, db) : []
    return c.json({
      runtimeMode: app.runtime_mode,
      swarmServiceName: app.swarm_service_name,
      replicas: app.replicas,
      updateOrder: app.update_order,
      updateParallelism: app.update_parallelism,
      updateDelayS: app.update_delay_s,
      updateMonitorS: app.update_monitor_s,
      failureAction: app.failure_action,
      stopGracePeriodS: app.stop_grace_period_s,
      tasks,
    })
  })

  router.patch("/:id/runtime", appsWrite, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }
    let body: z.infer<typeof RuntimePatchBody>
    try {
      body = RuntimePatchBody.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (body.runtimeMode !== undefined) patch.runtime_mode = body.runtimeMode
    if (body.replicas !== undefined) patch.replicas = body.replicas
    if (body.updateOrder !== undefined) patch.update_order = body.updateOrder
    if (body.updateParallelism !== undefined)
      patch.update_parallelism = body.updateParallelism
    if (body.updateDelayS !== undefined)
      patch.update_delay_s = body.updateDelayS
    if (body.updateMonitorS !== undefined)
      patch.update_monitor_s = body.updateMonitorS
    if (body.failureAction !== undefined)
      patch.failure_action = body.failureAction
    if (body.stopGracePeriodS !== undefined)
      patch.stop_grace_period_s = body.stopGracePeriodS

    await db.update(apps).set(patch).where(eq(apps.id, appId))
    return c.json({ ok: true })
  })

  router.post("/:id/scale", appsDeploy, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }
    let body: z.infer<typeof ScaleBody>
    try {
      body = ScaleBody.parse(await c.req.json())
    } catch (err) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: String(err) } },
        400
      )
    }
    try {
      const { scaleSwarmApp } = await import("../worker/swarm-runner.js")
      if (app.runtime_mode !== "swarm") {
        await db
          .update(apps)
          .set({ replicas: body.replicas, updated_at: new Date() })
          .where(eq(apps.id, appId))
        return c.json({ ok: true, pendingDeploy: true })
      }
      await scaleSwarmApp(appId, body.replicas, db)
      return c.json({ ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "SCALE_FAILED", message } }, 500)
    }
  })

  // POST /apps/:id/rollback — roll back to the previous succeeded build
  // POST /apps/:id/stop    — stop both containers + remove Caddy route
  // POST /apps/:id/restart — stop + re-deploy from last succeeded build image
  // All routes require auth + ownership.

  const RollbackBody = z.object({
    buildId: z.string().optional(),
  })

  router.post("/:id/rollback", appsDeploy, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    // Parse optional body — empty body is also valid (legacy behaviour)
    let body: z.infer<typeof RollbackBody> = {}
    try {
      const raw = await c.req.text()
      if (raw.trim()) {
        body = RollbackBody.parse(JSON.parse(raw))
      }
    } catch {
      return c.json(
        {
          error: { code: "VALIDATION_ERROR", message: "Invalid request body" },
        },
        400
      )
    }

    // If an explicit buildId is provided, validate it exists and has status succeeded
    if (body.buildId) {
      const targetBuild = await getBuildForApp(db, body.buildId, appId)
      if (!targetBuild) {
        return c.json(
          {
            error: {
              code: "NOT_FOUND",
              message: "Build not found for this app",
            },
          },
          404
        )
      }
      if (targetBuild.status !== "succeeded" && targetBuild.status !== "succeeded_with_warning") {
        return c.json(
          {
            error: {
              code: "INVALID_BUILD_STATUS",
              message: `Cannot rollback to build with status '${targetBuild.status}': only successful builds are allowed`,
            },
          },
          400
        )
      }
    }

    // The response only confirms that the rollback started under the app
    // lease. The runtime switch itself (Swarm update monitor, health gate)
    // continues afterwards and reports through the event bus, like deploy,
    // stop and restart: a client waiting for completion would hit its own
    // timeout before Swarm finishes.
    type RollbackStart = { kind: "ok" | "conflict" | "invalid_target" }
    const rollbackLogger = childLogger("apps-rollback")
    let settleStart!: (start: RollbackStart | null) => void
    let failStart!: (error: unknown) => void
    let started = false
    const startPromise = new Promise<RollbackStart | null>((resolve, reject) => {
      settleStart = (start) => {
        started = true
        resolve(start)
      }
      failStart = reject
    })
    const publishRollback = (status: "completed" | "failed", message: string, error?: string) => {
      try {
        eventBus.publish(`user:${user.id}`, {
          type: "deploy.status_change",
          appId,
          message,
          data: { rollback: status, ...(error ? { error } : {}) },
        })
      } catch (pubErr) {
        rollbackLogger.warn({ pubErr, appId }, "eventBus publish rollback status failed (non-fatal)")
      }
    }
    void withRoutingDeployLease({
      db,
      app,
      task: async () => {
        const currentApp = await getAppForUser(db, appId, user.id)
        if (
          !currentApp ||
          currentApp.container_id !== app.container_id ||
          currentApp.domain !== app.domain ||
          currentApp.status !== app.status ||
          currentApp.updated_at?.getTime() !== app.updated_at?.getTime()
        ) {
          settleStart({ kind: "conflict" })
          return false
        }
        if (body.buildId) {
          const targetBuild = await getBuildForApp(db, body.buildId, appId)
          if (
            !targetBuild ||
            (targetBuild.status !== "succeeded" &&
              targetBuild.status !== "succeeded_with_warning")
          ) {
            settleStart({ kind: "invalid_target" })
            return false
          }
        }
        settleStart({ kind: "ok" })
        if (currentApp.runtime_mode === "swarm") {
          const { rollbackSwarmApp } =
            await import("../worker/swarm-runner.js")
          await rollbackSwarmApp(appId, db, body.buildId)
        } else {
          const { rollbackApp } = await import("../worker/runner.js")
          await rollbackApp(appId, db, body.buildId, undefined)
        }
        return true
      },
    })
      .then((completed) => {
        if (!started) {
          settleStart(null)
          return
        }
        if (completed) {
          publishRollback("completed", "Rollback applied")
          return
        }
        // The lease was lost after the switch began: the runtime may hold
        // either build. Reconciliation restores the route from the database.
        rollbackLogger.warn({ appId }, "rollback lost its deploy lease")
        publishRollback("failed", "Rollback interrupted", "deploy lease lost")
      })
      .catch((error: unknown) => {
        if (!started) {
          failStart(error)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        rollbackLogger.error({ err: error, appId }, "rollback failed after start")
        publishRollback("failed", "Rollback failed", message)
      })

    try {
      const rollbackResult = await startPromise
      if (!rollbackResult) {
        return c.json(
          {
            error: {
              code: "ROLLBACK_CONFLICT",
              message: "The app changed or a deployment is in progress",
            },
          },
          409
        )
      }
      if (rollbackResult.kind === "conflict") {
        return c.json(
          {
            error: {
              code: "ROLLBACK_CONFLICT",
              message: "The app changed while rollback was starting",
            },
          },
          409
        )
      }
      if (rollbackResult.kind === "invalid_target") {
        return c.json(
          {
            error: {
              code: "INVALID_BUILD_STATUS",
              message: "The rollback target is no longer successful",
            },
          },
          409
        )
      }
      return c.json({ ok: true, accepted: true }, 202)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "ROLLBACK_FAILED", message } }, 500)
    }
  })

  router.post("/:id/stop", appsDeploy, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    try {
      const { stopApp } = await import("../worker/runner.js")
      const { stopSwarmApp } = await import("../worker/swarm-runner.js")
      try {
        eventBus.publish(`user:${user.id}`, {
          type: "app.stop.queued",
          appId,
          message: "Arrêt de l'app en cours",
          data: { status: app.status },
        })
      } catch (pubErr) {
        childLogger("apps-stop").warn(
          { pubErr, appId, userId: user.id },
          "eventBus publish app.stop.queued failed (non-fatal)"
        )
      }

      const stopPromise =
        app.runtime_mode === "swarm"
          ? stopSwarmApp(appId, db)
          : stopApp(appId, db)
      void stopPromise
        .then(() => {
          try {
            eventBus.publish(`user:${user.id}`, {
              type: "deploy.status_change",
              appId,
              message: "App arrêtée",
              data: { status: "stopped" },
            })
            eventBus.publish(`user:${user.id}`, {
              type: "app.stopped",
              appId,
              message: "App arrêtée",
              data: { status: "stopped" },
            })
          } catch (pubErr) {
            childLogger("apps-stop").warn(
              { pubErr, appId, userId: user.id },
              "eventBus publish app.stopped failed (non-fatal)"
            )
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          childLogger("apps-stop").error(
            { err, appId, userId: user.id },
            "background app stop failed"
          )
          try {
            eventBus.publish(`user:${user.id}`, {
              type: "deploy.status_change",
              appId,
              message: `Arrêt échoué: ${message}`,
              data: { status: "failed" },
            })
            eventBus.publish(`user:${user.id}`, {
              type: "app.stop.failed",
              appId,
              message: `Arrêt échoué: ${message}`,
              data: { status: "failed" },
            })
          } catch (pubErr) {
            childLogger("apps-stop").warn(
              { pubErr, appId, userId: user.id },
              "eventBus publish app.stop.failed failed (non-fatal)"
            )
          }
        })

      return c.json({ ok: true }, 202)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "STOP_FAILED", message } }, 500)
    }
  })

  router.post("/:id/restart", appsDeploy, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    try {
      const { restartApp } = await import("../worker/runner.js")
      // Await only the prelude (build precheck + DB write to "restarting" +
      // SSE event); stop + redeploy run in the background so the response
      // returns before runBlueGreen's onLive emits the "running" event.
      // Otherwise the front sees the SSE flip status to "running" before the
      // mutation promise resolves, inverting toast/badge ordering.
      await restartApp(appId, db, user.id, { background: true })
      return c.json({ ok: true }, 202)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "RESTART_FAILED", message } }, 500)
    }
  })
  // [M3.3 lifecycle — END]

  // [M4.2 registry — BEGIN]
  // GET  /apps/:id/registry-usage  — per-app registry stats (requires auth + ownership).
  // POST /apps/:id/registry-gc     — trigger an immediate GC prune for this app (owner only).

  router.get("/:id/registry-usage", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    try {
      const { getRegistryUsageForApp } =
        await import("../worker/handlers/gc-registry.js")
      const usage = await getRegistryUsageForApp(appId, db)
      return c.json(usage)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "REGISTRY_ERROR", message } }, 500)
    }
  })

  router.post("/:id/registry-gc", appsDeploy, ownerOnly, sf, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const app = await getAppForUser(db, appId, user.id)
    if (!app) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    try {
      const { jobId } = await enqueueWithDbRow({
        db,
        queue: gcQueue,
        jobName: "gc.registry.requested",
        insertRow: (tx) =>
          tx
            .insert(system_jobs)
            .values({
              id: nanoid(),
              kind: "gc.registry",
              requested_by_user_id: user.id,
              source: "api",
              options: {
                appId: app.id,
                keepPerRepo: app.keep_per_repo ?? 3,
              },
            })
            .returning()
            .then((r: (typeof system_jobs.$inferSelect)[]) => r[0]!),
        buildPayload: (row) => ({ jobId: row.id }),
      })
      return c.json({ ok: true, jobId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { code: "GC_FAILED", message } }, 500)
    }
  })
  // [M4.2 registry — END]

  // [Wave-3 webhooks — BEGIN]

  // -------------------------------------------------------------------------
  // GET /apps/:id/webhook-deliveries — list deliveries (cursor pagination)
  // -------------------------------------------------------------------------

  router.get("/:id/webhook-deliveries", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!

    const limitRaw = Math.min(Number(c.req.query("limit") ?? 50), 200)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50
    const cursor = c.req.query("cursor")

    const result = await listDeliveriesByApp(db, appId, user.id, limit, cursor)
    if (result === null) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "App not found" } },
        404
      )
    }

    return c.json(result)
  })

  // -------------------------------------------------------------------------
  // GET /apps/:id/webhook-deliveries/:deliveryId — single delivery detail
  // -------------------------------------------------------------------------

  router.get("/:id/webhook-deliveries/:deliveryId", appsRead, async (c) => {
    const user = getUser(c)
    const appId = c.req.param("id")!
    const deliveryId = c.req.param("deliveryId")!

    const delivery = await getDeliveryById(db, appId, deliveryId, user.id)
    if (delivery === null) {
      return c.json(
        { error: { code: "NOT_FOUND", message: "Delivery not found" } },
        404
      )
    }

    return c.json({ delivery })
  })

  // -------------------------------------------------------------------------
  // POST /apps/:id/webhook-secret/rotate — rotate per-app webhook secret
  // Protected by requireTotpVerified. Anti-abuse: 409 if rotated < 24h ago.
  // -------------------------------------------------------------------------

  const totpMw = requireTotpVerified(db)

  router.post(
    "/:id/webhook-secret/rotate",
    appsWrite,
    ownerOnly,
    totpMw,
    async (c) => {
      const user = getUser(c)
      const appId = c.req.param("id")!

      const app = await getAppForUser(db, appId, user.id)
      if (!app) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "App not found" } },
          404
        )
      }

      // Anti-abuse: reject if the existing old secret hasn't expired yet (< 24h since last rotation)
      const now = new Date()
      if (
        app.webhook_secret_old_expires_at &&
        app.webhook_secret_old_expires_at > now
      ) {
        return c.json(
          {
            code: "rotation_cooldown",
            message: "A rotation already happened in the last 24h",
          },
          409
        )
      }

      const newSecretPlain = randomBytes(32).toString("hex")
      const { enc, nonce } = await encryptField(newSecretPlain)
      // Store as nonce (12 bytes) || enc concatenated in a single bytea
      const newSecretBlob = Buffer.concat([nonce, enc])

      // Move current secret → old before overwriting
      await rotateAppWebhookSecret(
        db,
        appId,
        app.webhook_secret ?? null,
        newSecretBlob,
        now
      )

      // Audit
      await insertAuditLog(db, {
        user_id: user.id,
        action: "webhook.secret.rotated",
        target_type: "app",
        target_id: appId,
        created_at: now,
      })

      childLogger("apps-webhook-secret").info(
        { appId, userId: user.id },
        "webhook secret rotated"
      )

      // Notification dispatch — webhook.rotated (best-effort, non-fatal)
      const redisForNotify = createRedis(env.REDIS_URL)
      notifyDispatch(
        db,
        redisForNotify,
        "webhook.rotated",
        {
          appId: app.id,
          appName: app.name,
        },
        { userId: user.id, projectId: app.project_id ?? undefined }
      )
        .catch((err) =>
          childLogger("apps-webhook-secret").warn(
            { err, appId },
            "dispatch webhook.rotated failed (non-fatal)"
          )
        )
        .finally(() => redisForNotify.disconnect())

      // Return plain secret once — caller must copy it to GitHub/GitLab
      return c.json({ secret: newSecretPlain })
    }
  )

  // -------------------------------------------------------------------------
  // POST /apps/:id/webhook-deliveries/:deliveryId/replay — replay a delivery
  // Protected by TOTP. Anti-abuse: max 10 replays per parent delivery → 429.
  // -------------------------------------------------------------------------

  router.post(
    "/:id/webhook-deliveries/:deliveryId/replay",
    appsDeploy,
    ownerOnly,
    totpMw,
    async (c) => {
      const user = getUser(c)
      const appId = c.req.param("id")!
      const deliveryId = c.req.param("deliveryId")!

      // Verify ownership
      const app = await getAppForUser(db, appId, user.id)
      if (!app) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "App not found" } },
          404
        )
      }

      try {
        const newDeliveryId = await replayDelivery(db, deliveryId, appId)

        // Audit
        await insertAuditLog(db, {
          user_id: user.id,
          action: "webhook.replayed",
          target_type: "app",
          target_id: appId,
          metadata: JSON.stringify({
            delivery_id: deliveryId,
            new_delivery_id: newDeliveryId,
          }),
        })

        childLogger("apps-webhook-replay").info(
          { appId, userId: user.id, deliveryId, newDeliveryId },
          "delivery replayed"
        )

        return c.json({ delivery_id: newDeliveryId })
      } catch (err) {
        if (err instanceof ReplayLimitError) {
          return c.json({ code: err.code, message: err.message }, 429)
        }
        if (err instanceof ReplayPayloadMissingError) {
          return c.json({ code: err.code, message: err.message }, 422)
        }
        if (err instanceof Error && err.message === "Delivery not found") {
          return c.json(
            { error: { code: "NOT_FOUND", message: "Delivery not found" } },
            404
          )
        }
        throw err
      }
    }
  )

  // [Wave-3 webhooks — END]

  return router
}

// ---------------------------------------------------------------------------
// Prod singleton — imported by app.ts
// ---------------------------------------------------------------------------

const prodDb = createDb(env.DATABASE_URL)
export const appsRouter = createAppsRouter(prodDb)
