// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import i18n from "./i18n"
import type {
  CreateServiceFromTemplateBody,
  ServiceDetail,
  ServiceSummary,
} from "@ploydok/shared"

export type { ServiceSummary, ServiceDetail }
export type { ServiceStatus } from "@ploydok/shared"

export const servicesKeys = {
  all: ["services"] as const,
  list: (projectId?: string) =>
    ["services", "list", projectId ?? "all"] as const,
  detail: (id: string) => ["services", "detail", id] as const,
}

export function useServices(projectId?: string) {
  return useQuery({
    queryKey: servicesKeys.list(projectId),
    queryFn: async () => {
      const url = projectId ? `/services?projectId=${projectId}` : "/services"
      const res = await apiFetch<{ services: Array<ServiceSummary> }>(url)
      return res.services
    },
  })
}

export function useService(id: string | undefined) {
  return useQuery({
    queryKey: servicesKeys.detail(id ?? ""),
    queryFn: async () => {
      const res = await apiFetch<{ service: ServiceDetail }>(`/services/${id}`)
      return res.service
    },
    enabled: Boolean(id),
  })
}

export function useInstallService() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: CreateServiceFromTemplateBody) => {
      return apiFetch<{ service: ServiceSummary }>("/services/from-template", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: servicesKeys.list(vars.projectId) })
      toast.success(i18n.t("services:toasts.installStarted"))
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

function useServiceAction(action: "start" | "stop", successMessage: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      return apiFetch<{ ok: boolean }>(`/services/${id}/${action}`, {
        method: "POST",
      })
    },
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: servicesKeys.detail(id) })
      qc.invalidateQueries({ queryKey: servicesKeys.all })
      toast.success(successMessage)
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}

export function useStartService() {
  return useServiceAction("start", i18n.t("services:toasts.started"))
}

export function useStopService() {
  return useServiceAction("stop", i18n.t("services:toasts.stopped"))
}

export function useDeleteService() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      return apiFetch<{ ok: boolean }>(`/services/${id}`, {
        method: "DELETE",
        body: { confirm: `delete ${name}` },
        headers: { "content-type": "application/json" },
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: servicesKeys.all })
      toast.success(i18n.t("services:toasts.deleted"))
    },
    onError: (err: Error) => {
      toast.error(err.message)
    },
  })
}
