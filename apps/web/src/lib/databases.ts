// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import i18n from "./i18n"
import { DEFAULT_DATABASE_ENV_PREFIX } from "./database-env"
import { getDatabaseListRefreshInterval } from "./database-list"
import { notifyMutationError } from "./second-factor-toast"

// ── Types ─────────────────────────────────────────────────────────────────────

export type DbKind =
  "postgres" | "mysql" | "mariadb" | "redis" | "mongo" | "libsql"
export type DbPlan = "small" | "medium" | "large"
export type DbStatus =
  "creating" | "starting" | "running" | "stopped" | "degraded" | "failed"
export type DbHealthStatus =
  "unknown" | "starting" | "healthy" | "degraded" | "unhealthy"
export type DbExposureMode = "internal" | "direct_port" | "public_proxy"
export type DbManagementMode = "managed" | "external"

export interface Database {
  organization_id?: string
  id: string
  project_id: string
  kind: DbKind
  version: string
  name: string
  plan: DbPlan
  management_mode: DbManagementMode
  status: DbStatus
  health_status: DbHealthStatus
  host: string | null
  port: number | null
  internal_host: string | null
  internal_port: number | null
  exposure_mode: DbExposureMode
  public_enabled: boolean
  public_host: string | null
  public_port: number | null
  public_url: string | null
  rotation_schedule: "manual" | "30d" | "60d" | "90d"
  rotation_in_progress: boolean
  password_rotated_at: string | null
  last_started_at: string | null
  created_at: string
  backup_enabled?: boolean
  backup_deadline_at?: string | null
  latest_backup_status?: "running" | "succeeded" | "failed" | null
  latest_backup_at?: string | null
  last_successful_backup_at?: string | null
  linked_apps?: Array<{
    app_id: string
    app_name: string | null
    app_slug: string | null
    env_prefix: string
  }>
  connections?: {
    internal: {
      host: string | null
      port: number | null
    }
    public: null | {
      exposure_mode: DbExposureMode
      host: string | null
      port: number | null
      url: string | null
    }
  }
}

export interface CreateDatabaseInput {
  organizationId?: string
  projectId: string
  kind: DbKind
  name: string
  plan: DbPlan
  exposureMode?: DbExposureMode
  publicEnabled?: boolean
  idempotencyKey?: string
}

export interface RegisterExternalDatabaseInput {
  organizationId?: string
  projectId: string
  name: string
  connectionString: string
}

export interface DatabaseStats {
  cpu_percent: number
  memory_bytes: number
  memory_limit_bytes: number
  net_rx_bytes: number
  net_tx_bytes: number
  timestamp_ns: number
}

export interface AdminerSessionLaunch {
  path: string
  expires_at: string
  driver: "pgsql" | "server"
  server: string
  database: string
  username: string
}

export interface RevealedDatabaseCredentials {
  connection_string: string
  password?: string
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const databaseKeys = {
  all: ["databases"] as const,
  list: (projectId?: string) =>
    ["databases", "list", projectId ?? "all"] as const,
  detail: (id: string) => ["databases", "detail", id] as const,
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useDatabases(
  projectId?: string,
  options: { enabled?: boolean } = {}
) {
  const enabled = options.enabled ?? true

  return useQuery({
    queryKey: databaseKeys.list(projectId),
    queryFn: async () => {
      const url = projectId ? `/databases?projectId=${projectId}` : "/databases"
      return apiFetch<Array<Database>>(url)
    },
    enabled,
    refetchInterval: (query) =>
      getDatabaseListRefreshInterval(query.state.data),
  })
}

export function useDatabase(id: string) {
  return useQuery({
    queryKey: databaseKeys.detail(id),
    queryFn: async () => apiFetch<Database>(`/databases/${id}`),
    enabled: Boolean(id),
  })
}

export function useCreateDatabase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateDatabaseInput) => {
      return apiFetch<{ id: string }>("/databases", {
        method: "POST",
        body: input,
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: databaseKeys.list(vars.projectId) })
      toast.success(i18n.t("databases:toasts.created"))
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

export function useRegisterExternalDatabase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: RegisterExternalDatabaseInput) => {
      return apiFetch<{ id: string }>("/databases/external", {
        method: "POST",
        body: input,
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: databaseKeys.list(vars.projectId) })
      toast.success(i18n.t("databases:toasts.registered"))
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

export function useDeleteDatabase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      return apiFetch<{ ok: boolean }>(`/databases/${id}`, {
        method: "DELETE",
        body: { confirm: `delete ${name}` },
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: databaseKeys.all })
      toast.success(i18n.t("databases:toasts.deleted"))
    },
    onError: (err: Error) => {
      notifyMutationError(err, i18n.t("databases:toasts.deleteFailed"))
    },
  })
}

