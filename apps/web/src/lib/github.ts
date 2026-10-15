// SPDX-License-Identifier: AGPL-3.0-only
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useRef } from "react"
import { toast } from "sonner"
import { apiFetch, criticalRetryDelay, shouldRetryCriticalQuery } from "./api"
import { usePendingAction } from "./hooks/use-pending-action"
import type { ApiError } from "./api"
import type { GitBranch, GitRepo } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One registered GitHub App. Each App can only be installed on its owner. */
export interface GitHubAppSummary {
  id: string
  name: string
  slug: string
  app_id: string
  owner_login: string | null
  owner_type: string | null
  install_url: string
}

export interface GitHubAppConfig {
  configured: boolean
  name?: string
  slug?: string
  app_id?: string
  install_url?: string
  apps?: Array<GitHubAppSummary>
}

export interface GitHubInstallTarget {
  appId: string
  name: string
  slug: string
  ownerLogin: string | null
  ownerType: string | null
  url: string
}

export type GitHubAppCredentialsStatus =
  | { status: "not_configured" | "readable" }
  | {
      status: "unreadable"
      error: {
        code: "GITHUB_APP_CREDENTIALS_UNREADABLE"
        message: string
      }
    }

export interface CreateGitHubAppResponse {
  manifest: Record<string, unknown>
  state: string
  post_url: string
}

export interface ImportGitHubAppPayload {
  appId: string
  clientId: string
  clientSecret: string
  privateKey: string
  webhookSecret?: string
  slug: string
  name: string
}

export interface AppInstallation {
  id: number
  /** Ploydok id of the GitHub App that owns this installation. */
  githubAppId?: string
  accountLogin: string
  accountType: string
  granted?: boolean
  repositorySelection: "all" | "selected"
  suspendedAt: string | null
  htmlUrl: string
  avatarUrl: string
  repositoryCount: number | null
}

