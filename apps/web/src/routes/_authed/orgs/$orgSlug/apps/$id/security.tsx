// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { createPageHead } from "../../../../../../lib/page-metadata"
import { AdvisoryTable } from "../../../../admin/security/advisories"
import { useAppAdvisories } from "../../../../../../lib/advisories"
import { getLatestScan } from "../../../../../../lib/app-scans"
import type { BuildScanSummary } from "@ploydok/shared"

export const Route = createFileRoute(
  "/_authed/orgs/$orgSlug/apps/$id/security"
)({
  head: createPageHead("applicationSecurity"),
  component: AppSecurityPage,
})

function AppSecurityPage(): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { orgSlug, id } = Route.useParams()
  const { data, isLoading, error } = useAppAdvisories(orgSlug, id)

  return (
    <div className="w-full space-y-5 px-4 py-6 md:px-8">
      <div>
        <h1 className="text-xl leading-[26px] font-medium text-foreground">
          {t("securityTab.title")}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {t("securityTab.description")}
        </p>
      </div>

      <ImageScanPanel appId={id} />

      {data?.disabled ? (
        <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          {t("securityTab.cveDisabled")}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-neg-100 dark:bg-[#4d0218]/60 p-4 text-sm text-neg-700 dark:text-[#ff637e]">
          {t("securityTab.loadFailed")}
        </div>
      ) : null}

      <AdvisoryTable rows={data?.matches ?? []} loading={isLoading} />
    </div>
  )
}

const SEVERITY_TONES = {
  critical: "bg-red-100 text-red-900",
  high: "bg-orange-100 text-orange-900",
  medium: "bg-yellow-100 text-yellow-900",
  low: "bg-blue-100 text-blue-900",
  unknown: "bg-muted text-muted-foreground",
} as const

function ScanSeverityBadge({
  label,
  count,
  tone,
}: {
  label: string
  count: number
  tone: keyof typeof SEVERITY_TONES
}): React.JSX.Element {
  return (
    <Badge className={SEVERITY_TONES[tone]}>
      {label}: {count}
    </Badge>
  )
}

function ImageScanPanel({ appId }: { appId: string }): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { data, isLoading, error } = useQuery<BuildScanSummary | null>({
    queryKey: ["app", "scans", "latest", appId],
    queryFn: () => getLatestScan(appId),
    enabled: Boolean(appId),
  })

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div>
        <h2 className="text-sm font-medium text-foreground">
          {t("securityTab.imageVulns")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("securityTab.imageVulnsHint")}
        </p>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/30 bg-neg-100 dark:bg-[#4d0218]/60 p-3 text-sm text-neg-700 dark:text-[#ff637e]"
          role="alert"
        >
          {t("securityTab.scanLoadFailed")}
        </div>
      ) : isLoading ? (
        <div aria-busy="true" aria-label={t("securityTab.loadingAdvisories")}>
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ) : !data ? (
        <div className="text-sm text-muted-foreground">{t("securityTab.noScan")}</div>
      ) : data.status === "pending" || data.status === "running" ? (
        <div
          className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
          aria-live="polite"
        >
          {data.status === "running"
            ? t("securityTab.scanInProgress")
            : t("securityTab.scanQueued")}
        </div>
      ) : data.status === "skipped" ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t("securityTab.scannerMissing")}
        </div>
      ) : data.status === "failed" ? (
        <div className="rounded-md border border-destructive/30 bg-neg-100 dark:bg-[#4d0218]/60 p-3 text-sm text-neg-700 dark:text-[#ff637e]">
          {t("securityTab.scanFailed")}
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <ScanSeverityBadge
            label={t("securityTab.critical")}
            count={data.critical}
            tone="critical"
          />
          <ScanSeverityBadge label={t("securityTab.high")} count={data.high} tone="high" />
          <ScanSeverityBadge label={t("securityTab.medium")} count={data.medium} tone="medium" />
          <ScanSeverityBadge label={t("securityTab.low")} count={data.low} tone="low" />
          <ScanSeverityBadge
            label={t("securityTab.unknown")}
            count={data.unknown}
            tone="unknown"
          />
        </div>
      )}
    </section>
  )
}
