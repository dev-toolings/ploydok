// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { apiFetch } from "./api"
import i18n from "./i18n"
import type {
  StorageCredentialsInput,
  StorageDestinationKind,
  StorageProviderId,
} from "@ploydok/shared"

export type { StorageDestinationKind, StorageProviderId }
export type StorageDestinationTestStatus = "success" | "failure" | null

export interface StorageDestination {
  id: string
  name: string
  kind: StorageDestinationKind
  provider: StorageProviderId
  endpoint: string | null
  bucket: string | null
  region: string | null
  /** Folder of a local destination on the server, null for remote ones. */
  localPath: string | null
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
  provider?: StorageProviderId
  endpoint?: string | null
  bucket?: string
  region?: string
  credentials?: StorageCredentialsInput
}

const storageDestinationsKey = (orgSlug: string) =>
  ["storage-destinations", orgSlug] as const

function storageDestinationsPath(orgSlug: string): string {
  return `/orgs/${encodeURIComponent(orgSlug)}/storage-destinations`
}

interface StorageDestinationsResponse {
  destinations: Array<StorageDestination>
  /** Server directory under which each local destination gets its folder. */
  localRoot: string
}

function storageDestinationsQuery(orgSlug: string | null) {
  return {
    queryKey: storageDestinationsKey(orgSlug ?? ""),
    enabled: Boolean(orgSlug),
    queryFn: () =>
      apiFetch<StorageDestinationsResponse>(storageDestinationsPath(orgSlug!)),
  }
}

export function useStorageDestinations(orgSlug: string | null) {
  return useQuery({
    ...storageDestinationsQuery(orgSlug),
    select: (data) => data.destinations,
  })
}

export function useLocalStorageRoot(orgSlug: string | null) {
  return useQuery({
    ...storageDestinationsQuery(orgSlug),
    select: (data) => data.localRoot,
  })
}

function updateCachedDestinations(
  queryClient: ReturnType<typeof useQueryClient>,
  orgSlug: string,
  update: (destinations: Array<StorageDestination>) => Array<StorageDestination>
): void {
  queryClient.setQueryData<StorageDestinationsResponse>(
    storageDestinationsKey(orgSlug),
    (current) =>
      current && { ...current, destinations: update(current.destinations) }
  )
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
    onSuccess: ({ destination }) => {
      // Show the row in the same frame as the toast instead of after a refetch.
      // The API orders by name: insert in place so the refetch does not move it.
      updateCachedDestinations(queryClient, orgSlug, (current) =>
        [...current, destination].sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        )
      )
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

export interface StorageDestinationTestInput {
  destinationId: string
  /** Create the bucket or container when the provider reports it missing. */
  createBucket?: boolean
}

export function useTestStorageDestination(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      destinationId,
      createBucket,
    }: StorageDestinationTestInput) =>
      apiFetch<{ ok: boolean; bucketCreated?: boolean }>(
        `${storageDestinationsPath(orgSlug)}/${destinationId}/test`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: { createBucket: Boolean(createBucket) },
        }
      ),
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({
        queryKey: storageDestinationsKey(orgSlug),
      })
      toast.success(
        i18n.t(
          data.bucketCreated
            ? "storage:toasts.testedBucketCreated"
            : "storage:toasts.tested"
        )
      )
    },
    onError: async (_error: Error, { destinationId }) => {
      await queryClient.invalidateQueries({
        queryKey: storageDestinationsKey(orgSlug),
      })
      // The API stores a classified reason; read it from the refreshed row
      // so the toast says what to fix rather than "test failed".
      const destination = queryClient
        .getQueryData<StorageDestinationsResponse>(
          storageDestinationsKey(orgSlug)
        )
        ?.destinations.find((item) => item.id === destinationId)
      toast.error(i18n.t("storage:toasts.testFailedTitle"), {
        description: i18n.t(testFailureKey(destination?.lastTestError ?? null)),
      })
    },
  })
}

const TEST_FAILURE_REASONS = new Set([
  "auth_failed",
  "bucket_not_found",
  "endpoint_unreachable",
  "endpoint_blocked",
  "timeout",
])

/** i18n key that explains a stored test failure reason. */
export function testFailureKey(reason: string | null): string {
  return `storage:reasons.${reason && TEST_FAILURE_REASONS.has(reason) ? reason : "unknown"}`
}

export function useDeleteStorageDestination(orgSlug: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (destinationId: string) =>
      apiFetch<{ ok: boolean }>(
        `${storageDestinationsPath(orgSlug)}/${destinationId}`,
        { method: "DELETE" }
      ),
    onSuccess: (_data, destinationId) => {
      updateCachedDestinations(queryClient, orgSlug, (current) =>
        current.filter((item) => item.id !== destinationId)
      )
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