export interface InstallationsResponse {
  installations: Array<AppInstallation>
  installUrl: string
  installTargets?: Array<GitHubInstallTarget>
  claimableInstallations?: Array<AppInstallation>
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReposPage {
  repos: Array<GitRepo>
  hasMore: boolean
}

interface ReposParams {
  search?: string
  perPage?: number
  organizationId?: string
}

// ---------------------------------------------------------------------------
// useGitHubRepos — infinite query (installation-token based)
// ---------------------------------------------------------------------------

export function useGitHubRepos(params: ReposParams = {}) {
  const { search, perPage = 30, organizationId } = params

  return useInfiniteQuery<ReposPage, ApiError>({
    queryKey: ["github", "repos", organizationId ?? "", search ?? ""],
    queryFn: ({ pageParam }) => {
      const page = (pageParam as number | undefined) ?? 1
      const query = new URLSearchParams({
        page: String(page),
        per_page: String(perPage),
      })
      if (search) query.set("search", search)
      if (organizationId) query.set("organizationId", organizationId)
      return apiFetch<ReposPage>(
        `/github/repos?${query.toString()}`
      )
    },
    getNextPageParam: (last, pages) =>
      last.hasMore ? pages.length + 1 : undefined,
    enabled: Boolean(organizationId),
    initialPageParam: 1,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: false,
  })
}

// ---------------------------------------------------------------------------
// useGitHubBranches
// ---------------------------------------------------------------------------

// `needsInstall` distinguishes "this repo has no branches" from "the GitHub
// App is not installed on any account any more". The repo picker is served
// from a cache and stays populated in the second case, so the wizard needs the
// flag to explain the dead end.
export interface GitHubBranchesResult {
  branches: Array<GitBranch>
  needsInstall: boolean
}

export function useGitHubBranches(
  fullName?: string,
  organizationId?: string
) {
  return useQuery<GitHubBranchesResult, ApiError>({
    queryKey: ["github", "branches", organizationId ?? "", fullName ?? ""],
    queryFn: async () => {
      if (!fullName) return { branches: [], needsInstall: false }
      const [owner, repo] = fullName.split("/")
      const query = organizationId
        ? `?organizationId=${encodeURIComponent(organizationId)}`
        : ""
      const res = await apiFetch<{
        branches: Array<GitBranch>
        needsInstall?: boolean
      }>(`/github/repos/${owner}/${repo}/branches${query}`)
      return { branches: res.branches, needsInstall: res.needsInstall ?? false }
    },
    enabled: Boolean(fullName && organizationId),
    staleTime: 60_000,
  })
}

// ---------------------------------------------------------------------------
// useGitHubFileExists — detect presence of a file on a given branch
// ---------------------------------------------------------------------------

export function useGitHubFileExists(
  fullName: string | undefined,
  filePath: string,
  ref: string | undefined,
  organizationId?: string
) {
  return useQuery<boolean, ApiError>({
    queryKey: [
      "github",
      "file-exists",
      organizationId ?? "",
      fullName ?? "",
      filePath,
      ref ?? "",
    ],
    queryFn: async () => {
      if (!fullName || !ref) return false
      const [owner, repo] = fullName.split("/")
      const query = new URLSearchParams({
        path: filePath,
        ref,
      })
      if (organizationId) query.set("organizationId", organizationId)
      const res = await apiFetch<{ exists: boolean }>(
        `/github/repos/${owner}/${repo}/file-exists?${query.toString()}`
      )
      return res.exists
    },
    enabled: Boolean(fullName && ref && organizationId),
    staleTime: 5 * 60_000,
  })
}

// ---------------------------------------------------------------------------
// useGitHubAppConfig — fetch singleton GitHub App config
// ---------------------------------------------------------------------------

export function useGitHubAppConfig(options: { enabled?: boolean } = {}) {
  return useQuery<GitHubAppConfig, ApiError>({
    queryKey: ["github", "app", "config"],
    queryFn: () => apiFetch<GitHubAppConfig>("/github/app/config"),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    retry: shouldRetryCriticalQuery,
    retryDelay: criticalRetryDelay,
    meta: { critical: true },
  })
}

// ---------------------------------------------------------------------------
// useGitHubAppCredentialsStatus — verify the locally stored private key
// ---------------------------------------------------------------------------

export function useGitHubAppCredentialsStatus(
  options: { enabled?: boolean } = {}
) {
  return useQuery<GitHubAppCredentialsStatus, ApiError>({
    queryKey: ["github", "app", "credentials", "status"],
    queryFn: () =>
      apiFetch<GitHubAppCredentialsStatus>("/github/app/credentials/status"),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
    refetchOnMount: "always",
    retry: shouldRetryCriticalQuery,
    retryDelay: criticalRetryDelay,
    meta: { critical: true },
  })
}

// ---------------------------------------------------------------------------
// useCreateGitHubApp — POST /github/app/manifest, then auto-submit form to GitHub
// ---------------------------------------------------------------------------

export interface CreateGitHubAppVariables {
  /** Where the GitHub round-trip should land once the App is created. */
  returnTo?: string
  /** GitHub organization that will own the App; omit for a personal App. */
  organization?: string
}

export function useCreateGitHubApp() {
  return useMutation<
    CreateGitHubAppResponse,
    ApiError,
    CreateGitHubAppVariables | void
  >({
    mutationFn: (vars) =>
      apiFetch<CreateGitHubAppResponse>("/github/app/manifest", {
        method: "POST",
        body: {
          return_to: vars?.returnTo ?? null,
          ...(vars?.organization ? { organization: vars.organization } : {}),
        },
        headers: { "content-type": "application/json" },
      }),
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

/**
 * GitHub's App-manifest flow only accepts a real form POST, so we build one and
 * submit it. Shared by the settings panel and the onboarding wizard.
 */
export function submitGitHubAppManifest(data: CreateGitHubAppResponse): void {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = data.post_url
  form.style.display = "none"

  const input = document.createElement("input")
  input.type = "hidden"
  input.name = "manifest"
  input.value = JSON.stringify(data.manifest)
  form.appendChild(input)

  document.body.appendChild(form)
  form.submit()
}

/** Minimum time the "Redirecting to GitHub..." state stays on screen. */
const MANIFEST_REDIRECT_HOLD_MS = 500

/**
 * Create the App then hand over to GitHub. The manifest call usually answers in
 * a few dozen ms, so without a floor the pending state flashes and the user
 * lands on github.com with no idea what happened. The pending flag never falls
 * back to false on success: it stays on until the browser leaves the page.
 */
export function useCreateGitHubAppFlow(returnTo: string) {
  const createApp = useCreateGitHubApp()
  const organizationRef = useRef<string | undefined>(undefined)
  const { run, pending } = usePendingAction(
    () =>
      createApp.mutateAsync({
        returnTo,
        ...(organizationRef.current
          ? { organization: organizationRef.current }
          : {}),
      }),
    {
      minVisibleMs: MANIFEST_REDIRECT_HOLD_MS,
      keepPendingOnSuccess: true,
    }
  )

  const start = async (organization?: string): Promise<void> => {
    organizationRef.current = organization
    try {
      submitGitHubAppManifest(await run())
    } catch {
      // createApp.error carries the message.
    }
  }

  return {
    start,
    isPending: pending,
    error: createApp.error?.message ?? null,
  }
}

export function useImportGitHubApp() {
  const qc = useQueryClient()
  return useMutation<GitHubAppConfig, ApiError, ImportGitHubAppPayload>({
    mutationFn: (payload) =>
      apiFetch<GitHubAppConfig>("/github/app/import", {
        method: "POST",
        body: payload,
        headers: { "content-type": "application/json" },
      }),
    onSuccess: async (config) => {
      qc.setQueryData(["github", "app", "config"], config)
      qc.setQueryData<GitHubAppCredentialsStatus>(
        ["github", "app", "credentials", "status"],
        { status: "readable" }
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["github", "app"] }),
        qc.invalidateQueries({ queryKey: ["github", "installations"] }),
        qc.invalidateQueries({ queryKey: ["github", "cache-status"] }),
        qc.invalidateQueries({ queryKey: ["github", "repos"] }),
        qc.invalidateQueries({ queryKey: ["git-providers"] }),
      ])
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

// ---------------------------------------------------------------------------
// useResetGitHubApp — uninstall GitHub installations, then delete local config
// ---------------------------------------------------------------------------

export interface ResetGitHubAppResponse {
  ok: true
  uninstalled: number
}

export function useResetGitHubApp() {
  const qc = useQueryClient()
  return useMutation<ResetGitHubAppResponse, ApiError, string | void>({
    mutationFn: (appId) =>
      apiFetch<ResetGitHubAppResponse>(
        `/github/app/config?confirm=uninstall-github-installations${
          appId ? `&appId=${encodeURIComponent(appId)}` : ""
        }`,
        { method: "DELETE" }
      ),
    // Awaited: the caller's pending state lasts until the refreshed list no
    // longer shows the removed App.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["github", "app"] }),
        qc.invalidateQueries({ queryKey: ["github", "installations"] }),
        qc.invalidateQueries({ queryKey: ["github", "cache-status"] }),
        qc.invalidateQueries({ queryKey: ["github", "repos"] }),
      ]),
  })
}

// ---------------------------------------------------------------------------
// useForgetLocalGitHubApp — delete an unreadable local config without GitHub
// ---------------------------------------------------------------------------

export interface ForgetLocalGitHubAppResponse {
  ok: true
  forgotten: true
  remoteInstallationsModified: false
}

export function useForgetLocalGitHubApp() {
  const qc = useQueryClient()
  return useMutation<ForgetLocalGitHubAppResponse, ApiError, string | void>({
    mutationFn: (appId) =>
      apiFetch<ForgetLocalGitHubAppResponse>(
        `/github/app/config/local?confirm=forget-local-github-app${
          appId ? `&appId=${encodeURIComponent(appId)}` : ""
        }`,
        { method: "DELETE" }
      ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["github"] })
    },
  })
}

// ---------------------------------------------------------------------------
// useInstallations — GET /github/installations
// ---------------------------------------------------------------------------

export function useInstallations(options: { enabled?: boolean } = {}) {
  return useQuery<InstallationsResponse, ApiError>({
    queryKey: ["github", "installations"],
    queryFn: () => apiFetch<InstallationsResponse>("/github/installations"),
    enabled: options.enabled ?? true,
    // Short stale so returning from GitHub install flow refreshes immediately.
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    retry: (failureCount, error) => {
      if (error.status === 401 || error.status === 503) return false
      return failureCount < 2
    },
  })
}

export interface GitHubOrganizationLookup {
  login: string
  name: string | null
  avatarUrl: string
  hasApp: boolean
}

/** Confirms a typed login is an existing GitHub organization. */
export function useGitHubOrganizationLookup(login: string) {
  return useQuery<GitHubOrganizationLookup, ApiError>({
    queryKey: ["github", "organization-lookup", login.toLowerCase()],
    queryFn: () =>
      apiFetch<GitHubOrganizationLookup>(
        `/github/app/organization-lookup?login=${encodeURIComponent(login)}`
      ),
    enabled: login.length > 0,
    staleTime: 60_000,
    retry: false,
  })
}

/** Installations granted to one Ploydok organization, plus optional claims. */
export function useOrganizationGitHubInstallations(
  organizationId?: string
) {
  return useQuery<InstallationsResponse, ApiError>({
    queryKey: ["github", "installations", organizationId ?? ""],
    queryFn: () => {
      const query = new URLSearchParams()
      if (organizationId) query.set("organizationId", organizationId)
      return apiFetch<InstallationsResponse>(
        `/github/installations?${query.toString()}`
      )
    },
    enabled: Boolean(organizationId),
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    retry: (failureCount, error) => {
      if (error.status === 401 || error.status === 403 || error.status === 503)
        return false
      return failureCount < 2
    },
  })
}

// ---------------------------------------------------------------------------
// useRemoveGitHubInstallation — role-aware DELETE /github/installations/:id
// ---------------------------------------------------------------------------

export type GitHubInstallationRemovalResponse =
  { ok: true; revoked: number } | { ok: true; disconnected: number }

export function useRemoveGitHubInstallation() {
  const qc = useQueryClient()
  return useMutation<GitHubInstallationRemovalResponse, ApiError, number>({
    mutationFn: (installationId) =>
      apiFetch<GitHubInstallationRemovalResponse>(
        `/github/installations/${installationId}`,
        {
          method: "DELETE",
        }
      ),
    // Awaited: the caller's pending state lasts until the refreshed list no
    // longer shows the revoked installation.
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["github", "installations"] }),
        qc.invalidateQueries({ queryKey: ["github", "cache-status"] }),
        qc.invalidateQueries({ queryKey: ["github", "repos"] }),
        qc.invalidateQueries({ queryKey: ["git-providers", "status"] }),
      ]),
  })
}

