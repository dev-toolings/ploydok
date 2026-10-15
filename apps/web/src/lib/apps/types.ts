// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AppQuickLink,
  AppRuntimeSettings,
  AppStatus,
  Build,
  BuildStatus,
  FrameworkDetection,
  FrameworkPresetId,
  RestartPolicy,
} from "@ploydok/shared"

export interface AppListItem {
  id: string
  organizationId?: string
  projectId?: string
  name: string
  slug: string
  status: AppStatus
  branch?: string
  domain?: string
  publicUrl?: string
  repoFullName?: string
  imageRef?: string | null
  /** apps.container_id — the canonical container the runner wrote at last
   * successful deploy. Null when the app has never been deployed. */
  containerId?: string | null
  createdAt: number
  updatedAt: number
  iconUrl?: string | null
  quickLinks?: Array<AppQuickLink>
  trackLatest?: boolean
  lastImageDigest?: string | null
  pendingImageDigest?: string | null
}
export interface AppDetail extends AppListItem {
  gitProvider?: string
  imagePullPolicy?: "always" | "if_not_present" | null
  rootDir?: string
  dockerfilePath?: string
  nixpacksConfigPath?: string
  nodeVersion?: string
  installCommand?: string
  buildCommand?: string
  startCommand?: string
  buildMethod?: string
  frameworkPreset?: FrameworkPresetId | null
  frameworkDetection?: FrameworkDetection
  staticOutputDir?: string
  staticSpaFallback?: boolean
  runtimePort?: number | null
  runtime?: Partial<AppRuntimeSettings> & {
    swarmServiceName?: string | null
  }
  restartPolicy?: RestartPolicy
  currentCommitSha?: string
  latestBuildId?: string
  healthcheckPath?: string
  healthcheckPort?: number | null
  // Healthcheck timing fields (W2.B fix — were silently dropped by normalizeAppDetail)
  healthcheckIntervalS?: number | null
  healthcheckTimeoutS?: number | null
  healthcheckRetries?: number | null
  healthcheckStartPeriodS?: number | null
  // Auto-deploy + webhook settings (sprint 3.1.1)
  autoDeployEnabled?: boolean
  postCommitStatus?: boolean
  coalescePushes?: boolean
  deployOnTag?: boolean
  tagPattern?: string | null
  webhookSecret?: boolean
  // Deploy hooks (Wave 5)
  hooksPreDeploy?: string | null
  hooksPostDeploy?: string | null
  hooksTimeoutS?: number | null
  // Last 10 builds included in GET /apps/:id response
  builds?: Array<Build>
}

export interface RawAppListItem extends Omit<
  AppListItem,
  "createdAt" | "updatedAt"
> {
  createdAt: number | string
  updatedAt: number | string
}

export interface AppsResponse {
  apps: Array<RawAppListItem>
}

export interface BuildsResponse {
  builds: Array<Build>
}

// Backend serializes healthcheck as a nested object. Normalize to the flat
// shape used by the UI (forms, caches, components read `app.healthcheckPath`
// and `app.healthcheckPort` directly).
export interface RawAppDetail extends Omit<
  AppDetail,
  | "createdAt"
  | "updatedAt"
  | "healthcheckPath"
  | "healthcheckPort"
  | "healthcheckIntervalS"
  | "healthcheckTimeoutS"
  | "healthcheckRetries"
  | "healthcheckStartPeriodS"
> {
  createdAt: number | string
  updatedAt: number | string
  healthcheck?: {
    path?: string | null
    port?: number | null
    intervalS?: number | null
    timeoutS?: number | null
    retries?: number | null
    startPeriodS?: number | null
  } | null
}

type AppSettingsPatchValues = Omit<
  Pick<
    AppDetail,
    | "branch"
    | "rootDir"
    | "dockerfilePath"
    | "nixpacksConfigPath"
    | "nodeVersion"
    | "installCommand"
    | "buildCommand"
    | "startCommand"
    | "buildMethod"
    | "frameworkPreset"
    | "staticOutputDir"
    | "staticSpaFallback"
    | "runtimePort"
    | "runtime"
    | "restartPolicy"
    | "healthcheckPath"
    | "healthcheckPort"
    | "autoDeployEnabled"
    | "postCommitStatus"
    | "coalescePushes"
    | "deployOnTag"
    | "tagPattern"
    | "hooksPreDeploy"
    | "hooksPostDeploy"
    | "hooksTimeoutS"
    | "iconUrl"
    | "quickLinks"
    | "trackLatest"
  >,
  "installCommand" | "buildCommand" | "startCommand"
>

export type AppSettingsPatch = Partial<AppSettingsPatchValues> & {
  installCommand?: string | null
  buildCommand?: string | null
  startCommand?: string | null
}

export interface AppStatusEventPayload {
  appId?: string
  data?: {
    status?: AppStatus
  }
}

export interface BuildStatusEventPayload {
  appId?: string
  buildId?: string
  message?: string
  t?: number
  data?: {
    status?: AppStatus | BuildStatus
    imageTag?: string
    containerId?: string
    errorMessage?: string | null
  }
}

export interface UseAppOptions {
  /** Seed TanStack Query's cache with pre-fetched data (e.g. from a route loader). */
  initialData?: AppDetail
  /** Subscribe to build/deploy SSE events and patch the app cache. */
  subscribeToEvents?: boolean
}

export interface UseBuildsOptions {
  /** Seed TanStack Query's cache with pre-fetched data (e.g. from a route loader or GET /apps/:id). */
  initialData?: Array<Build>
}

export interface RegistryUsage {
  tags: number
  bytes: number
  diskPct: number
}
