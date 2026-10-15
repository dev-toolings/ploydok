// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router"
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiRefreshLine,
  RiSearchLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import { BuildLogDrawer } from "../../../../components/apps/BuildLogDrawer"
import {
  
  
  DeploymentsTable
} from "../../../../components/apps/DeploymentsTable"
import { ShellPage } from "../../../../components/layout/AppShell"
import { useApps } from "../../../../lib/apps"
import { useCurrentOrganization } from "../../../../lib/organizations"
import {
  
  
  normalizeWorkspaceDeploymentFilters,
  useWorkspaceDeploymentActions,
  useWorkspaceDeployments
} from "../../../../lib/workspace-deployments"
import type {DeploymentApplication, DeploymentTableBuild} from "../../../../components/apps/DeploymentsTable";
import type {WorkspaceDeploymentFilters, WorkspaceDeploymentsSummary} from "../../../../lib/workspace-deployments";
import type { Build, BuildStatus } from "@ploydok/shared"

const ALL = "all"

interface DeploymentsSearch extends WorkspaceDeploymentFilters {
  buildId?: string
  logAppId?: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function validateDeploymentsSearch(
  search: Record<string, unknown>
): DeploymentsSearch {
  return {
    ...normalizeWorkspaceDeploymentFilters(search),
    buildId: optionalString(search["buildId"]),
    logAppId: optionalString(search["logAppId"]),
  }
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/deployments")({
  head: createPageHead("deployments"),
  validateSearch: validateDeploymentsSearch,
  component: DeploymentsPage,
})

function DeploymentsPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { orgSlug } = useParams({ from: Route.id })
  const search = useSearch({ from: Route.id })
  const navigate = useNavigate()
  const organization = useCurrentOrganization()
  const appsQuery = useApps(organization?.id)
  const organizationAppIds = React.useMemo(
    () => appsQuery.data?.map((app) => app.id),
    [appsQuery.data]
  )
  const deploymentFilters = React.useMemo(
    () => normalizeWorkspaceDeploymentFilters(search),
    [search]
  )
  const deploymentsQuery = useWorkspaceDeployments(
    orgSlug,
    deploymentFilters,
    organizationAppIds
  )
  const actions = useWorkspaceDeploymentActions(orgSlug)
  const deployments = deploymentsQuery.data?.deployments ?? []
  const pagination = deploymentsQuery.data?.pagination

  const selectedDeployment = React.useMemo(
    () => deployments.find((deployment) => deployment.id === search.buildId),
    [deployments, search.buildId]
  )
  const selectedAppId = selectedDeployment?.app.id ?? search.logAppId

  const updateSearch = React.useCallback(
    (
      changes: Partial<DeploymentsSearch>,
      options: { resetPage?: boolean } = {}
    ) => {
      const next = {
        ...search,
        ...changes,
        page:
          options.resetPage === false
            ? (changes.page ?? search.page)
            : (changes.page ?? 1),
      }
      void navigate({ to: ".", search: next })
    },
    [navigate, search]
  )

  const handleSelectBuild = React.useCallback(
    (buildId: string) => {
      const deployment = deployments.find((item) => item.id === buildId)
      updateSearch(
        {
          buildId,
          logAppId: deployment?.app.id,
        },
        { resetPage: false }
      )
    },
    [deployments, updateSearch]
  )

  const handleCloseDrawer = React.useCallback(() => {
    updateSearch(
      { buildId: undefined, logAppId: undefined },
      { resetPage: false }
    )
  }, [updateSearch])

  const handleRollback = React.useCallback(
    (build: Build) => {
      const deployment = build as DeploymentTableBuild
      if (!deployment.app) return
      actions.rollback.mutate({
        appId: deployment.app.id,
        buildId: deployment.id,
      })
    },
    [actions.rollback]
  )

  const handleCancel = React.useCallback(
    (build: Build) => {
      const deployment = build as DeploymentTableBuild
      if (!deployment.app) return
      actions.cancel.mutate({
        appId: deployment.app.id,
        buildId: deployment.id,
      })
    },
    [actions.cancel]
  )

  const appDeploymentsHref = React.useCallback(
    (app: DeploymentApplication) =>
      `/orgs/${encodeURIComponent(orgSlug)}/apps/${encodeURIComponent(app.id)}/deployments`,
    [orgSlug]
  )

  return (
    <ShellPage
      title={t("deployments.title")}
      description={t("deployments.description")}
      eyebrow={organization?.name ?? t("eyebrow")}
    >
      <DeploymentSummary summary={deploymentsQuery.data?.summary} />

      <section className="flex w-full flex-col rounded-2xl border border-[#ebebeb] pt-2 pb-3 dark:border-neutral-800">
        <div className="flex flex-col items-start gap-3 px-3 py-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-sm font-medium text-neutral-400 dark:text-neutral-500">
              {t("deployments.history")}
            </h2>
            <p className="text-sm font-medium text-foreground">
              {t("deployments.historyHint")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void deploymentsQuery.refetch()}
            loading={deploymentsQuery.isFetching}
          >
            <RiRefreshLine className="size-4" />
            {t("common:refresh")}
          </Button>
        </div>

        <div className="px-3 pt-2">
          <DeploymentFilters
            filters={search}
            apps={appsQuery.data ?? []}
            onChange={updateSearch}
          />
        </div>

        {deploymentsQuery.error ? (
          <div className="px-3 pt-3">
            <DeploymentError
              message={deploymentsQuery.error.message}
              onRetry={() => void deploymentsQuery.refetch()}
            />
          </div>
        ) : (
          <>
            <div className="mt-3">
              <DeploymentsTable
                builds={deployments}
                isLoading={deploymentsQuery.isLoading}
                onSelectBuild={handleSelectBuild}
                onRollback={handleRollback}
                onCancel={handleCancel}
                showApplication
                appDeploymentsHref={appDeploymentsHref}
                canManage={deploymentsQuery.data?.canManage ?? false}
                paginate={false}
                flush
              />
            </div>
            {pagination ? (
              <DeploymentPagination
                page={pagination.page}
                total={pagination.total}
                totalPages={pagination.totalPages}
                hasNext={pagination.hasNext}
                onPrevious={() =>
                  updateSearch(
                    { page: Math.max(1, pagination.page - 1) },
                    {
                      resetPage: false,
                    }
                  )
                }
                onNext={() =>
                  updateSearch(
                    { page: pagination.page + 1 },
                    { resetPage: false }
                  )
                }
              />
            ) : null}
          </>
        )}
      </section>

      {selectedAppId ? (
        <BuildLogDrawer
          appId={selectedAppId}
          buildId={search.buildId}
          build={selectedDeployment}
          appName={selectedDeployment?.app.name}
          onClose={handleCloseDrawer}
        />
      ) : null}
    </ShellPage>
  )
}