export function useRevealDatabase() {
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const data = await apiFetch<RevealedDatabaseCredentials>(
        `/databases/${id}/reveal`,
        {
          method: "POST",
        }
      )
      return data.connection_string
    },
  })
}

export function useRevealDatabaseCredentials() {
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      return apiFetch<RevealedDatabaseCredentials>(`/databases/${id}/reveal`, {
        method: "POST",
      })
    },
  })
}

export function useCreateAdminerSession() {
  return useMutation({
    mutationFn: async ({ id, totpCode }: { id: string; totpCode: string }) => {
      return apiFetch<AdminerSessionLaunch>(
        `/databases/${id}/adminer/session`,
        {
          method: "POST",
          headers: { "X-TOTP-Code": totpCode },
        }
      )
    },
    onError: (err: Error) => {
      notifyMutationError(err, i18n.t("databases:toasts.adminerFailed"))
    },
  })
}

export function useLinkDatabase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      appId,
      databaseId,
      env_prefix,
    }: {
      appId: string
      databaseId: string
      env_prefix?: string
    }) => {
      return apiFetch<{
        ok: boolean
        vars: Array<string>
        requiresRedeploy: boolean
      }>(`/apps/${appId}/databases/${databaseId}/link`, {
        method: "POST",
        body: { env_prefix: env_prefix ?? DEFAULT_DATABASE_ENV_PREFIX },
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ["apps", vars.appId, "secrets"] })
      qc.invalidateQueries({ queryKey: databaseKeys.all })
      toast.success(i18n.t("databases:toasts.linked"), {
        description: data.requiresRedeploy
          ? i18n.t("databases:toasts.redeployHint")
          : undefined,
      })
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

export function useRotateDatabase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, totpCode }: { id: string; totpCode: string }) => {
      return apiFetch<{
        ok: boolean
        rotatedAt: string
        appsRedeployed: Array<string>
      }>(`/databases/${id}/rotate`, {
        method: "POST",
        headers: { "X-TOTP-Code": totpCode },
      })
    },
    onSuccess: (_, vars) => {
      const id = vars.id
      qc.invalidateQueries({ queryKey: databaseKeys.detail(id) })
      toast.success(i18n.t("databases:toasts.rotationStarted"))
    },
    onError: (err: Error) => {
      notifyMutationError(err, i18n.t("databases:toasts.rotationFailed"))
    },
  })
}

export function useUnlinkDatabase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      appId,
      databaseId,
    }: {
      appId: string
      databaseId: string
    }) => {
      return apiFetch<{ ok: boolean }>(
        `/apps/${appId}/databases/${databaseId}/link`,
        {
          method: "DELETE",
        }
      )
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["apps", vars.appId, "secrets"] })
      qc.invalidateQueries({ queryKey: databaseKeys.all })
      toast.success(i18n.t("databases:toasts.unlinked"))
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

function useDatabaseAction(
  action: "start" | "stop" | "restart",
  successMessage: string
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<{ ok: boolean }>(`/databases/${id}/${action}`, {
        method: "POST",
      })
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: databaseKeys.detail(id) })
      qc.invalidateQueries({ queryKey: databaseKeys.all })
      toast.success(successMessage)
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

export function useStartDatabase() {
  return useDatabaseAction("start", i18n.t("databases:toasts.started"))
}

export function useStopDatabase() {
  return useDatabaseAction("stop", i18n.t("databases:toasts.stopped"))
}

export function useRestartDatabase() {
  return useDatabaseAction("restart", i18n.t("databases:toasts.restarted"))
}

export function useUpdateDatabaseNetwork() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      exposureMode,
      publicEnabled,
    }: {
      id: string
      exposureMode: DbExposureMode
      publicEnabled: boolean
    }) => {
      return apiFetch<{ ok: boolean; database: Database }>(
        `/databases/${id}/network`,
        {
          method: "PATCH",
          body: { exposureMode, publicEnabled },
          headers: { "content-type": "application/json" },
        }
      )
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: databaseKeys.detail(vars.id) })
      qc.invalidateQueries({ queryKey: databaseKeys.all })
      toast.success(i18n.t("databases:toasts.networkUpdated"))
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

export function useDatabaseStats(id: string) {
  return useQuery({
    queryKey: ["databases", "stats", id],
    queryFn: async () =>
      apiFetch<{ containerFound: boolean; stats: DatabaseStats | null }>(
        `/databases/${id}/stats`
      ),
    enabled: Boolean(id),
    refetchInterval: 10_000,
  })
}
