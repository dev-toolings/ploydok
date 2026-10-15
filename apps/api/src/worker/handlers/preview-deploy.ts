// SPDX-License-Identifier: AGPL-3.0-only
import path from "node:path"
import { rm } from "node:fs/promises"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { apps, projects } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { ContainerHealthStatus } from "@ploydok/agent-proto"
import {
  getPreviewDeployment,
  getLastSucceededBuild,
  updatePreviewDeployment,
  updatePreviewDeploymentStatus,
} from "@ploydok/db/queries"
import {
  ALL_PROBE_KEYS,
  MANIFEST_FILE_PROBE_KEYS,
  PLANS,
  classifyStackWithManifests,
  frameworkGuardrailDefaults,
  classificationForPreset,
  getFrameworkPreset,
  FRAMEWORK_PRESETS,
} from "@ploydok/shared"
import type { ManifestContents, StackClassification } from "@ploydok/shared"
import {
  getInstallationToken,
  listAppInstallations,
} from "../../github/installation-tokens"
import {
  assertDeployableFrameworkEnv,
  ensureFrameworkEnvVars,
} from "../../services/framework-env"
import {
  imageRepoForApp,
  runtimeContainerShortId,
} from "../../services/runtime-containers"
import { buildEnvPairForDeploy } from "../../secrets/resolver"
import { ensureCaddyOnProjectNetwork } from "../../caddy/attachment"
import {
  caddyStaticRootForApp,
  dispatchStaticDeploy,
  gcOldShas,
  promoteSha,
} from "./build-static"
import { getSharedAgent, getSharedCaddy } from "../../debug/singletons"
import { env } from "../../env"
import { resolveFrameworkPresetConfig } from "../../services/framework-preset"
import { detectDockerfilePort } from "../detect-port"
import { detectBuildMethod } from "../detect"
import { resolveRepositoryRoot } from "../repository-targets"
import { buildImage } from "../buildkit"
import { cloneRepo, cleanupWorkspace } from "../git"
import { workerLog } from "../logger"
import { nixpacksBuild } from "../nixpacks"
import { ensureProjectNetwork, networksForApp } from "../../services/projects"
import { isNotFound, toAgentError } from "../../agent"
import { isSymfonyFlexWorkspace } from "./symfony-detect"
import { FatalDeployError } from "../errors"
import { healthcheckShell } from "../healthcheck-shell"

const log = workerLog.child({ subsystem: "preview-deploy" })
const STOP_TIMEOUT_S = 10

const PreviewDeployPayloadSchema = z.object({
  appId: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string().regex(/^[0-9a-f]{7,40}$/i),
})

interface AppForPreview {
  id: string
  project_id: string
  slug: string
  git_provider: string | null
  repo_full_name: string | null
  branch: string | null
  github_installation_id: string | null
  root_dir: string | null
  dockerfile_path: string | null
  nixpacks_config_path: string | null
  node_version: string | null
  install_command: string | null
  build_command: string | null
  start_command: string | null
  build_method: string | null
  framework_preset: string | null
  static_output_dir: string | null
  static_spa_fallback: boolean | null
  runtime_port: number | null
  restart_policy: string | null
  preview_enabled: boolean
  healthcheck_path: string | null
  healthcheck_port: number | null
  healthcheck_interval_s: number | null
  healthcheck_timeout_s: number | null
  healthcheck_retries: number | null
  healthcheck_start_period_s: number | null
  plan: string | null
  cpu_limit: number | null
  mem_limit_bytes: number | null
  pids_limit: number | null
  owner_id: string
}

function sanitizeToken(value: string, maxLen = 20): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
  return normalized || "app"
}

export function previewResourceId(appId: string, prNumber: number): string {
  return `preview-${sanitizeToken(appId, 16)}-${runtimeContainerShortId(appId)}-pr-${prNumber}`
}

function previewContainerName(
  appId: string,
  prNumber: number,
  headSha: string
): string {
  return `ploydok-${previewResourceId(appId, prNumber)}-${sanitizeToken(
    headSha,
    12
  )}`.slice(0, 63)
}

function previewWorkspaceBuildId(prNumber: number, headSha: string): string {
  return `preview-pr-${prNumber}-${sanitizeToken(headSha, 12)}`
}

function previewImageRepoForApp(appId: string): string {
  return `preview-${imageRepoForApp(appId)}`
}

