// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { RiRefreshLine, RiShieldCheckLine } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { createPageHead } from "../../../../lib/page-metadata"
import {
  useAcknowledgeAdvisory,
  useAdminAdvisories,
  useRefreshAdvisories,
} from "../../../../lib/advisories"
import type { AdvisoryRow } from "../../../../lib/advisories"

export const Route = createFileRoute("/_authed/admin/security/advisories")({
  head: createPageHead("advisories"),
  component: AdminAdvisoriesPage,
})

function AdminAdvisoriesPage(): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const { data, isLoading, error } = useAdminAdvisories()
  const refresh = useRefreshAdvisories()

  return (
    <div className="w-full space-y-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t("advisories.title")}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("advisories.description")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="gap-2"
          onClick={() => refresh.mutate()}
          loading={refresh.isPending}
        >
          <RiRefreshLine className="size-4" />
          {t("common:refresh")}
        </Button>
      </div>

      {data?.disabled ? (
        <div className="rounded-md border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          {t("advisories.disabled")}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {t("advisories.loadFailed")}
        </div>
      ) : null}

      <AdvisoryTable rows={data?.matches ?? []} loading={isLoading} />
    </div>
  )
}

export function AdvisoryTable({
  rows,
  loading,
}: {
  rows: Array<AdvisoryRow>
  loading?: boolean
}): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const ack = useAcknowledgeAdvisory()

  if (loading) {
    return (
      <div className="rounded-md border border-border p-4" aria-busy="true" aria-label={t("advisories.loading")}>
        <Skeleton className="h-16 w-full rounded-md" />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed border-panel-border bg-panel-inset text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <RiShieldCheckLine className="size-4" />
          {t("advisories.empty")}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">{t("advisories.severity")}</th>
            <th className="px-3 py-2">{t("advisories.package")}</th>
            <th className="px-3 py-2">{t("advisories.advisory")}</th>
            <th className="px-3 py-2">{t("advisories.scope")}</th>
            <th className="px-3 py-2 text-right">{t("advisories.action")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.match.id} className="border-b border-border last:border-b-0">
              <td className="px-3 py-3">
                <SeverityBadge severity={row.match.severity_level} />
              </td>
              <td className="px-3 py-3 font-mono text-xs">
                {row.match.package_name}@{row.match.current_version}
                <div className="mt-1 text-muted-foreground">
                  {row.match.ecosystem} · {row.match.manifest_path}
                </div>
              </td>
              <td className="px-3 py-3">
                <a
                  href={`https://osv.dev/vulnerability/${row.advisory.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  {row.advisory.id}
                </a>
                {row.advisory.summary ? (
                  <div className="mt-1 max-w-xl text-xs text-muted-foreground">
                    {row.advisory.summary}
                  </div>
                ) : null}
              </td>
              <td className="px-3 py-3 text-xs text-muted-foreground">
                {row.match.scope === "platform"
                  ? t("advisories.platform")
                  : `${row.org_slug ?? "org"} / ${row.app_name ?? row.match.app_id}`}
              </td>
              <td className="px-3 py-3 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  loading={ack.isPending}
                  onClick={() => ack.mutate({ matchId: row.match.id })}
                >
                  {t("advisories.acknowledge")}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SeverityBadge({
  severity,
}: {
  severity: AdvisoryRow["match"]["severity_level"]
}): React.JSX.Element {
  const tone =
    severity === "CRITICAL"
      ? "bg-red-100 text-red-900"
      : severity === "HIGH"
        ? "bg-orange-100 text-orange-900"
        : severity === "MEDIUM"
          ? "bg-yellow-100 text-yellow-900"
          : severity === "LOW"
            ? "bg-blue-100 text-blue-900"
            : "bg-muted text-muted-foreground"
  return <Badge className={tone}>{severity}</Badge>
}
