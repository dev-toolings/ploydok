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

export interface Domain {
  id: string
  hostname: string
  /** TLS certificate lifecycle status. */
  tlsStatus: "pending" | "issued" | "failed" | "not_required"
  createdAt: string | null
}

interface DomainsResponse {
  domains: Array<Domain>
}

interface DomainResponse {
  domain: Domain
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
  })
}

// ---------------------------------------------------------------------------
// useAddDomain — POST /apps/:id/domains
// ---------------------------------------------------------------------------

export function useAddDomain(appId: string) {
  const qc = useQueryClient()

  return useMutation<Domain, ApiError, { hostname: string }>({
    mutationFn: async ({ hostname }) => {
      const data = await apiFetch<DomainResponse>(`/apps/${appId}/domains`, {
        method: "POST",
        body: { hostname },
        headers: { "content-type": "application/json" },
      })
      return data.domain
    },
    onSuccess: () => {
      toast.success(i18n.t("apps:toasts.domainAdded"))
      void qc.invalidateQueries({ queryKey: domainsQueryKey(appId) })
    },
    onError: (error) => {
      notifyMutationError(error, i18n.t("apps:toasts.addDomainFailed"))
    },
  })
}

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
// useRecheckDomain — POST /apps/:id/domains/:domainId/recheck
// ---------------------------------------------------------------------------

export function useRecheckDomain(appId: string) {
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
      toast.success(i18n.t("apps:toasts.tlsRefreshed"))
      // Optimistically patch the cached list so the badge updates immediately.
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
