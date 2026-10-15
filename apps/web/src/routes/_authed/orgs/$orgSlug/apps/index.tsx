// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  RiAddLine,
  RiArrowRightUpLine,
  RiGitBranchLine,
  RiGlobalLine,
} from "@remixicon/react"
import { createPageHead } from "../../../../../lib/page-metadata"
import { CreateAppModal } from "../../../../../components/apps/CreateAppModal"
import {
  ShellPage,
  ShellPanel,
} from "../../../../../components/layout/AppShell"
import { AppStatusBadge } from "../../../../../components/apps/AppStatusBadge"
import { AppIcon } from "../../../../../components/apps/AppIcon"
import {
  resolveAppHealth,
  resolveRuntimeAppStatus,
  selectAppSnapshot,
} from "../../../../../lib/app-runtime"
import { useApps } from "../../../../../lib/apps"
import { useGitHubAppConfig } from "../../../../../lib/github"
import { useMonitoring } from "../../../../../lib/monitoring"
import {
  organizationPath,
  useCurrentOrganization,
  useCurrentOrganizationSlug,
} from "../../../../../lib/organizations"
import type { AppHealth } from "../../../../../lib/app-runtime"
import type { AppListItem } from "../../../../../lib/apps"

function AppsPage(): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [modalOpen, setModalOpen] = React.useState(false)
  const organization = useCurrentOrganization()
  const currentOrgSlug = useCurrentOrganizationSlug()
  const { data: apps = [], isLoading, error } = useApps(organization?.id)
  const shouldShowEmptyState = !isLoading && !error && apps.length === 0
  const { data: appConfig } = useGitHubAppConfig({
    enabled: shouldShowEmptyState,
  })
  const { data: monitoring } = useMonitoring({ enabled: apps.length > 0 })
  const containers = monitoring?.containers ?? []
  const appsWithRuntimeStatus = React.useMemo(
    () =>
      apps.map((app) => {
        const snapshot = selectAppSnapshot(containers, app.id, app.containerId)
        return {
          ...app,
          runtimeStatus: resolveRuntimeAppStatus(app.status, snapshot),
          runtimeHealth: resolveAppHealth(snapshot),
        }
      }),
    [apps, containers]
  )

  return (
    <ShellPage
      title={t("list.title")}
      description={t("list.description")}
      actions={
        <Button size="sm" onClick={() => setModalOpen(true)}>
          <RiAddLine className="size-4" />
          {t("list.newApp")}
        </Button>
      }
    >
      <ShellPanel
        title={t("list.title")}
        description={t("list.panelDescription")}
      >
        {isLoading ? (
          <AppsGridSkeleton />
        ) : error ? (
          <p
            className="rounded-md border border-destructive/30 bg-neg-100 dark:bg-[#4d0218]/60 px-4 py-3 text-sm text-neg-700 dark:text-[#ff637e]"
            role="alert"
          >
            {t("list.loadFailed", { message: error.message })}
          </p>
        ) : appsWithRuntimeStatus.length > 0 ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {appsWithRuntimeStatus.map((app) => (
              <AppCard key={app.id} app={app} currentOrgSlug={currentOrgSlug} />
            ))}
          </div>
        ) : (
          <EmptyState
            isGitHubConnected={appConfig?.configured ?? false}
            onCreateApp={() => setModalOpen(true)}
          />
        )}
      </ShellPanel>

      <CreateAppModal
        open={modalOpen}
        organizationId={organization?.id}
        onClose={() => setModalOpen(false)}
      />
    </ShellPage>
  )
}

function AppCard({
  app,
  currentOrgSlug,
}: {
  app: AppListItem & {
    runtimeStatus: AppListItem["status"]
    runtimeHealth: AppHealth | null
  }
  currentOrgSlug: string | null
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const isDeleting = app.status === "deleting"
  const quickLinks = (app.quickLinks ?? []).slice(0, 3)
  const settingsPath = currentOrgSlug
    ? organizationPath(currentOrgSlug, `apps/${app.id}/settings`)
    : `/apps/${app.id}/settings`
  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AppIcon name={app.name} src={app.iconUrl} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">
              {app.name}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {app.repoFullName ?? app.imageRef ?? t("list.repoPending")}
            </p>
          </div>
        </div>
        <AppStatusBadge status={app.runtimeStatus} health={app.runtimeHealth} />
      </div>

      <div className="mt-4 grid gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <RiGitBranchLine className="size-4" />
          <span>{app.branch ?? "main"}</span>
        </div>
        <div className="flex items-center gap-2">
          <RiGlobalLine className="size-4" />
          <span className="truncate">{app.domain ?? t("list.domainPending")}</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        <span className="text-xs text-muted-foreground">
          {isDeleting ? t("empty.deletionInProgress") : t("list.openDeployment")}
        </span>
        <RiArrowRightUpLine
          className={[
            "size-4 text-muted-foreground transition-transform",
            isDeleting
              ? "opacity-40"
              : "group-hover:translate-x-0.5 group-hover:-translate-y-0.5",
          ]
            .filter(Boolean)
            .join(" ")}
        />
      </div>
    </>
  )

  if (isDeleting) {
    return (
      <div
        className="cursor-not-allowed rounded-lg border border-border bg-muted/30 p-4 opacity-60"
        aria-disabled="true"
      >
        {content}
      </div>
    )
  }

  return (
    <article className="group overflow-hidden rounded-[10px] bg-panel-inset transition-colors shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]">
      <Link
        to={settingsPath as never}
        className="block p-4 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {content}
      </Link>
      {quickLinks.length > 0 ? (
        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          {quickLinks.map((link) => (
            <a
              key={`${link.label}-${link.url}`}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </article>
  )
}

function EmptyState({
  isGitHubConnected,
  onCreateApp,
}: {
  isGitHubConnected: boolean
  onCreateApp: () => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div className="rounded-lg border border-dashed border-panel-border bg-panel-inset px-6 py-12 text-center">
      <p className="text-sm font-semibold text-foreground">
        {t("list.emptyTitle")}
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {isGitHubConnected
          ? t("list.emptyConnected")
          : t("list.emptyDisconnected")}
      </p>
      <div className="mt-5 flex justify-center gap-2">
        {isGitHubConnected ? (
          <Button size="sm" onClick={onCreateApp}>
            {t("gettingStarted.createApp")}
          </Button>
        ) : (
          <Button size="sm" variant="outline" asChild>
            <Link
              to="/settings/git-providers/$slug"
              params={{ slug: "github" }}
            >
              {t("gettingStarted.connectGithub")}
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}

function AppsGridSkeleton(): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div
      className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
      aria-busy="true"
      aria-label={t("list.loading")}
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="rounded-[10px] bg-panel-inset p-4 shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <Skeleton className="size-10 rounded-xl" />
              <div className="min-w-0 space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-44" />
              </div>
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <div className="mt-4 grid gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="size-4 rounded" />
          </div>
        </div>
      ))}
    </div>
  )
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/")({
  head: createPageHead("applications"),
  component: AppsPage,
})