function previewCloneUrl(repoFullName: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repoFullName}.git`
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, "")
}

async function getAppForPreview(db: Db, appId: string): Promise<AppForPreview> {
  const rows = await db
    .select({
      id: apps.id,
      project_id: apps.project_id,
      slug: apps.slug,
      git_provider: apps.git_provider,
      repo_full_name: apps.repo_full_name,
      branch: apps.branch,
      github_installation_id: apps.github_installation_id,
      root_dir: apps.root_dir,
      dockerfile_path: apps.dockerfile_path,
      nixpacks_config_path: apps.nixpacks_config_path,
      node_version: apps.node_version,
      install_command: apps.install_command,
      build_command: apps.build_command,
      start_command: apps.start_command,
      build_method: apps.build_method,
      framework_preset: apps.framework_preset,
      static_output_dir: apps.static_output_dir,
      static_spa_fallback: apps.static_spa_fallback,
      runtime_port: apps.runtime_port,
      restart_policy: apps.restart_policy,
      preview_enabled: apps.preview_enabled,
      healthcheck_path: apps.healthcheck_path,
      healthcheck_port: apps.healthcheck_port,
      healthcheck_interval_s: apps.healthcheck_interval_s,
      healthcheck_timeout_s: apps.healthcheck_timeout_s,
      healthcheck_retries: apps.healthcheck_retries,
      healthcheck_start_period_s: apps.healthcheck_start_period_s,
      plan: apps.plan,
      cpu_limit: apps.cpu_limit,
      mem_limit_bytes: apps.mem_limit_bytes,
      pids_limit: apps.pids_limit,
      owner_id: projects.owner_id,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .where(eq(apps.id, appId))
    .limit(1)

  const row = rows[0]
  if (!row) throw new Error(`App not found: ${appId}`)
  return row
}

async function resolveInstallationTokenForPreview(
  app: AppForPreview
): Promise<string> {
  if (!app.repo_full_name) {
    throw new Error(`App ${app.id} has no repo_full_name`)
  }

  if (app.github_installation_id) {
    return getInstallationToken(app.github_installation_id)
  }

  const ownerLogin = app.repo_full_name.split("/")[0]?.toLowerCase() ?? ""
  const installations = await listAppInstallations()
  const match = installations.find(
    (item) => item.accountLogin.toLowerCase() === ownerLogin
  )
  if (!match) {
    throw new Error(
      `No GitHub App installation grants access to ${app.repo_full_name}`
    )
  }
  return getInstallationToken(String(match.id))
}

async function checkoutPreviewHead(
  workspacePath: string,
  headSha: string
): Promise<string> {
  const fetchProc = Bun.spawn(
    ["git", "-C", workspacePath, "fetch", "--depth", "1", "origin", headSha],
    { stdout: "pipe", stderr: "pipe" }
  )
  const fetchCode = await fetchProc.exited
  if (fetchCode !== 0) {
    const stderr = await new Response(fetchProc.stderr).text()
    throw new Error(
      `git fetch failed (${fetchCode}) for preview sha ${headSha}: ${stderr.trim()}`
    )
  }

  const checkoutProc = Bun.spawn(
    ["git", "-C", workspacePath, "checkout", "--detach", "FETCH_HEAD"],
    { stdout: "pipe", stderr: "pipe" }
  )
  const checkoutCode = await checkoutProc.exited
  if (checkoutCode !== 0) {
    const stderr = await new Response(checkoutProc.stderr).text()
    throw new Error(
      `git checkout failed (${checkoutCode}) for preview sha ${headSha}: ${stderr.trim()}`
    )
  }

  const headProc = Bun.spawn(
    ["git", "-C", workspacePath, "rev-parse", "HEAD"],
    { stdout: "pipe", stderr: "pipe" }
  )
  const headCode = await headProc.exited
  if (headCode !== 0) {
    const stderr = await new Response(headProc.stderr).text()
    throw new Error(`git rev-parse failed: ${stderr.trim()}`)
  }

  return (await new Response(headProc.stdout).text()).trim()
}

async function classifyWorkspaceStack(params: {
  workspacePath: string
  rootDir: string | null
}): Promise<StackClassification> {
  const root = path.join(params.workspacePath, params.rootDir ?? ".")
  const probes: Partial<Record<(typeof ALL_PROBE_KEYS)[number], boolean>> = {}
  await Promise.all(
    ALL_PROBE_KEYS.map(async (key) => {
      probes[key] = await Bun.file(path.join(root, key)).exists()
    })
  )
  const manifests: ManifestContents = {}
  await Promise.all(
    MANIFEST_FILE_PROBE_KEYS.map(async (key) => {
      const file = Bun.file(path.join(root, key))
      if (!(await file.exists())) return
      if (file.size > 64 * 1024) return
      manifests[key] = await file.text()
    })
  )
  const base = classifyStackWithManifests(probes, manifests)
  if (base.stack !== "php" && base.stack !== "compose") return base
  if (!(await isSymfonyFlexWorkspace(root))) return base
  return {
    ...base,
    stack: "symfony",
    framework: "Symfony",
    presetId: "symfony",
    preset: FRAMEWORK_PRESETS.symfony,
    confidence: "high",
    suggestedEnvVars: {
      NIXPACKS_PHP_ROOT_DIR: "/app/public",
      NIXPACKS_PHP_FALLBACK_PATH: "/index.php",
      NIXPACKS_INSTALL_CMD:
        "mkdir -p /var/log/nginx /var/cache/nginx && COMPOSER_ALLOW_SUPERUSER=1 composer install --no-interaction --no-progress --prefer-dist --ignore-platform-reqs --optimize-autoloader",
    },
  }
}

function defaultRuntimePortForStack(
  method: "docker" | "nixpacks" | "static",
  classification: StackClassification
): number | null {
  if (method !== "nixpacks") return null
  return frameworkGuardrailDefaults(classification).defaults.runtimePort ?? null
}

function resolveResourceLimits(
  app: AppForPreview
): { cpu: number; memoryBytes: number; pidsLimit: number } | undefined {
  const planName = app.plan ?? "custom"
  const planLimits = PLANS[planName as keyof typeof PLANS] ?? null

  const cpu = app.cpu_limit ?? planLimits?.cpu ?? 0
  const memMB = planLimits?.memMB ?? 0
  const memoryBytes =
    app.mem_limit_bytes ?? (memMB > 0 ? memMB * 1024 * 1024 : 0)
  const pidsLimit = app.pids_limit ?? planLimits?.pids ?? 0

  if (cpu === 0 && memoryBytes === 0 && pidsLimit === 0) {
    return undefined
  }
  return { cpu, memoryBytes, pidsLimit }
}

function containerEnvWithPort(
  values: Record<string, string>,
  runtimePort: number
): Record<string, string> {
  return { ...values, PORT: String(runtimePort) }
}

function healthcheckConfig(app: AppForPreview, runtimePort: number) {
  const hcPath = app.healthcheck_path ?? "/"
  const hcPort = app.healthcheck_port ?? runtimePort

  return {
    path: hcPath,
    port: hcPort,
    intervalSeconds: app.healthcheck_interval_s ?? 5,
    timeoutSeconds: app.healthcheck_timeout_s ?? 3,
    retries: app.healthcheck_retries ?? 6,
    startPeriodSeconds: app.healthcheck_start_period_s ?? 30,
    config: {
      test: ["CMD-SHELL", healthcheckShell(hcPort, hcPath)],
      intervalSeconds: app.healthcheck_interval_s ?? 5,
      timeoutSeconds: app.healthcheck_timeout_s ?? 3,
      retries: app.healthcheck_retries ?? 6,
      startPeriodSeconds: app.healthcheck_start_period_s ?? 30,
    },
  }
}

async function pullPreviewImage(
  image: string,
  onLog: (line: string) => void
): Promise<void> {
  const agent = getSharedAgent()
  let lastStatus = ""
  for await (const frame of agent.imagePull({
    image,
    registryAuth: undefined,
  })) {
    const status = frame.status ?? ""
    if (status && status !== lastStatus) {
      lastStatus = status
      onLog(`[preview] pull: ${status}`)
    }
  }
}

async function waitForPreviewHealth(params: {
  containerId: string
  app: AppForPreview
  onLog: (line: string) => void
}): Promise<boolean> {
  const agent = getSharedAgent()
  const check = healthcheckConfig(params.app, params.app.runtime_port ?? 3000)

  if (check.startPeriodSeconds > 0) {
    params.onLog(
      `[preview] health grace period ${check.startPeriodSeconds}s before probing`
    )
    await Bun.sleep(check.startPeriodSeconds * 1_000)
  }

  for (let attempt = 1; attempt <= check.retries; attempt++) {
    await Bun.sleep(check.intervalSeconds * 1_000)
    const resp = await agent.inspectContainerHealth({
      containerId: params.containerId,
    })
    if (resp.containerMissing) {
      params.onLog("[preview] health failed: container disappeared")
      return false
    }
    switch (resp.status) {
      case ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY:
        params.onLog(`[preview] health OK (${attempt}/${check.retries})`)
        return true
      case ContainerHealthStatus.CONTAINER_HEALTH_STATUS_STARTING:
        params.onLog(`[preview] health starting (${attempt}/${check.retries})`)
        break
      case ContainerHealthStatus.CONTAINER_HEALTH_STATUS_UNHEALTHY:
        params.onLog(`[preview] health unhealthy (${attempt}/${check.retries})`)
        break
      default:
        params.onLog("[preview] health unavailable")
        return false
    }
  }
  return false
}

async function stopPreviewContainer(
  containerRef: string | null
): Promise<void> {
  if (!containerRef) return
  const agent = getSharedAgent()
  try {
    await agent.containerStop({
      containerId: containerRef,
      timeoutSeconds: STOP_TIMEOUT_S,
    })
  } catch (error) {
    if (!isNotFound(toAgentError(error))) {
      log.warn({ containerRef, error }, "preview stop failed")
    }
  }

  try {
    await agent.containerRemove({
      containerId: containerRef,
      force: true,
      removeVolumes: false,
    })
  } catch (error) {
    if (!isNotFound(toAgentError(error))) {
      log.warn({ containerRef, error }, "preview remove failed")
    }
  }
}

async function restorePreviousPreviewRoute(params: {
  app: AppForPreview
  previewDomain: string
  previewId: string
  resourceId: string
  previousHeadSha: string | null
  previousContainerRef: string | null
}): Promise<void> {
  const caddy = getSharedCaddy()
  if (params.previousContainerRef) {
    const port = params.app.runtime_port ?? 3000
    await caddy.upsertRoute({
      appId: params.resourceId,
      host: params.previewDomain,
      upstream: `${params.previousContainerRef}:${port}`,
    })
    return
  }

  if (params.previousHeadSha) {
    try {
      await promoteSha(params.resourceId, params.previousHeadSha)
      await caddy.upsertStaticRoute({
        appId: params.resourceId,
        host: params.previewDomain,
        root: caddyStaticRootForApp(params.resourceId),
        spaFallback: params.app.static_spa_fallback ?? true,
      })
      return
    } catch (error) {
      log.warn(
        { previewId: params.previewId, error },
        "failed to restore previous static preview"
      )
    }
  }

  await caddy.removeRoute(params.resourceId)
}

async function runLoggedCommand(
  args: string[],
  opts: { cwd?: string; onLog?: (line: string) => void } = {}
): Promise<void> {
  const proc = Bun.spawn(args, {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    if (line) opts.onLog?.(line)
  }
  if (code !== 0) {
    throw new Error(`${args[0]} failed (exit ${code})`)
  }
}

/**
 * Build and deploy a preview environment for a PR using the existing
 * clone/build/Caddy/container primitives. This deliberately excludes volumes,
 * hooks, scheduled jobs, backups and CDN side-effects because there is no
 * preview-safe contract for them yet.
 */
export async function handlePreviewDeploy(
  db: Db,
  payload: unknown
): Promise<void> {
  const parsed = PreviewDeployPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues }, "invalid preview deploy payload")
    throw new Error("Invalid preview deploy payload")
  }

  const { appId, prNumber, headSha } = parsed.data
  const previewId = `${appId}:pr-${prNumber}`
  const app = await getAppForPreview(db, appId)
  const preview = await getPreviewDeployment(db, previewId)

  if (!preview) {
    throw new Error(`Preview deployment not found: ${previewId}`)
  }
  if (!app.preview_enabled) {
    throw new Error(`Preview deployments are disabled for app ${appId}`)
  }
  if (!preview.domain) {
    throw new Error(`Preview deployment ${previewId} has no domain`)
  }
  const previewDomain = preview.domain
  if (app.git_provider !== "github") {
    throw new Error(
      "Preview deployments currently support GitHub app sources only"
    )
  }
  if (!app.repo_full_name || !app.branch) {
    throw new Error(`App ${appId} is missing repo_full_name or branch`)
  }
  if (app.build_method === "compose") {
    throw new Error("Preview deployments do not support compose apps yet")
  }

  const resourceId = previewResourceId(appId, prNumber)
  const previousContainerRef = preview.container_id
  const previousHeadSha = preview.head_sha
  const workspaceBuildId = previewWorkspaceBuildId(prNumber, headSha)
  let workspacePath: string | null = null
  let newContainerRef: string | null = null

  const onLog = (line: string): void => {
    log.debug({ previewId }, line)
  }

  try {
    if (app.build_method === "railpack") {
      throw new Error(
        "Railpack previews are planned but not available in agent-only production"
      )
    }
    log.info({ appId, prNumber, headSha }, "starting preview deploy")
    await updatePreviewDeployment(db, previewId, {
      head_sha: headSha,
      status: "building",
    })

    const token = await resolveInstallationTokenForPreview(app)
    const cloneResult = await cloneRepo({
      repoCloneUrl: previewCloneUrl(app.repo_full_name, token),
      buildDir: env.PLOYDOK_BUILD_DIR,
      appId,
      buildId: workspaceBuildId,
      branch: app.branch,
    })
    workspacePath = cloneResult.workspacePath

    const resolvedHeadSha = await checkoutPreviewHead(workspacePath, headSha)
    const selectedPreset = getFrameworkPreset(app.framework_preset)
    if (app.framework_preset != null && !selectedPreset) {
      throw new FatalDeployError(
        "Stored framework preset is invalid; select a preset again"
      )
    }
    const presetFields = resolveFrameworkPresetConfig({
      framework_preset: app.framework_preset,
      install_command: app.install_command,
      build_command: app.build_command,
      start_command: app.start_command,
      build_method: app.build_method,
      static_output_dir: app.static_output_dir,
      runtime_port: app.runtime_port,
      healthcheck_path: app.healthcheck_path,
      healthcheck_port: app.healthcheck_port,
      healthcheck_interval_s: app.healthcheck_interval_s,
      healthcheck_timeout_s: app.healthcheck_timeout_s,
      healthcheck_retries: app.healthcheck_retries,
      healthcheck_start_period_s: app.healthcheck_start_period_s,
    })
    const installCommand = presetFields.install_command
    const buildCommand = presetFields.build_command
    const startCommand = presetFields.start_command
    const previousSuccessfulBuild =
      !selectedPreset &&
      (app.build_method === null || app.build_method === "auto")
        ? await getLastSucceededBuild(db, app.id)
        : null
    const allowLegacyAmbiguous = Boolean(previousSuccessfulBuild)
    const resolvedRoot = await resolveRepositoryRoot({
      workspacePath,
      rootDir: app.root_dir,
      hasExplicitConfig:
        Boolean(
          app.dockerfile_path ||
          app.nixpacks_config_path ||
          installCommand ||
          buildCommand ||
          startCommand ||
          Boolean(selectedPreset)
        ) || ![null, "auto", "nixpacks"].includes(app.build_method),
      allowLegacyAmbiguous,
      onWarning: (warning) => {
        log.warn(
          { previewId, warning },
          "preview detection compatibility warning"
        )
        onLog(`[preview] warning: ${warning}`)
      },
    })
    if (resolvedRoot !== app.root_dir) {
      app.root_dir = resolvedRoot
    }

    const buildMethod = presetFields.build_method
    const normalizedMethod =
      buildMethod === "docker" || buildMethod === "dockerfile"
        ? "docker"
        : buildMethod === "nixpacks"
          ? "nixpacks"
          : buildMethod === "static"
            ? "static"
            : buildMethod === "compose"
              ? "compose"
              : "auto"

    const detected = await detectBuildMethod({
      workspacePath,
      override: normalizedMethod,
      frameworkPreset: app.framework_preset,
      allowLegacyAmbiguous,
      onWarning: (warning) => {
        log.warn(
          { previewId, warning },
          "preview detection compatibility warning"
        )
        onLog(`[preview] warning: ${warning}`)
      },
      ...(app.root_dir ? { rootDir: app.root_dir } : {}),
      ...(app.dockerfile_path ? { dockerfilePath: app.dockerfile_path } : {}),
    })

    if (detected.method === "compose") {
      throw new FatalDeployError("Preview deployments do not support compose apps yet")
    }

    const detectedClassification = await classifyWorkspaceStack({
      workspacePath,
      rootDir: app.root_dir,
    })
    const classification = selectedPreset
      ? classificationForPreset(selectedPreset.id, detectedClassification)
      : detectedClassification
    const inferredStartCommand = startCommand ??
      (selectedPreset ? null : classification.suggestedStartCommand ?? null)
    await ensureFrameworkEnvVars({
      db,
      appId: app.id,
      projectId: app.project_id,
      classification,
    })

    let runtimePort = app.runtime_port
    if (detected.method === "docker" && runtimePort == null) {
      const dockerfilePath = path.join(
        workspacePath,
        app.root_dir ?? ".",
        detected.dockerfilePath ?? "Dockerfile"
      )
      runtimePort = await detectDockerfilePort(dockerfilePath)
    }
    if (detected.method !== "static" && runtimePort == null) {
      runtimePort = defaultRuntimePortForStack(detected.method, classification)
    }
    if (detected.method !== "static" && runtimePort == null) {
      runtimePort = 3000
    }
    if (detected.method !== "static" && runtimePort == null) {
      throw new Error("Preview runtime port could not be resolved")
    }

    const { build: buildEnvRaw, runtime: runtimeEnvRaw } =
      await buildEnvPairForDeploy(db, app.id, "preview")
    const platformEnv = {
      PLOYDOK_APP_ID: app.id,
      PLOYDOK_PREVIEW: "1",
      PLOYDOK_PR_NUMBER: String(prNumber),
      PLOYDOK_COMMIT_SHA: resolvedHeadSha,
    }
    const buildEnv = { ...platformEnv, ...buildEnvRaw }
    const runtimeEnv = { ...platformEnv, ...runtimeEnvRaw }
    assertDeployableFrameworkEnv(classification, runtimeEnv)

    if (detected.method === "static") {
      await dispatchStaticDeploy(
        resourceId,
        resolvedHeadSha,
        app.static_output_dir ?? presetFields.static_output_dir ?? "dist",
        {
          workspacePath,
          rootDir: app.root_dir,
          installCommand,
          buildCommand,
          env: buildEnv,
          onLog,
        }
      )

      await getSharedCaddy().upsertStaticRoute({
        appId: resourceId,
        host: previewDomain,
        root: caddyStaticRootForApp(resourceId),
        spaFallback: app.static_spa_fallback ?? true,
      })

      try {
        await updatePreviewDeployment(db, previewId, {
          head_sha: resolvedHeadSha,
          status: "running",
          container_id: null,
        })
      } catch (error) {
        await restorePreviousPreviewRoute({
          app,
          previewDomain,
          previewId,
          resourceId,
          previousHeadSha,
          previousContainerRef,
        })
        throw error
      }

      if (previousContainerRef) {
        await stopPreviewContainer(previousContainerRef)
      }
      await gcOldShas(resourceId, 3).catch((error) => {
        log.warn({ previewId, error }, "preview static gc failed")
      })
      log.info(
        { appId, prNumber, headSha: resolvedHeadSha },
        "preview static deploy complete"
      )
      return
    }

    const repo = previewImageRepoForApp(app.id)
    const registryHost = stripScheme(env.PLOYDOK_REGISTRY_URL)
    const registryPushHost = stripScheme(env.PLOYDOK_REGISTRY_PUSH_URL)
    const pushRef = `${registryPushHost}/${repo}:${resolvedHeadSha}`
    const imageRef = `${registryHost}/${repo}:${resolvedHeadSha}`

    if (detected.method === "docker") {
      const contextDir = path.join(workspacePath, app.root_dir ?? ".")
      const dockerfileRel = detected.dockerfilePath ?? "Dockerfile"
      await buildImage({
        contextDir,
        dockerfile: path.join(contextDir, dockerfileRel),
        imageRef: pushRef,
        cacheDir: path.join(env.PLOYDOK_BUILD_DIR, app.id, ".buildkit-cache"),
        buildSecrets: buildEnv,
        onLog,
      })
    } else {
      const nixpacksCache = path.join(
        env.PLOYDOK_BUILD_DIR,
        app.id,
        ".nixpacks-cache"
      )
      const generated = await nixpacksBuild({
        workspacePath,
        tag: pushRef,
        cacheKey: resourceId,
        cacheDir: nixpacksCache,
        ...(app.root_dir ? { rootDir: app.root_dir } : {}),
        ...(app.nixpacks_config_path
          ? { configFile: app.nixpacks_config_path }
          : {}),
        ...(app.node_version ? { nodeVersion: app.node_version } : {}),
        ...(installCommand ? { installCmd: installCommand } : {}),
        ...(buildCommand ? { buildCmd: buildCommand } : {}),
        ...(inferredStartCommand ? { startCmd: inferredStartCommand } : {}),
        ...(Object.keys(buildEnv).length > 0 ? { buildEnv } : {}),
        ...(Object.keys(runtimeEnv).length > 0 ? { runtimeEnv } : {}),
        onLog,
      })
      try {
        await buildImage({
          contextDir: generated.contextDir,
          dockerfile: generated.dockerfile,
          imageRef: pushRef,
          cacheDir: nixpacksCache,
          onLog,
        })
      } finally {
        await rm(generated.contextDir, { recursive: true, force: true })
      }
    }

    const resolvedRuntimePort = runtimePort ?? 3000
    const projectNetwork = await ensureProjectNetwork(
      db,
      app.project_id,
      getSharedAgent()
    )
    await ensureCaddyOnProjectNetwork(getSharedAgent(), projectNetwork)
    const networks = networksForApp(projectNetwork)
    const hc = healthcheckConfig(
      {
        ...app,
        runtime_port: resolvedRuntimePort,
        healthcheck_path: presetFields.healthcheck_path,
        healthcheck_port: presetFields.healthcheck_port,
        healthcheck_interval_s: presetFields.healthcheck_interval_s,
        healthcheck_timeout_s: presetFields.healthcheck_timeout_s,
        healthcheck_retries: presetFields.healthcheck_retries,
        healthcheck_start_period_s: presetFields.healthcheck_start_period_s,
      },
      resolvedRuntimePort
    )
    const resourceLimits = resolveResourceLimits(app)

    await pullPreviewImage(imageRef, onLog)
    newContainerRef = previewContainerName(app.id, prNumber, resolvedHeadSha)

    const created = await getSharedAgent().containerCreate({
      name: newContainerRef,
      image: imageRef,
      env: containerEnvWithPort(runtimeEnv, resolvedRuntimePort),
      labels: {
        "ploydok.kind": "preview",
        "ploydok.app_id": app.id,
        "ploydok.owner_id": app.owner_id,
        "ploydok.preview_id": previewId,
        "ploydok.pr_number": String(prNumber),
      },
      network: "",
      networks,
      volumes: [],
      ports: [],
      restartPolicy: app.restart_policy ?? "unless-stopped",
      resourceLimits: resourceLimits ?? undefined,
      command: [],
      user: "",
      healthcheck: hc.config,
    })
    await getSharedAgent().containerStart({ containerId: created.containerId })

    const healthy = await waitForPreviewHealth({
      containerId: created.containerId,
      app: { ...app, runtime_port: resolvedRuntimePort },
      onLog,
    })
    if (!healthy) {
      throw new Error("Preview container did not become healthy")
    }

    await getSharedCaddy().upsertRoute({
      appId: resourceId,
      host: previewDomain,
      upstream: `${newContainerRef}:${resolvedRuntimePort}`,
    })

    try {
      await updatePreviewDeployment(db, previewId, {
        head_sha: resolvedHeadSha,
        status: "running",
        container_id: newContainerRef,
      })
    } catch (error) {
      await restorePreviousPreviewRoute({
        app,
        previewDomain,
        previewId,
        resourceId,
        previousHeadSha,
        previousContainerRef,
      })
      await stopPreviewContainer(newContainerRef)
      newContainerRef = null
      throw error
    }

    if (previousContainerRef && previousContainerRef !== newContainerRef) {
      await stopPreviewContainer(previousContainerRef)
    }

    log.info(
      {
        appId,
        prNumber,
        headSha: resolvedHeadSha,
        containerRef: newContainerRef,
      },
      "preview deploy complete"
    )
  } catch (error) {
    log.error({ appId, prNumber, error }, "preview deploy failed")
    await updatePreviewDeploymentStatus(db, previewId, "failed")
    if (newContainerRef) {
      await stopPreviewContainer(newContainerRef)
    }
    throw error
  } finally {
    if (workspacePath) {
      await cleanupWorkspace(
        appId,
        workspaceBuildId,
        env.PLOYDOK_BUILD_DIR
      ).catch((error) => {
        log.warn({ appId, prNumber, error }, "preview workspace cleanup failed")
      })
    }
  }
}
