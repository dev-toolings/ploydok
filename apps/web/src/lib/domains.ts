// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import i18n from "./i18n"
import { notifyMutationError } from "./second-factor-toast"
import type { ApiError } from "./api"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TlsStatus = "pending" | "issued" | "failed" | "not_required"
export type TlsMode = "http01" | "dns01"
export type Dns01Provider = "cloudflare" | "route53" | "ovh" | "digitalocean"

export interface Domain {
  id: string
  hostname: string
  tlsStatus: TlsStatus
  tlsMode: TlsMode
  dns01Provider: Dns01Provider | null
  verifyToken: string | null
  verifyError: string | null
  createdAt: string | null
}

interface DomainsResponse {
  domains: Array<Domain>
}

interface DomainResponse {
  domain: Domain
}

export interface CreateDomainParams {
  hostname: string
  tls_mode?: TlsMode
  dns01_provider?: Dns01Provider
  wildcard?: boolean
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export function domainsQueryKey(appId: string) {
  return ["apps", appId, "domains"] as const
}

// ---------------------------------------------------------------------------
// useDomains — GET /apps/:id/domains
// ---------------------------------------------------------------------------

export function useDomains(appId: string) {
  return useQuery<Array<Domain>, ApiError>({
    queryKey: domainsQueryKey(appId),
    queryFn: async () => {
      const data = await apiFetch<DomainsResponse>(`/apps/${appId}/domains`)
      return data.domains
    },
    enabled: Boolean(appId),
    staleTime: 30_000,
    refetchInterval: 15_000,
  })
}

// ---------------------------------------------------------------------------
// useCreateDomain — POST /apps/:id/domains
// ---------------------------------------------------------------------------

export function useCreateDomain(appId: string) {
  const qc = useQueryClient()

  return useMutation<Domain, ApiError, CreateDomainParams>({
    mutationFn: async (params) => {
      const data = await apiFetch<DomainResponse>(`/apps/${appId}/domains`, {
        method: "POST",
        body: params,
        headers: { "content-type": "application/json" },
      })
      return data.domain
    },
    onSuccess: () => {
      toast.success(i18n.t("apps:toasts.domainAddedVerify"))
      void qc.invalidateQueries({ queryKey: domainsQueryKey(appId) })
    },
    onError: (error) => {
      notifyMutationError(error, i18n.t("apps:toasts.addDomainFailed"))
    },
  })
}

// Keep old hook name for backwards compat with existing domains.tsx
export const useAddDomain = useCreateDomain

// ---------------------------------------------------------------------------
// useDeleteDomain — DELETE /apps/:id/domains/:domainId
// ---------------------------------------------------------------------------

export function useDeleteDomain(appId: string) {
  const qc = useQueryClient()

  return useMutation<void, ApiError, { domainId: string }>({
    mutationFn: async ({ domainId }) => {
      await apiFetch<void>(`/apps/${appId}/domains/${domainId}`, {
        method: "DELETE",
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: domainsQueryKey(appId) })
    },
    onError: (error) => {
      notifyMutationError(error, i18n.t("apps:toasts.deleteDomainFailed"))
    },
  })
}

// ---------------------------------------------------------------------------
// useSwitchTlsMode — POST /apps/:id/domains/:domainId/tls/mode
// ---------------------------------------------------------------------------

export function useSwitchTlsMode(appId: string) {
  const qc = useQueryClient()

  return useMutation<
    Domain,
    ApiError,
    { domainId: string; tls_mode: TlsMode; dns01_provider?: Dns01Provider }
  >({
    mutationFn: async ({ domainId, ...body }) => {
      const data = await apiFetch<DomainResponse>(
        `/apps/${appId}/domains/${domainId}/tls/mode`,
        { method: "POST", body, headers: { "content-type": "application/json" } },
      )
      return data.domain
    },
    onSuccess: () => {
      toast.success(i18n.t("apps:toasts.tlsModeUpdated"))
      void qc.invalidateQueries({ queryKey: domainsQueryKey(appId) })
    },
    onError: (error) => {
      notifyMutationError(error, i18n.t("apps:toasts.switchTlsFailed"))
    },
  })
}

// ---------------------------------------------------------------------------
// useRetryVerification — enqueues domain.verify via recheck
// ---------------------------------------------------------------------------

export function useRetryVerification(appId: string) {
  const qc = useQueryClient()

  return useMutation<Domain, ApiError, { domainId: string }>({
    mutationFn: async ({ domainId }) => {
      const data = await apiFetch<DomainResponse>(
        `/apps/${appId}/domains/${domainId}/recheck`,
        { method: "POST" },
      )
      return data.domain
    },
    onSuccess: (updatedDomain) => {
      toast.success(i18n.t("apps:toasts.verificationRequeued"))
      qc.setQueryData<Array<Domain>>(domainsQueryKey(appId), (prev) => {
        if (!prev) return prev
        return prev.map((d) => (d.id === updatedDomain.id ? updatedDomain : d))
      })
    },
    onError: (error) => {
      toast.error(error.message)
    },
  })
}

// Keep old hook name for backwards compat
export const useRecheckDomain = useRetryVerification
