// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "./api"
import type { ApiError } from "./api"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SecretScope = "shared" | "prod" | "preview" | "dev"
export type SecretPhase = "build" | "runtime" | "both"
export type ImportEnvMode = "merge" | "replace"

export interface SecretMeta {
  key: string
  scope: SecretScope
  phase: SecretPhase
  linked_database_id: string | null
  linked_database_name: string | null
  linked_database_kind: string | null
  managed_by: "manual" | "database"
  updated_at: string | null
}

interface SecretsResponse {
  secrets: Array<SecretMeta>
}

export interface CreateSecretPayload {
  key: string
  value: string
  scope: SecretScope
  phase?: SecretPhase
}

export interface UpdateSecretPayload {
  key: string
  scope: SecretScope
  /** Current phase: part of the secret identity. */
  phase: SecretPhase
  /** Omitted to keep the stored value. */
  value?: string
  /** Moves the secret to this phase. */
  newPhase?: SecretPhase
}

export interface ImportEnvResult {
  imported: number
  removed: number
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export function secretsQueryKey(
  appId: string,
  scope?: SecretScope,
  phase?: SecretPhase
) {
  return scope || phase
    ? (["apps", appId, "secrets", scope ?? "all", phase ?? "all"] as const)
    : (["apps", appId, "secrets"] as const)
}

// ---------------------------------------------------------------------------
// useSecrets — GET /apps/:id/secrets?scope=
// ---------------------------------------------------------------------------

export function useSecrets(
  appId: string,
  scope?: SecretScope,
  phase?: SecretPhase
) {
  return useQuery<Array<SecretMeta>, ApiError>({
    queryKey: secretsQueryKey(appId, scope, phase),
    queryFn: async () => {
      const params = new URLSearchParams()
      if (scope) params.set("scope", scope)
      if (phase) params.set("phase", phase)
      const qs = params.size > 0 ? `?${params.toString()}` : ""
      const data = await apiFetch<SecretsResponse>(
        `/apps/${appId}/secrets${qs}`
      )
      return data.secrets
    },
    enabled: Boolean(appId),
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// useCreateSecret — POST /apps/:id/secrets
// ---------------------------------------------------------------------------

export function useCreateSecret(appId: string) {
  const qc = useQueryClient()

  return useMutation<
    { key: string; scope: SecretScope; phase: SecretPhase },
    ApiError,
    CreateSecretPayload
  >({
    mutationFn: async (payload) => {
      return apiFetch(`/apps/${appId}/secrets`, {
        method: "POST",
        body: payload,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps", appId, "secrets"] })
    },
  })
}

// ---------------------------------------------------------------------------
// useUpdateSecret — PATCH /apps/:id/secrets/:key?scope=&phase=
// ---------------------------------------------------------------------------

export function useUpdateSecret(appId: string) {
  const qc = useQueryClient()

  return useMutation<
    { key: string; scope: SecretScope; phase: SecretPhase },
    ApiError,
    UpdateSecretPayload
  >({
    mutationFn: async ({ key, scope, phase, value, newPhase }) => {
      return apiFetch(
        `/apps/${appId}/secrets/${encodeURIComponent(key)}?scope=${scope}&phase=${phase}`,
        {
          method: "PATCH",
          body: {
            ...(value ? { value } : {}),
            ...(newPhase && newPhase !== phase ? { phase: newPhase } : {}),
          },
        }
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps", appId, "secrets"] })
    },
  })
}

// ---------------------------------------------------------------------------
// useDeleteSecret — DELETE /apps/:id/secrets/:key?scope=
// ---------------------------------------------------------------------------

export function useDeleteSecret(appId: string) {
  const qc = useQueryClient()

  return useMutation<
    unknown,
    ApiError,
    { key: string; scope: SecretScope; phase?: SecretPhase }
  >({
    mutationFn: async ({ key, scope, phase }) => {
      const safePhase = phase ?? "runtime"
      return apiFetch(
        `/apps/${appId}/secrets/${encodeURIComponent(key)}?scope=${scope}&phase=${safePhase}`,
        {
          method: "DELETE",
        }
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps", appId, "secrets"] })
    },
  })
}

// ---------------------------------------------------------------------------
// useRevealSecret — POST /apps/:id/secrets/:key/reveal?scope=
// ---------------------------------------------------------------------------

export function useRevealSecret(appId: string) {
  return useMutation<
    { value: string },
    ApiError,
    { key: string; scope: SecretScope; phase?: SecretPhase; totpCode?: string }
  >({
    mutationFn: async ({ key, scope, phase, totpCode }) => {
      const safePhase = phase ?? "runtime"
      const headers = totpCode ? { "X-TOTP-Code": totpCode } : undefined
      return apiFetch(
        `/apps/${appId}/secrets/${encodeURIComponent(key)}/reveal?scope=${scope}&phase=${safePhase}`,
        {
          method: "POST",
          ...(headers ? { headers } : {}),
          body: {},
        }
      )
    },
  })
}

// ---------------------------------------------------------------------------
// useImportEnv — POST /apps/:id/secrets/import
// ---------------------------------------------------------------------------

export function useImportEnv(appId: string) {
  const qc = useQueryClient()

  return useMutation<
    ImportEnvResult,
    ApiError,
    {
      file: File
      scope?: SecretScope
      phase?: SecretPhase
      mode?: ImportEnvMode
    }
  >({
    mutationFn: async ({ file, scope, phase, mode }) => {
      const content = await file.text()
      const params = new URLSearchParams()
      if (scope) params.set("scope", scope)
      if (phase) params.set("phase", phase)
      if (mode) params.set("mode", mode)
      const qs = params.size > 0 ? `?${params.toString()}` : ""
      return apiFetch<ImportEnvResult>(`/apps/${appId}/secrets/import${qs}`, {
        method: "POST",
        body: { content },
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps", appId, "secrets"] })
    },
  })
}

export function useImportEnvContent(appId: string) {
  const qc = useQueryClient()

  return useMutation<
    ImportEnvResult,
    ApiError,
    {
      content: string
      scope?: SecretScope
      phase?: SecretPhase
      mode?: ImportEnvMode
    }
  >({
    mutationFn: async ({ content, scope, phase, mode }) => {
      const params = new URLSearchParams()
      if (scope) params.set("scope", scope)
      if (phase) params.set("phase", phase)
      if (mode) params.set("mode", mode)
      const qs = params.size > 0 ? `?${params.toString()}` : ""
      return apiFetch<ImportEnvResult>(`/apps/${appId}/secrets/import${qs}`, {
        method: "POST",
        body: { content },
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["apps", appId, "secrets"] })
    },
  })
}
