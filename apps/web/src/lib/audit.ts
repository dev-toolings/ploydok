// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { AuditListResponseSchema } from "@ploydok/shared"
import { apiFetch } from "./api"
import type { AuditListResponse } from "@ploydok/shared"

export interface UseAuditEventsOptions {
  limit?: number
  cursor?: number
  actionPrefix?: string
  targetType?: string
}

const EMPTY: AuditListResponse = { events: [], nextCursor: null }

export function useAuditEvents(
  orgId: string | undefined,
  opts: UseAuditEventsOptions = {}
) {
  const { limit = 50, cursor, actionPrefix, targetType } = opts

  return useQuery<AuditListResponse>({
    enabled: Boolean(orgId),
    queryKey: ["audit", orgId, { limit, cursor, actionPrefix, targetType }],
    queryFn: async () => {
      const params = new URLSearchParams({
        orgId: orgId as string,
        limit: limit.toString(),
      })
      if (cursor !== undefined) params.append("cursor", cursor.toString())
      if (actionPrefix) params.append("actionPrefix", actionPrefix)
      if (targetType) params.append("targetType", targetType)

      try {
        const data = await apiFetch<unknown>(`/audit?${params}`)
        const parsed = AuditListResponseSchema.safeParse(data)
        return parsed.success ? parsed.data : EMPTY
      } catch {
        return EMPTY
      }
    },
    placeholderData: keepPreviousData,
    retry: false,
  })
}
