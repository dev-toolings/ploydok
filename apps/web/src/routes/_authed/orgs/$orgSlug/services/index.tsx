// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  RiArrowRightUpLine,
  RiExternalLinkLine,
  RiShapesLine,
} from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../../lib/page-metadata"
import {
  ShellPage,
  ShellPanel,
} from "../../../../../components/layout/AppShell"
import { ServiceStatusBadge } from "../../../../../components/services/ServiceStatusBadge"
import { useServices } from "../../../../../lib/services"
import {
  organizationPath,
  useCurrentOrganization,
} from "../../../../../lib/organizations"
import type { ServiceSummary } from "../../../../../lib/services"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/services/")({
  head: createPageHead("services"),
  component: ServicesPage,
})

function ServicesPage(): React.JSX.Element {
  const { t } = useTranslation("services")
  const organization = useCurrentOrganization()
  const { data: services = [], isLoading, error } = useServices()

  return (
    <ShellPage
      title={t("title")}
      description={t("description")}
      eyebrow={organization?.name ?? t("workspace:eyebrow")}
    >
      <ShellPanel
        title={t("installed")}
        description={t("installedHint")}
      >
        {isLoading ? (
          <ServicesGridSkeleton />
        ) : error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {t("listFailed")}
          </p>
        ) : services.length === 0 ? (
          <EmptyState orgSlug={organization?.slug ?? ""} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {services.map((svc: ServiceSummary) => (
              <ServiceCard key={svc.id} service={svc} />
            ))}
          </div>
        )}
      </ShellPanel>
    </ShellPage>
  )
}

function ServiceCard({
  service,
}: {
  service: ServiceSummary
}): React.JSX.Element {
  const { t, i18n } = useTranslation("services")
  const { orgSlug } = Route.useParams()
  const detailPath = organizationPath(orgSlug, `services/${service.id}`)
  const installedAt = new Date(service.created_at).toLocaleDateString(
    i18n.language,
    {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }
  )

  return (
    <Link
      to={detailPath as never}
      className="group rounded-xl border border-panel-border bg-panel-inset p-4 shadow-sm transition-colors outline-none hover:border-muted-foreground/30 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">
            {service.name}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {service.template_id}
            {service.template_version ? ` v${service.template_version}` : ""}
          </p>
        </div>
        <ServiceStatusBadge status={service.status} />
      </div>

      {service.domain && service.status === "running" ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <RiExternalLinkLine className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{service.domain}</span>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        <span className="text-xs text-muted-foreground">
          {t("installedOn", { date: installedAt })}
        </span>
        <RiArrowRightUpLine className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </div>
    </Link>
  )
}

function EmptyState({ orgSlug }: { orgSlug: string }): React.JSX.Element {
  const { t } = useTranslation("services")
  const marketplacePath = organizationPath(orgSlug, "marketplace")
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-panel-border bg-panel-inset px-6 py-12 text-center">
      <RiShapesLine className="size-6 text-muted-foreground" />
      <div>
        <p className="text-sm font-semibold text-foreground">
          {t("empty")}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("emptyHint")}{" "}
          <Link
            to={marketplacePath as never}
            className="text-primary underline underline-offset-2"
          >
            {t("marketplaceLink")}
          </Link>
          .
        </p>
      </div>
    </div>
  )
}

function ServicesGridSkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 4 }).map((_, idx) => (
        <div
          key={idx}
          className="rounded-xl border border-panel-border bg-panel-inset p-4 shadow-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 skeleton-surface rounded" />
              <div className="h-3 w-24 skeleton-surface rounded" />
            </div>
            <div className="h-5 w-16 skeleton-surface rounded" />
          </div>
          <div className="mt-4 border-t border-border pt-4">
            <div className="h-3 w-28 skeleton-surface rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}