function DeploymentSummary({
  summary,
}: {
  summary: WorkspaceDeploymentsSummary | undefined
}): React.JSX.Element | null {
  const { t } = useTranslation("workspace")
  if (!summary) return null
  const cards = [
    { label: t("deployments.total"), value: summary.total },
    {
      label: t("deployments.inProgress"),
      value: summary.pending + summary.running,
    },
    {
      label: t("deployments.successful"),
      value: summary.succeeded + summary.succeededWithWarning,
    },
    { label: t("deployments.failed"), value: summary.failed },
  ]

  return (
    <section
      className="grid grid-cols-2 gap-4 lg:grid-cols-4"
      aria-label={t("deployments.summary")}
    >
      {cards.map((card) => (
        <div key={card.label} className="rounded-2xl bg-panel p-4">
          <p className="text-sm font-medium text-muted-foreground">
            {card.label}
          </p>
          <p className="text-2xl leading-[34px] font-medium text-foreground tabular-nums">
            {card.value}
          </p>
        </div>
      ))}
    </section>
  )
}

function DeploymentFilters({
  filters,
  apps,
  onChange,
}: {
  filters: DeploymentsSearch
  apps: Array<{ id: string; name: string }>
  onChange: (
    changes: Partial<DeploymentsSearch>,
    options?: { resetPage?: boolean }
  ) => void
}): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const dirty = Boolean(
    filters.appId ||
    filters.status ||
    filters.source ||
    filters.q ||
    filters.from ||
    filters.to
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Select
          value={filters.appId ?? ALL}
          onValueChange={(value) =>
            onChange({ appId: value === ALL ? undefined : value })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder={t("deployments.application")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("deployments.allApplications")}</SelectItem>
            {apps.map((app) => (
              <SelectItem key={app.id} value={app.id}>
                {app.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.status ?? ALL}
          onValueChange={(value) =>
            onChange({
              status: value === ALL ? undefined : (value as BuildStatus),
            })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder={t("deployments.status")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("deployments.allStatuses")}</SelectItem>
            <SelectItem value="pending">{t("deployments.pending")}</SelectItem>
            <SelectItem value="running">{t("deployments.running")}</SelectItem>
            <SelectItem value="succeeded">{t("deployments.succeeded")}</SelectItem>
            <SelectItem value="succeeded_with_warning">
              {t("deployments.succeededWarning")}
            </SelectItem>
            <SelectItem value="failed">{t("deployments.failed")}</SelectItem>
            <SelectItem value="cancelled">{t("deployments.cancelled")}</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.source ?? ALL}
          onValueChange={(value) =>
            onChange({ source: value === ALL ? undefined : value })
          }
        >
          <SelectTrigger>
            <SelectValue placeholder={t("deployments.source")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("deployments.allSources")}</SelectItem>
            <SelectItem value="api">{t("deployments.manual")}</SelectItem>
            <SelectItem value="webhook:github">{t("deployments.github")}</SelectItem>
            <SelectItem value="webhook:gitlab">{t("deployments.gitlab")}</SelectItem>
            <SelectItem value="auto:push">{t("deployments.autoPush")}</SelectItem>
            <SelectItem value="auto:tag">{t("deployments.autoTag")}</SelectItem>
            <SelectItem value="cron:gc">{t("deployments.cleanup")}</SelectItem>
            <SelectItem value="cron:cleanup">{t("deployments.scheduledCleanup")}</SelectItem>
            <SelectItem value="system">{t("deployments.system")}</SelectItem>
          </SelectContent>
        </Select>

        <div className="relative">
          <RiSearchLine className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q ?? ""}
            onChange={(event) =>
              onChange({ q: event.target.value || undefined })
            }
            className="pl-8"
            placeholder={t("deployments.searchPlaceholder")}
            aria-label={t("deployments.search")}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={filters.from ?? ""}
          onChange={(event) =>
            onChange({ from: event.target.value || undefined })
          }
          className="w-auto"
          aria-label={t("deployments.from")}
        />
        <span className="text-xs text-muted-foreground">
          {t("deployments.to")}
        </span>
        <Input
          type="date"
          value={filters.to ?? ""}
          onChange={(event) =>
            onChange({ to: event.target.value || undefined })
          }
          className="w-auto"
          aria-label={t("deployments.toDate")}
        />
        <Select
          value={String(filters.pageSize)}
          onValueChange={(value) => onChange({ pageSize: Number(value) })}
        >
          <SelectTrigger className="w-32">
            <SelectValue placeholder={t("deployments.perPage")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="20">
              {t("deployments.perPageCount", { count: 20 })}
            </SelectItem>
            <SelectItem value="50">
              {t("deployments.perPageCount", { count: 50 })}
            </SelectItem>
            <SelectItem value="100">
              {t("deployments.perPageCount", { count: 100 })}
            </SelectItem>
          </SelectContent>
        </Select>
        {dirty ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={() =>
              onChange({
                appId: undefined,
                status: undefined,
                source: undefined,
                q: undefined,
                from: undefined,
                to: undefined,
              })
            }
          >
            {t("deployments.clearFilters")}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function DeploymentPagination({
  page,
  total,
  totalPages,
  hasNext,
  onPrevious,
  onNext,
}: {
  page: number
  total: number
  totalPages: number
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
}): React.JSX.Element {
  const { t } = useTranslation("workspace")
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-3">
      <p className="text-[13px] font-medium text-muted-foreground">
        {t("deployments.count", {
          count: total,
          page,
          pages: Math.max(1, totalPages),
        })}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onPrevious}
          disabled={page <= 1}
        >
          <RiArrowLeftLine className="size-4" />
          {t("common:previous")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNext}
          disabled={!hasNext}
        >
          {t("common:next")}
          <RiArrowRightLine className="size-4" />
        </Button>
      </div>
    </div>
  )
}

function DeploymentError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation("workspace")
  return (
    <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-5">
      <p className="text-sm font-medium text-destructive">
        {t("deployments.loadFailed")}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        {t("common:retry")}
      </Button>
    </div>
  )
}