export interface OrganizationGitHubInstallationGrantVariables {
  organizationId: string
  installationId: number | string
}

export function useRevokeOrganizationGitHubInstallation() {
  const qc = useQueryClient()
  return useMutation<
    { ok: true; revoked: boolean; installationId: string },
    ApiError,
    OrganizationGitHubInstallationGrantVariables
  >({
    mutationFn: ({ organizationId, installationId }) =>
      apiFetch<{
        ok: true
        revoked: boolean
        installationId: string
      }>(
        `/github/installations/${encodeURIComponent(String(installationId))}/grant?organizationId=${encodeURIComponent(organizationId)}`,
        { method: "DELETE" }
      ),
    onSuccess: async (_result, variables) => {
      await Promise.all([
        qc.invalidateQueries({
          queryKey: ["github", "installations", variables.organizationId],
        }),
        qc.invalidateQueries({ queryKey: ["github", "repos"] }),
        qc.invalidateQueries({ queryKey: ["github", "branches"] }),
        qc.invalidateQueries({ queryKey: ["github", "file-exists"] }),
        qc.invalidateQueries({ queryKey: ["repository-targets"] }),
        qc.invalidateQueries({ queryKey: ["stack-classifier"] }),
      ])
    },
  })
}

// ---------------------------------------------------------------------------
// Cache status — exposes per-installation freshness + repo count from DB.
// ---------------------------------------------------------------------------

export interface CacheStatusEntry {
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

export interface CacheStatusResponse {
  installations: Array<CacheStatusEntry>
  staleThresholdMs: number
}

export function useGitHubCacheStatus(
  opts: { autoRefresh?: boolean; enabled?: boolean } = {}
) {
  return useQuery<CacheStatusResponse, ApiError>({
    queryKey: ["github", "cache-status"],
    queryFn: () =>
      apiFetch<CacheStatusResponse>("/github/installations/cache-status"),
    enabled: opts.enabled ?? true,
    staleTime: 5_000,
    refetchInterval: opts.autoRefresh ? 3_000 : false,
  })
}

export function useSyncGitHubInstallations() {
  const qc = useQueryClient()
  return useMutation<
    { enqueued: true; syncId: string },
    ApiError,
    { installationId?: string } | void
  >({
    mutationFn: (vars) =>
      apiFetch<{ enqueued: true; syncId: string }>(
        "/github/installations/sync",
        {
          method: "POST",
          body: vars ?? {},
          headers: { "content-type": "application/json" },
        }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["github", "cache-status"] })
      qc.invalidateQueries({ queryKey: ["github", "repos"] })
    },
  })
}
