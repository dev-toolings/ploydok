// SPDX-License-Identifier: AGPL-3.0-only
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import { apiBaseUrl } from "./api/base"
import i18n from "./i18n"
import type { ApiError } from "./api"
import type { GitBranch, GitRepo } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitLabConfig {
  configured: boolean
  instance_url?: string
  client_id?: string
  /** Exact redirect_uri the API sends to GitLab. Always present. */
  callback_url?: string
}

export interface SaveGitLabConfigPayload {
  instance_url?: string
  client_id: string
  client_secret: string
  webhook_secret: string
}

// ---------------------------------------------------------------------------
// Config (admin)
// ---------------------------------------------------------------------------

export function useGitLabConfig() {
  return useQuery<GitLabConfig>({
    queryKey: ["gitlab", "config"],
    queryFn: () => apiFetch<GitLabConfig>("/gitlab/config"),
    staleTime: 30_000,
  })
}

export function useSaveGitLabConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: SaveGitLabConfigPayload) =>
      apiFetch<{ ok: true }>("/gitlab/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }),
    onSuccess: () => {
      toast.success(i18n.t("settings:gitlab.oauthSaved"))
      void qc.invalidateQueries({ queryKey: ["gitlab", "config"] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(i18n.t("settings:gitlab.saveError", { message: msg }))
    },
  })
}

export function useDeleteGitLabConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>("/gitlab/config", { method: "DELETE" }),
    onSuccess: () => {
      toast.success(i18n.t("settings:gitlab.configDeleted"))
      void qc.invalidateQueries({ queryKey: ["gitlab"] })
    },
  })
}

// ---------------------------------------------------------------------------
// OAuth connect/disconnect (per-user)
// ---------------------------------------------------------------------------

/**
 * Navigate the browser to /gitlab/connect so the server can set the state
 * cookie and redirect to {instance}/oauth/authorize. Cannot be done via
 * XHR — the browser must follow the 302.
 */
export function gitlabConnectUrl(options?: { returnTo?: string }): string {
  const base = `${apiBaseUrl().replace(/\/$/, "")}/gitlab/connect`
  if (!options?.returnTo) return base
  return `${base}?return_to=${encodeURIComponent(options.returnTo)}`
}

export function useDisconnectGitLab() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true }>("/gitlab/connect", { method: "DELETE" }),
    onSuccess: () => {
      toast.success(i18n.t("settings:gitlab.disconnected"))
      void qc.invalidateQueries({ queryKey: ["gitlab"] })
    },
  })
}

// ---------------------------------------------------------------------------
// Repos + branches
// ---------------------------------------------------------------------------

interface GitLabReposPage {
  repos: Array<GitRepo>
  hasMore: boolean
  page: number
  perPage: number
}

interface GitLabReposParams {
  search?: string
  perPage?: number
  enabled?: boolean
}

export function useGitLabRepos(params: GitLabReposParams = {}) {
  const { search, perPage = 30, enabled = true } = params

  return useInfiniteQuery<GitLabReposPage, ApiError>({
    queryKey: ["gitlab", "repos", search ?? ""],
    queryFn: ({ pageParam }) => {
      const page = (pageParam as number | undefined) ?? 1
      const searchParam = search ? `&search=${encodeURIComponent(search)}` : ""
      return apiFetch<GitLabReposPage>(
        `/gitlab/repos?page=${page}&per_page=${perPage}${searchParam}`
      )
    },
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.length + 1 : undefined,
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  })
}

const GITLAB_OAUTH_ERROR_KEYS = [
  "access_denied",
  "missing_code",
  "not_configured",
  "exchange_failed",
  "oauth_error",
] as const

export function gitLabOAuthErrorMessage(search: string): string | null {
  const code = new URLSearchParams(search).get("gitlab_error")
  if (!code) return null
  const key = GITLAB_OAUTH_ERROR_KEYS.includes(
    code as (typeof GITLAB_OAUTH_ERROR_KEYS)[number]
  )
    ? code
    : "oauth_error"
  return i18n.t(`settings:gitlab.oauth.${key}`)
}

// Same shape as the GitHub hook so the create-app wizard reads both the same
// way. GitLab uses a PAT rather than a per-account install, so `needsInstall`
// is always false here.
export function useGitLabBranches(fullName?: string) {
  return useQuery<
    { branches: Array<GitBranch>; needsInstall: boolean },
    ApiError
  >({
    queryKey: ["gitlab", "branches", fullName ?? ""],
    queryFn: async () => {
      if (!fullName) return { branches: [], needsInstall: false }
      const res = await apiFetch<{ branches: Array<GitBranch> }>(
        `/gitlab/repos/${encodeURIComponent(fullName)}/branches`
      )
      return { branches: res.branches, needsInstall: false }
    },
    enabled: Boolean(fullName),
    staleTime: 60_000,
  })
}

export function useGitLabFileExists(
  fullName: string | undefined,
  filePath: string,
  ref: string | undefined
) {
  return useQuery<boolean, ApiError>({
    queryKey: ["gitlab", "file-exists", fullName ?? "", filePath, ref ?? ""],
    queryFn: async () => {
      if (!fullName || !ref) return false
      const res = await apiFetch<{ exists: boolean }>(
        `/gitlab/repos/${encodeURIComponent(fullName)}/file-exists?path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(ref)}`
      )
      return res.exists
    },
    enabled: Boolean(fullName && ref),
    staleTime: 5 * 60_000,
  })
}

// ---------------------------------------------------------------------------
// Cache status — per-user freshness + repo count for the cached gitlab repos.
// ---------------------------------------------------------------------------

export interface GitLabCacheStatusEntry {
  id: string
  externalId: string
  accountLogin: string
  avatarUrl: string | null
  htmlUrl: string | null
  lastSyncedAt: string
  repoCount: number
  ageMs: number
  status: "fresh" | "stale"
}

export interface GitLabCacheStatusResponse {
  installation: GitLabCacheStatusEntry | null
  staleThresholdMs: number
  syncStatus: "pending" | "running" | "completed" | "failed" | null
}

export function useGitLabCacheStatus(
  opts: { autoRefresh?: boolean; enabled?: boolean } = {}
) {
  return useQuery<GitLabCacheStatusResponse, ApiError>({
    queryKey: ["gitlab", "cache-status"],
    queryFn: () =>
      apiFetch<GitLabCacheStatusResponse>("/gitlab/installations/cache-status"),
    enabled: opts.enabled ?? true,
    staleTime: 5_000,
    refetchInterval: (query) =>
      opts.autoRefresh &&
      (query.state.data?.syncStatus === "pending" ||
        query.state.data?.syncStatus === "running" ||
        query.state.data?.installation == null)
        ? 3_000
        : false,
  })
}

export function useSyncGitLabInstallations() {
  const qc = useQueryClient()
  return useMutation<{ enqueued: true; syncId: string }, ApiError, void>({
    mutationFn: () =>
      apiFetch<{ enqueued: true; syncId: string }>(
        "/gitlab/installations/sync",
        { method: "POST" }
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["gitlab", "cache-status"] })
      void qc.invalidateQueries({ queryKey: ["gitlab", "repos"] })
    },
  })
}
