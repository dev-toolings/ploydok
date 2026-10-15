// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import i18n from "./i18n"

export type StorageDestinationKind = "local" | "s3"
export type StorageDestinationTestStatus = "success" | "failure" | null

export interface StorageDestination {
  id: string
  name: string
  kind: StorageDestinationKind
  endpoint: string | null
  bucket: string | null
  region: string | null
  credentialsConfigured: boolean
  usageCount: number
  lastTestAt: string | null
  lastTestStatus: StorageDestinationTestStatus
  lastTestError: string | null
  createdAt?: string
}

export interface StorageDestinationInput {
  name: string
  kind: StorageDestinationKind
  endpoint?: string
  bucket?: string
  region?: string
  credentials?: {
    accessKeyId: string
    secretAccessKey: string
  }
}

const storageDestinationsKey = (orgSlug: string) =>
  ["storage-destinations", orgSlug] as const

function storageDestinationsPath(orgSlug: string): string {
  return `/orgs/${encodeURIComponent(orgSlug)}/storage-destinations`
}

export function useStorageDestinations(orgSlug: string | null) {
  return useQuery({
    queryKey: storageDestinationsKey(orgSlug ?? ""),
    enabled: Boolean(orgSlug),
    queryFn: async () => {
      const data = await apiFetch<{
        destinations: Array<StorageDestination>
      }>(storageDestinationsPath(orgSlug!))
      return data.destinations
    },
  })
}

export function useCreateStorageDestination(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: StorageDestinationInput) =>
      apiFetch<{ destination: StorageDestination }>(
        storageDestinationsPath(orgSlug),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: input,
        }
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: storageDestinationsKey(orgSlug),
      })
      toast.success(i18n.t("storage:toasts.created"))
    },
    onError: (error: Error) => {
      toast.error(
        i18n.t("storage:toasts.createFailed", { message: error.message })
      )
    },
  })
}

export function useUpdateStorageDestination(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      destinationId,
      input,
    }: {
      destinationId: string
      input: Partial<StorageDestinationInput>
    }) =>
      apiFetch<{ destination: StorageDestination }>(
        `${storageDestinationsPath(orgSlug)}/${destinationId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: input,
        }
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: storageDestinationsKey(orgSlug),
      })
      toast.success(i18n.t("storage:toasts.updated"))
    },
    onError: (error: Error) => {
      toast.error(
        i18n.t("storage:toasts.updateFailed", { message: error.message })
      )
    },
  })
}

export function useTestStorageDestination(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (destinationId: string) =>
      apiFetch<{ ok: boolean }>(
        `${storageDestinationsPath(orgSlug)}/${destinationId}/test`,
        { method: "POST" }
      ),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: storageDestinationsKey(orgSlug),
      })
    },
    onSuccess: () => {
      toast.success(i18n.t("storage:toasts.tested"))
    },
    onError: (error: Error) => {
      toast.error(
        i18n.t("storage:toasts.testFailed", { message: error.message })
      )
    },
  })
}

export function useDeleteStorageDestination(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (destinationId: string) =>
      apiFetch<{ ok: boolean }>(
        `${storageDestinationsPath(orgSlug)}/${destinationId}`,
        { method: "DELETE" }
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: storageDestinationsKey(orgSlug),
      })
      toast.success(i18n.t("storage:toasts.deleted"))
    },
    onError: (error: Error) => {
      toast.error(
        i18n.t("storage:toasts.deleteFailed", { message: error.message })
      )
    },
  })
}
