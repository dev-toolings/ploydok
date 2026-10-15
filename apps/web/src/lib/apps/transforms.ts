// SPDX-License-Identifier: AGPL-3.0-only
import type { AppStatus } from "@ploydok/shared"
import type { AppDetail, AppListItem, AppStatusEventPayload, RawAppDetail, RawAppListItem } from "./types"

// The API serializes app timestamps as ISO strings; the web models use unix ms.
export function toEpochMs(value: number | string): number {
  if (typeof value === "number") return value
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function normalizeAppListItem(raw: RawAppListItem): AppListItem {
  return {
    ...raw,
    createdAt: toEpochMs(raw.createdAt),
    updatedAt: toEpochMs(raw.updatedAt),
  }
}

export function normalizeAppDetail(raw: RawAppDetail): AppDetail {
  const { healthcheck, ...rest } = raw
  return {
    ...rest,
    createdAt: toEpochMs(raw.createdAt),
    updatedAt: toEpochMs(raw.updatedAt),
    healthcheckPath: healthcheck?.path ?? undefined,
    healthcheckPort: healthcheck?.port ?? null,
    healthcheckIntervalS: healthcheck?.intervalS ?? null,
    healthcheckTimeoutS: healthcheck?.timeoutS ?? null,
    healthcheckRetries: healthcheck?.retries ?? null,
    healthcheckStartPeriodS: healthcheck?.startPeriodS ?? null,
  }
}

export function applyAppStatus(
  app: AppDetail | AppListItem | undefined,
  status: AppStatus,
): AppDetail | AppListItem | undefined {
  if (!app) return app
  return { ...app, status }
}

export function getEventAppStatus(payload: AppStatusEventPayload): AppStatus | undefined {
  return payload.data?.status
}
