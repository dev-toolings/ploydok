// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, createFileRoute, useRouter } from "@tanstack/react-router"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  RiAddLine,
  RiAppsLine,
  RiCheckboxCircleLine,
  RiGithubFill,
  RiPlayCircleLine,
  RiRocketLine,
  RiTimerLine,
} from "@remixicon/react"
import { healthClass } from "@ploydok/shared"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import { CreateAppModal } from "../../../../components/apps/CreateAppModal"
import { GettingStartedPanel } from "../../../../components/apps/GettingStartedPanel"
import { ShellPage } from "../../../../components/layout/AppShell"
import {
  AppsShowcaseCard,
  DeploymentActivityCard,
  HostResourcesCard,
  KpiCard,
  RecentDeploymentsCard,
  formatKpiDuration,
  useKpis,
} from "../../../../components/dashboard/WorkspaceInsights"
import {
  resolveRuntimeAppStatus,
  selectAppSnapshot,
} from "../../../../lib/app-runtime"
import { useApps } from "../../../../lib/apps"
import { useMe } from "../../../../lib/auth"
import { useGitHubAppConfig } from "../../../../lib/github"
import { useOrgMonitoring } from "../../../../lib/org-monitoring"
import {
  organizationPath,
  useCurrentOrganization,
} from "../../../../lib/organizations"
import type { ContainerSnapshot } from "@ploydok/shared"

interface DashboardSearch {
  create?: "github" | "gitlab" | "image"
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/dashboard")({
  head: createPageHead("dashboard"),
  validateSearch: (search: Record<string, unknown>): DashboardSearch =>
    search.create === "image" ||
    search.create === "github" ||
    search.create === "gitlab"
      ? { create: search.create }
      : {},
  component: DashboardPage,
})

type RuntimeResourceHealth = "healthy" | "warn" | "down"

interface RuntimeResourceSummary {
  total: number
  running: number
  apps: number
  databases: number
  issues: number
}

function summarizeRuntimeResources(
  containers: Array<ContainerSnapshot>
): RuntimeResourceSummary {
  const resources = new Map<
    string,
    {
      kind: "app" | "database"
      running: boolean
      health: RuntimeResourceHealth
    }
  >()

  for (const container of containers) {
    if (container.kind !== "app" && container.kind !== "database") continue

    const resourceId = container.app_id ?? container.id
    const key = `${container.kind}:${resourceId}`
    const current = resources.get(key)
    const containerHealth = healthClass(container)

    resources.set(key, {
      kind: container.kind,
      running: (current?.running ?? false) || container.status === "running",
      health: mergeRuntimeHealth(current?.health, containerHealth),
    })
  }

  let running = 0
  let apps = 0
  let databases = 0
  let issues = 0

  for (const resource of resources.values()) {
    if (resource.running) running += 1
    if (resource.kind === "app") apps += 1
    else databases += 1
    if (resource.health !== "healthy") issues += 1
  }

  return {
    total: resources.size,
    running,
    apps,
    databases,
    issues,
  }
}

function mergeRuntimeHealth(
  current: RuntimeResourceHealth | undefined,
  next: RuntimeResourceHealth
): RuntimeResourceHealth {
  if (!current) return next
  if (current === "healthy" || next === "healthy") return "healthy"
  if (current === "warn" || next === "warn") return "warn"
  return "down"
}

function DashboardPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const router = useRouter()
  const { create } = Route.useSearch()
  const [modalOpen, setModalOpen] = React.useState(create !== undefined)
  const organization = useCurrentOrganization()
  const orgSlug = organization?.slug ?? ""
  const { data: me } = useMe()
  const {
    data: apps = [],
    isLoading: appsLoading,
    error: appsError,
  } = useApps(organization?.id)
  const { data: appConfig, isLoading: appConfigLoading } = useGitHubAppConfig()
  const { data: monitoring, isLoading: monitoringLoading } =
    useOrgMonitoring(orgSlug)
  const kpis = useKpis(orgSlug)
  const containers = monitoring?.containers ?? []
  const runtimeSummary = React.useMemo(
    () => summarizeRuntimeResources(containers),
    [containers]
  )
  const appsWithRuntimeStatus = React.useMemo(
    () =>
      apps.map((app) => ({
        ...app,
        runtimeStatus: resolveRuntimeAppStatus(
          app.status,
          selectAppSnapshot(containers, app.id, app.containerId)
        ),
      })),
    [apps, containers]
  )
  const appIds = React.useMemo(
    () => (appsLoading ? undefined : apps.map((app) => app.id)),
    [apps, appsLoading]
  )

  const runningApps = appsWithRuntimeStatus.filter(
    (app) => app.runtimeStatus === "running"
  ).length
  const failedApps = appsWithRuntimeStatus.filter(
    (app) => app.runtimeStatus === "failed"
  ).length
  // Decide only once both sources answered: an undecided panel would flash in
  // during the skeleton pass and push every card down when it disappears.
  const showOnboarding =
    !appsLoading &&
    !appConfigLoading &&
    (apps.length === 0 || !appConfig?.configured)
  const isAdmin = me?.is_instance_admin === true
  const comparisonHint = (delta: number | null): string =>
    delta === null
      ? t("dashboard.kpi.noBaseline")
      : t("dashboard.kpi.vsPrevious")

  React.useEffect(() => {
    if (create) setModalOpen(true)
  }, [create])

  const closeCreateModal = React.useCallback(() => {
    setModalOpen(false)
    if (create) {
      void router.navigate({ href: window.location.pathname, replace: true })
    }
  }, [create, router])

  const openBuild = React.useCallback(
    (buildId: string, appId: string) => {
      void router.navigate({
        href: `${organizationPath(orgSlug, "deployments")}?buildId=${encodeURIComponent(buildId)}&logAppId=${encodeURIComponent(appId)}`,
      })
    },
    [orgSlug, router]
  )

  const servicesCard = (
    <StatCard
      icon={<RiPlayCircleLine className="size-4" />}
      label={t("dashboard.services")}
      value={String(runtimeSummary.running)}
      hint={
        monitoring?.error
          ? t("dashboard.agentOffline")
          : runtimeSummary.total > 0
            ? runtimeSummary.issues > 0
              ? t("dashboard.runtimeHintIssues", {
                  apps: runtimeSummary.apps,
                  databases: runtimeSummary.databases,
                  issues: runtimeSummary.issues,
                })
              : t("dashboard.runtimeHint", {
                  apps: runtimeSummary.apps,
                  databases: runtimeSummary.databases,
                })
            : t("dashboard.noRuntimeResources")
      }
      loading={monitoringLoading || Boolean(organization && !monitoring)}
      tone={
        monitoring?.error
          ? "warning"
          : runtimeSummary.issues > 0
            ? "danger"
            : "default"
      }
    />
  )

  const githubCard = (
    <Link
      to="/settings/git-providers/$slug"
      params={{ slug: "github" }}
      aria-label={t("dashboard.openGitHubSettings")}
      className="group block rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <StatCard
        icon={<RiGithubFill className="size-4" />}
        label={t("dashboard.githubApp")}
        value={
          appConfig?.configured
            ? t("dashboard.connected")
            : t("dashboard.notConfigured")
        }
        hint={
          appConfig?.configured
            ? (appConfig.name ?? t("dashboard.installed"))
            : t("dashboard.installToDeploy")
        }
        loading={appConfigLoading}
        tone={appConfig?.configured ? "success" : "warning"}
      />
    </Link>
  )

  return (
    <ShellPage
      title={t("dashboard.title")}
      description={
        appsLoading
          ? t("dashboard.loadingWorkspace")
          : `${t("dashboard.appsCount", { count: apps.length, running: runningApps })}${failedApps > 0 ? t("dashboard.failedSuffix", { count: failedApps }) : ""}`
      }
      actions={
        <Button onClick={() => setModalOpen(true)}>
          <RiAddLine className="size-4" />
          {t("dashboard.newApplication")}
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={<RiAppsLine />}
          label={t("dashboard.applications")}
          value={String(apps.length)}
          hint={t("dashboard.runningHint", { count: runningApps })}
          loading={appsLoading}
        />
        <KpiCard
          icon={<RiRocketLine />}
          label={t("dashboard.kpi.deployments")}
          value={String(kpis.deploys)}
          delta={kpis.deploysDelta}
          hint={comparisonHint(kpis.deploysDelta)}
          loading={kpis.loading}
        />
        <KpiCard
          icon={<RiCheckboxCircleLine />}
          label={t("dashboard.kpi.successRate")}
          value={kpis.rate === null ? "–" : `${Math.round(kpis.rate)}%`}
          delta={kpis.rateDelta}
          hint={
            kpis.rate === null
              ? t("dashboard.kpi.noBuilds")
              : comparisonHint(kpis.rateDelta)
          }
          loading={kpis.loading}
        />
        <KpiCard
          icon={<RiTimerLine />}
          label={t("dashboard.kpi.medianBuild")}
          value={formatKpiDuration(kpis.median)}
          delta={kpis.medianDelta}
          inverse
          hint={
            kpis.median === null
              ? t("dashboard.kpi.noBuilds")
              : comparisonHint(kpis.medianDelta)
          }
          loading={kpis.loading}
        />
      </div>

      {appsError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {t("dashboard.loadAppsFailed", { message: appsError.message })}
        </div>
      ) : null}

      {showOnboarding ? (
        <GettingStartedPanel
          githubConnected={appConfig?.configured ?? false}
          onCreateApp={() => setModalOpen(true)}
        />
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <DeploymentActivityCard orgSlug={orgSlug} />
        <AppsShowcaseCard
          apps={appsWithRuntimeStatus}
          orgSlug={orgSlug}
          loading={appsLoading}
        />
      </div>

      {isAdmin ? (
        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <HostResourcesCard />
          <div className="grid gap-4">
            {githubCard}
            {servicesCard}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {githubCard}
          {servicesCard}
        </div>
      )}

      <RecentDeploymentsCard
        orgSlug={orgSlug}
        appIds={appIds}
        onOpenBuild={openBuild}
      />

      <CreateAppModal
        open={modalOpen}
        initialSource={create}
        organizationId={organization?.id}
        onClose={closeCreateModal}
        onCreated={
          create && organization
            ? async (appId) => {
                await router.navigate({
                  href: organizationPath(
                    organization.slug,
                    `apps/${appId}/deployments`
                  ),
                })
              }
            : undefined
        }
      />
    </ShellPage>
  )
}

type StatTone = "default" | "success" | "warning" | "danger"

function StatCard({
  icon,
  label,
  value,
  hint,
  loading = false,
  tone = "default",
}: {
  icon: React.ReactNode
  label: string
  value: string
  hint: string
  loading?: boolean
  tone?: StatTone
}): React.JSX.Element {
  const badgeVariant =
    tone === "success"
      ? "success"
      : tone === "warning"
        ? "warning"
        : tone === "danger"
          ? "destructive"
          : null

  return (
    <div className="flex h-full min-h-[132px] flex-col items-start justify-between gap-3 rounded-2xl bg-panel p-4 transition-colors group-hover:bg-accent/40">
      <span className="flex items-center rounded-md bg-panel-inset p-1.5 text-foreground dark:bg-neutral-800 [&_svg]:size-5">
        {icon}
      </span>
      <div className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        {loading ? (
          <div className="flex flex-col gap-0.5" aria-hidden="true">
            <div className="my-[3px] h-7 w-16 skeleton-surface rounded" />
            <div className="my-[3px] h-3 w-28 skeleton-surface rounded" />
          </div>
        ) : (
          <>
            <p className="truncate text-2xl leading-[34px] font-medium text-foreground">
              {value}
            </p>
            {badgeVariant ? (
              <Badge variant={badgeVariant} className="max-w-full truncate">
                {hint}
              </Badge>
            ) : (
              <p className="truncate text-[13px] leading-[18px] font-medium text-muted-foreground">
                {hint}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
