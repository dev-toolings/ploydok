// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { RiExternalLinkLine, RiTerminalBoxLine } from "@remixicon/react"
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { useTabShortcuts } from "../../lib/hooks/use-tab-shortcuts"
import { resolveDisplayedAppState } from "../../lib/app-runtime"
import { useMonitoring } from "../../lib/monitoring"
import {
  organizationPath,
  useCurrentOrganizationSlug,
} from "../../lib/organizations"
import { useRecheckAppRouting } from "../../lib/apps"
import { AppHeaderActions } from "./AppHeaderActions"
import { AppIcon } from "./AppIcon"
import { AppStatusBadge } from "./AppStatusBadge"
import { DeleteAppButton } from "./DeleteAppButton"
import type { AppDetail } from "../../lib/apps"
import type { AppHealth } from "../../lib/app-runtime"

interface NavItem {
  value: string
  labelKey: string
  segment: string
  /** When true, the tab requires app.status === "running" to be active. */
  requiresRunning?: boolean
}

const NAV_ITEMS: Array<NavItem> = [
  { value: "settings", labelKey: "nav.general", segment: "settings" },
  { value: "deployments", labelKey: "nav.deployments", segment: "deployments" },
  { value: "logs", labelKey: "nav.logs", segment: "logs", requiresRunning: true },
  { value: "env", labelKey: "nav.env", segment: "env" },
  { value: "domains", labelKey: "nav.domains", segment: "domains" },
  { value: "storage", labelKey: "nav.storage", segment: "storage" },
  { value: "previews", labelKey: "nav.previews", segment: "previews" },
  { value: "security", labelKey: "nav.security", segment: "security" },
  { value: "advanced", labelKey: "nav.advanced", segment: "advanced" },
]

export function AppBar({ app }: { app: AppDetail }): React.JSX.Element {
  const { t } = useTranslation("apps")
  const currentOrgSlug = useCurrentOrganizationSlug()
  useTabShortcuts(app.id, currentOrgSlug)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { data: monitoring } = useMonitoring()
  const displayedState = resolveDisplayedAppState(app, monitoring?.containers)
  const displayedApp = React.useMemo(
    () => ({ ...app, status: displayedState.status ?? app.status }),
    [app, displayedState.status]
  )

  const resolvedItems = React.useMemo(
    () =>
      NAV_ITEMS.map((item) => {
        const to = currentOrgSlug
          ? organizationPath(currentOrgSlug, `apps/${app.id}/${item.segment}`)
          : `/apps/${app.id}/${item.segment}`
        const disabled =
          item.requiresRunning === true && displayedApp.status !== "running"
        return { ...item, to, disabled }
      }),
    [app.id, currentOrgSlug, displayedApp.status]
  )

  const activeValue =
    resolvedItems.find(
      ({ to }) => pathname === to || pathname.startsWith(`${to}/`)
    )?.value ?? "settings"

  const shellHref = currentOrgSlug
    ? organizationPath(currentOrgSlug, `apps/${app.id}/shell`)
    : `/apps/${app.id}/shell`
  const shellDisabled = displayedApp.status !== "running"
  const routingActionRequired = app.routing?.status === "action_required"
  const routingCheck = useRecheckAppRouting(app.id)

  return (
    <div className="flex w-full shrink-0 flex-col gap-4 px-4 py-4 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <AppIdentity app={displayedApp} health={displayedState.health} />

        <div className="flex flex-wrap items-center gap-1.5">
          <AppHeaderActions app={displayedApp} />
          {shellDisabled ? (
            <Button
              size="sm"
              variant="ghost"
              disabled
              className="gap-1.5"
              title={t("nav.availableWhenRunning", {
                status: displayedApp.status,
              })}
            >
              <RiTerminalBoxLine className="size-4" aria-hidden="true" />
              {t("nav.shell")}
            </Button>
          ) : (
            <Button size="sm" variant="ghost" asChild className="gap-1.5">
              <Link to={shellHref as never}>
                <RiTerminalBoxLine className="size-4" aria-hidden="true" />
                {t("nav.shell")}
              </Link>
            </Button>
          )}
          <DeleteAppButton app={app} />
        </div>
      </div>

      {routingActionRequired ? (
        <RoutingActionBanner
          app={app}
          checking={routingCheck.isPending}
          onCheck={() => routingCheck.mutate()}
        />
      ) : null}

      <Tabs value={activeValue}>
        <TabsList>
          {resolvedItems.map((item) =>
            item.disabled ? (
              <TabsTrigger
                key={item.value}
                value={item.value}
                disabled
                title={t("nav.availableWhenRunning", {
                  status: displayedApp.status,
                })}
              >
                {t(item.labelKey)}
              </TabsTrigger>
            ) : (
              <TabsTrigger key={item.value} value={item.value} asChild>
                <Link to={item.to as never}>{t(item.labelKey)}</Link>
              </TabsTrigger>
            )
          )}
        </TabsList>
      </Tabs>
    </div>
  )
}

function RoutingActionBanner({
  app,
  checking,
  onCheck,
}: {
  app: AppDetail
  checking: boolean
  onCheck: () => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const issue = app.routing?.issue
  const details = [
    app.routing?.dnsStatus
      ? t("routing.dns", { status: t(`routing.dnsStatus.${app.routing.dnsStatus}`) })
      : null,
    app.routing?.tlsStatus
      ? t("routing.tls", { status: t(`routing.tlsStatus.${app.routing.tlsStatus}`) })
      : null,
  ].filter((value): value is string => Boolean(value))

  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-sm text-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500" />
        <div className="min-w-0">
          <p className="font-medium">
            {issue === "dns"
              ? t("routing.dnsActionRequired")
              : issue === "tls"
                ? t("routing.tlsActionRequired")
                : t("routing.actionRequired")}
          </p>
          {details.length > 0 ? (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              {details.join(" · ")}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("routing.actionHint")}
            </p>
          )}
        </div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        loading={checking}
        onClick={onCheck}
        className="min-h-11 shrink-0 border-amber-500/40 text-xs hover:bg-amber-500/10"
      >
        {checking ? t("routing.checking") : t("routing.checkAgain")}
      </Button>
    </div>
  )
}

function AppIdentity({
  app,
  health,
}: {
  app: AppDetail
  health: AppHealth | null
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div className="flex min-w-0 items-center gap-3">
      <AppIcon name={app.name} src={app.iconUrl} className="size-10" />
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className="truncate text-base leading-tight font-medium text-foreground">
            {app.name}
          </h1>
          <AppStatusBadge status={app.status} health={health} />
        </div>
        {app.domain ? (
          <a
            className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
            href={app.publicUrl ?? `http://${app.domain}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="truncate">{app.domain}</span>
            <RiExternalLinkLine
              className="size-3 shrink-0"
              aria-hidden="true"
            />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("empty.noDomain")}
          </span>
        )}
      </div>
    </div>
  )
}
