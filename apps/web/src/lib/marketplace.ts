// SPDX-License-Identifier: AGPL-3.0-only
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import { apiFetch } from "./api"
import type { ApiError } from "./api"
import type {
  MarketplaceCatalogPage,
  MarketplaceTemplate,
  MarketplaceTemplateFiles,
} from "@ploydok/shared"

export type { MarketplaceTemplate, MarketplaceTemplateFiles }

export const CATALOG_PAGE_SIZE = 24

export const marketplaceKeys = {
  all: ["marketplace"] as const,
  catalog: (q: string) => ["marketplace", "catalog", q] as const,
  template: (id: string) => ["marketplace", "template", id] as const,
}

export function useMarketplaceCatalog(query: string) {
  return useInfiniteQuery<MarketplaceCatalogPage, ApiError>({
    queryKey: marketplaceKeys.catalog(query),
    queryFn: ({ pageParam }) => {
      const cursor = (pageParam as number | undefined) ?? 0
      const params = new URLSearchParams({
        cursor: String(cursor),
        limit: String(CATALOG_PAGE_SIZE),
      })
      if (query) params.set("q", query)
      return apiFetch<MarketplaceCatalogPage>(
        `/marketplace/templates?${params.toString()}`
      )
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    initialPageParam: 0,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  })
}

export function useMarketplaceTemplateFiles(id: string | null) {
  return useQuery<MarketplaceTemplateFiles, ApiError>({
    queryKey: marketplaceKeys.template(id ?? ""),
    queryFn: () =>
      apiFetch<MarketplaceTemplateFiles>(`/marketplace/templates/${id}`),
    enabled: Boolean(id),
    staleTime: 10 * 60 * 1000,
  })
}
