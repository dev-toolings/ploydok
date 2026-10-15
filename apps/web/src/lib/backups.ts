// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import i18n from "./i18n"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Backup {
  id: string
  databaseId?: string
  appId?: string
  volumeId?: string
  configId: string | null
  destinationKind: "s3" | "local" | null
  location: string
  sizeBytes: number | null
  ageEncrypted: boolean
  status: "running" | "succeeded" | "failed"
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export interface BackupInventoryItem {
  id: string
  kind: "database" | "volume"
  resourceId: string
  resourceName: string
  databaseId: string | null
  appId: string | null
  volumeId: string | null
  destinationKind: "s3" | "local" | null
  location: string
  present: boolean | null
  probeError?: "unreachable" | null
  sizeBytes: number | null
  ageSeconds: number | null
  artifactModifiedAt: string | null
  startedAt: string
  finishedAt: string | null
}

export interface BackupConfig {
  id: string
  databaseId?: string
  appId?: string
  volumeId?: string
  destinationKind: "s3" | "local"
  s3Endpoint: string | null
  s3Bucket: string | null
  s3Prefix: string | null
  s3Region: string | null
  s3CredentialsSecretId: string | null
  scheduleCron: string
  retentionDays: number
  ageRecipientPublicKey: string | null
  enabled: boolean
  lastRunAt: string | null
  lastError: string | null
  createdAt: string | undefined
}

export interface UpdateBackupConfigInput {
  destinationKind?: "s3" | "local"
  s3Endpoint?: string
  s3Bucket?: string
  s3Prefix?: string
  s3Region?: string
  s3CredentialsSecretId?: string
  scheduleCron?: string
  retentionDays?: number
  ageRecipientPublicKey?: string | null
  enabled?: boolean
}

export interface RestoreInput {
  backupId: string
  ageIdentity?: string
  confirm: string
}

export type BackupTarget =
  | { kind: "database"; databaseId: string }
  | { kind: "app-volume"; appId: string; volumeId: string }

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

const backupsKey = (target: BackupTarget) =>
  target.kind === "database"
    ? (["backups", "database", target.databaseId] as const)
    : (["backups", "app-volume", target.appId, target.volumeId] as const)
const backupConfigKey = (target: BackupTarget) =>
  target.kind === "database"
    ? (["backup-config", "database", target.databaseId] as const)
    : (["backup-config", "app-volume", target.appId, target.volumeId] as const)

function backupsPath(target: BackupTarget): string {
  if (target.kind === "database")
    return `/databases/${target.databaseId}/backups`
  return `/apps/${target.appId}/volumes/${target.volumeId}/backups`
}

function backupConfigPath(target: BackupTarget): string {
  if (target.kind === "database") {
    return `/databases/${target.databaseId}/backup-config`
  }
  return `/apps/${target.appId}/volumes/${target.volumeId}/backup-config`
}

function backupNowPath(target: BackupTarget): string {
  if (target.kind === "database") {
    return `/databases/${target.databaseId}/backup-now`
  }
  return `/apps/${target.appId}/volumes/${target.volumeId}/backup-now`
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useTargetBackups(target: BackupTarget) {
  return useQuery({
    queryKey: backupsKey(target),
    queryFn: () =>
      apiFetch<{ backups: Array<Backup> }>(backupsPath(target)).then(
        (d) => d.backups
      ),
    refetchInterval: 10_000,
  })
}

export function useBackups(databaseId: string) {
  return useTargetBackups({ kind: "database", databaseId })
}

export function useTargetBackupInventory(target: BackupTarget) {
  const params =
    target.kind === "database"
      ? `kind=database&resourceId=${encodeURIComponent(target.databaseId)}`
      : `kind=volume&resourceId=${encodeURIComponent(target.volumeId)}&appId=${encodeURIComponent(target.appId)}`
  return useQuery({
    queryKey: ["backups", "inventory", target],
    queryFn: () =>
      apiFetch<{ backups: Array<BackupInventoryItem> }>(
        `/backups/inventory?${params}`
      ).then((data) => data.backups),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  })
}

export function useTargetBackupConfig(target: BackupTarget) {
  return useQuery({
    queryKey: backupConfigKey(target),
    queryFn: () =>
      apiFetch<{ config: BackupConfig | null }>(backupConfigPath(target)).then(
        (d) => d.config
      ),
  })
}

export function useBackupConfig(databaseId: string) {
  return useTargetBackupConfig({ kind: "database", databaseId })
}

export function useUpdateTargetBackupConfig(target: BackupTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: UpdateBackupConfigInput) => {
      return apiFetch<{ config: BackupConfig }>(backupConfigPath(target), {
        method: "PUT",
        body: input,
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: backupConfigKey(target) })
      toast.success(i18n.t("databases:toasts.configSaved"))
    },
    onError: (err: Error) => {
      toast.error(i18n.t("databases:toasts.saveFailed", { message: err.message }))
    },
  })
}

export function useUpdateBackupConfig(databaseId: string) {
  return useUpdateTargetBackupConfig({ kind: "database", databaseId })
}

export function useTargetBackupNow(target: BackupTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      return apiFetch<{ message: string; backupId: string }>(
        backupNowPath(target),
        {
          method: "POST",
        }
      )
    },
    onSuccess: () => {
      toast.success(i18n.t("databases:toasts.backupStarted"))
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: backupsKey(target) })
      }, 2000)
    },
    onError: (err: Error) => {
      toast.error(i18n.t("databases:toasts.backupFailed", { message: err.message }))
    },
  })
}

export function useBackupNow(databaseId: string) {
  return useTargetBackupNow({ kind: "database", databaseId })
}

export function useRestoreBackup(databaseId: string) {
  return useMutation({
    mutationFn: async (input: RestoreInput) => {
      return apiFetch<{ ok: boolean }>(`/databases/${databaseId}/restore`, {
        method: "POST",
        body: input,
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: () => {
      toast.success(i18n.t("databases:toasts.restoreCompleted"))
    },
    onError: (err: Error) => {
      toast.error(i18n.t("databases:toasts.restoreFailed", { message: err.message }))
    },
  })
}

export function useDeleteBackup(target: BackupTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (backupId: string) => {
      return apiFetch<{ ok: boolean }>(`/backups/${backupId}`, {
        method: "DELETE",
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: backupsKey(target) })
      toast.success(i18n.t("databases:toasts.backupDeleted"))
    },
    onError: (err: Error) => {
      toast.error(i18n.t("databases:toasts.deleteBackupFailed", { message: err.message }))
    },
  })
}
