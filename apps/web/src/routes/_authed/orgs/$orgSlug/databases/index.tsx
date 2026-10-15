// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  RiAddLine,
  RiAlarmWarningLine,
  RiDatabase2Line,
  RiGlobalLine,
  RiRefreshLine,
  RiSearchLine,
  RiShieldCheckLine,
} from "@remixicon/react"
import { createPageHead } from "../../../../../lib/page-metadata"
import {
  ShellPage,
  ShellPanel,
} from "../../../../../components/layout/AppShell"
import { CreateDatabaseDialog } from "../../../../../components/databases/CreateDatabaseDialog"
import { DatabaseCard } from "../../../../../components/databases/DatabaseCard"
import {
  filterDatabases,
  summarizeDatabases,
} from "../../../../../lib/database-list"
import { useDatabases } from "../../../../../lib/databases"
import { useCurrentOrganization } from "../../../../../lib/organizations"
import type {
  DatabaseKindFilter,
  DatabaseProtectionFilter,
  DatabaseStatusFilter,
} from "../../../../../lib/database-list"
import type { Database } from "../../../../../lib/databases"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/databases/")({
  head: createPageHead("databases"),
  component: DatabasesPage,
})

const DEFAULT_FILTERS = {
  query: "",
  kind: "all" as DatabaseKindFilter,
  status: "all" as DatabaseStatusFilter,
  protection: "all" as DatabaseProtectionFilter,
}

function DatabasesPage(): React.JSX.Element {
  const { t, i18n } = useTranslation("databases")
  const [createOpen, setCreateOpen] = React.useState(false)
  const [query, setQuery] = React.useState(DEFAULT_FILTERS.query)
  const [kind, setKind] = React.useState<DatabaseKindFilter>(
    DEFAULT_FILTERS.kind
  )
  const [status, setStatus] = React.useState<DatabaseStatusFilter>(
    DEFAULT_FILTERS.status
  )
  const [protection, setProtection] = React.useState<DatabaseProtectionFilter>(
    DEFAULT_FILTERS.protection
  )
  const organization = useCurrentOrganization()
  const organizationId = organization?.id ?? ""

  const {
    data: databases = [],
    isLoading,
    isFetching,
    error,
    refetch,
    dataUpdatedAt,
  } = useDatabases(organization?.id)

  const summary = React.useMemo(
    () => summarizeDatabases(databases),
    [databases]
  )
  const visibleDatabases = React.useMemo(
    () => filterDatabases(databases, { query, kind, status, protection }),
    [databases, kind, protection, query, status]
  )
  const unscheduledCount = summary.managed - summary.scheduled
  function clearFilters(): void {
    setQuery(DEFAULT_FILTERS.query)
    setKind(DEFAULT_FILTERS.kind)
    setStatus(DEFAULT_FILTERS.status)
    setProtection(DEFAULT_FILTERS.protection)
  }

  return (
    <ShellPage
      title={t("title")}
      description={t("list.description")}
      eyebrow={organization?.name ?? t("common:nav.workspace")}
      actions={
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          disabled={!organizationId}
        >
          <RiAddLine className="size-4" />
          {t("list.newDatabase")}
        </Button>
      }
    >
      {!isLoading && !error && databases.length > 0 ? (
        <OperationalRail
          total={summary.total}
          healthy={summary.healthy}
          attention={summary.attention}
          publicCount={summary.public}
          scheduledCount={summary.scheduled}
          managed={summary.managed}
        />
      ) : null}

      {!isLoading &&
      !error &&
      databases.length > 0 &&
      (summary.attention > 0 || summary.public > 0 || unscheduledCount > 0) ? (
        <div
          className="flex flex-col gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <div className="flex min-w-0 items-start gap-3">
            <RiAlarmWarningLine className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {t("list.operationalReview")}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {[
                  summary.runtimeAttention > 0
                    ? t("list.runtimeIssues", {
                        count: summary.runtimeAttention,
                      })
                    : null,
                  summary.backupFailed > 0
                    ? t("list.failedBackups", { count: summary.backupFailed })
                    : null,
                  summary.public > 0
                    ? t("list.publicCount", { count: summary.public })
                    : null,
                  unscheduledCount > 0
                    ? t("list.withoutScheduled", { count: unscheduledCount })
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setQuery("")
              setKind("all")
              setStatus("all")
              setProtection("review")
            }}
          >
            {t("list.reviewAffected")}
          </Button>
        </div>
      ) : null}

      <ShellPanel
        title={t("list.fleetTitle")}
        description={t("list.fleetDescription")}
        action={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label={t("list.refreshAria")}
          >
            <RiRefreshLine
              className={isFetching ? "size-4 animate-spin" : "size-4"}
            />
            {t("common:refresh")}
          </Button>
        }
      >
        {databases.length > 0 ? (
          <DatabaseFilters
            query={query}
            kind={kind}
            status={status}
            protection={protection}
            resultCount={visibleDatabases.length}
            totalCount={databases.length}
            updatedAt={dataUpdatedAt}
            locale={i18n.language}
            onQueryChange={setQuery}
            onKindChange={setKind}
            onStatusChange={setStatus}
            onProtectionChange={setProtection}
          />
        ) : null}

        {isLoading ? (
          <DatabasesGridSkeleton />
        ) : error ? (
          <LoadError message={error.message} onRetry={() => void refetch()} />
        ) : databases.length === 0 ? (
          <EmptyState
            onCreate={() => setCreateOpen(true)}
            disabled={!organizationId}
          />
        ) : visibleDatabases.length === 0 ? (
          <FilteredEmptyState onClear={clearFilters} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleDatabases.map((database: Database) => (
              <DatabaseCard key={database.id} database={database} />
            ))}
          </div>
        )}
      </ShellPanel>

      {organizationId ? (
        <CreateDatabaseDialog
          open={createOpen}
          organizationId={organizationId}
          onClose={() => setCreateOpen(false)}
        />
      ) : null}
    </ShellPage>
  )
}

function OperationalRail({
  total,
  healthy,
  attention,
  publicCount,
  scheduledCount,
  managed,
}: {
  total: number
  healthy: number
  attention: number
  publicCount: number
  scheduledCount: number
  managed: number
}): React.JSX.Element {
  const { t } = useTranslation("databases")
  const cells = [
    {
      id: "fleet",
      label: t("list.railFleet"),
      value: String(total),
      icon: RiDatabase2Line,
      tone: "text-foreground",
    },
    {
      id: "healthy",
      label: t("list.railHealthy"),
      value: String(healthy),
      icon: RiShieldCheckLine,
      tone: "text-emerald-600 dark:text-emerald-400",
    },
    {
      id: "attention",
      label: t("list.railAttention"),
      value: String(attention),
      icon: RiAlarmWarningLine,
      tone:
        attention > 0
          ? "text-amber-600 dark:text-amber-400"
          : "text-muted-foreground",
    },
    {
      id: "public",
      label: t("list.railPublic"),
      value: String(publicCount),
      icon: RiGlobalLine,
      tone: publicCount > 0 ? "text-destructive" : "text-muted-foreground",
    },
    {
      id: "scheduled",
      label: t("list.railScheduled"),
      value: managed > 0 ? `${scheduledCount}/${managed}` : "—",
      icon: RiShieldCheckLine,
      tone:
        scheduledCount === managed
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-amber-600 dark:text-amber-400",
    },
  ]

  return (
    <section
      aria-label={t("list.summaryAria")}
      className="grid overflow-hidden rounded-2xl bg-panel sm:grid-cols-5"
    >
      {cells.map((cell, index) => {
        const Icon = cell.icon
        return (
          <div
            key={cell.id}
            className={[
              "flex items-center justify-between gap-3 px-4 py-3 sm:block",
              index > 0
                ? "border-t border-border sm:border-t-0 sm:border-l"
                : "",
            ].join(" ")}
          >
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Icon className={`size-3.5 ${cell.tone}`} />
              {cell.label}
            </div>
            <p
              className={`font-mono text-lg font-semibold tabular-nums sm:mt-2 ${cell.tone}`}
            >
              {cell.value}
            </p>
          </div>
        )
      })}
    </section>
  )
}

function DatabaseFilters({
  query,
  kind,
  status,
  protection,
  resultCount,
  totalCount,
  updatedAt,
  locale,
  onQueryChange,
  onKindChange,
  onStatusChange,
  onProtectionChange,
}: {
  query: string
  kind: DatabaseKindFilter
  status: DatabaseStatusFilter
  protection: DatabaseProtectionFilter
  resultCount: number
  totalCount: number
  updatedAt: number
  locale: string
  onQueryChange: (value: string) => void
  onKindChange: (value: DatabaseKindFilter) => void
  onStatusChange: (value: DatabaseStatusFilter) => void
  onProtectionChange: (value: DatabaseProtectionFilter) => void
}): React.JSX.Element {
  const { t } = useTranslation("databases")
  return (
    <div className="mb-4 space-y-3 border-b border-border pb-4">
      <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_180px_180px_190px]">
        <label className="relative block">
          <span className="sr-only">{t("list.searchAria")}</span>
          <RiSearchLine className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("list.searchPlaceholder")}
            className="pl-8"
          />
        </label>
        <Select
          value={kind}
          onValueChange={(value) => onKindChange(value as DatabaseKindFilter)}
        >
          <SelectTrigger aria-label={t("list.filterEngineAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("list.allEngines")}</SelectItem>
            <SelectItem value="postgres">PostgreSQL</SelectItem>
            <SelectItem value="mysql">MySQL</SelectItem>
            <SelectItem value="mariadb">MariaDB</SelectItem>
            <SelectItem value="redis">Redis</SelectItem>
            <SelectItem value="mongo">MongoDB</SelectItem>
            <SelectItem value="libsql">SQLite / libSQL</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={status}
          onValueChange={(value) =>
            onStatusChange(value as DatabaseStatusFilter)
          }
        >
          <SelectTrigger aria-label={t("list.filterStatusAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("list.allStatuses")}</SelectItem>
            <SelectItem value="attention">{t("list.attention")}</SelectItem>
            <SelectItem value="running">{t("status.running")}</SelectItem>
            <SelectItem value="creating">{t("status.creating")}</SelectItem>
            <SelectItem value="starting">{t("status.starting")}</SelectItem>
            <SelectItem value="stopped">{t("status.stopped")}</SelectItem>
            <SelectItem value="degraded">{t("status.degraded")}</SelectItem>
            <SelectItem value="failed">{t("status.failed")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={protection}
          onValueChange={(value) =>
            onProtectionChange(value as DatabaseProtectionFilter)
          }
        >
          <SelectTrigger aria-label={t("list.filterProtectionAria")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("list.allExposure")}</SelectItem>
            <SelectItem value="review">{t("list.needsReview")}</SelectItem>
            <SelectItem value="protected">
              {t("list.lastBackupSucceeded")}
            </SelectItem>
            <SelectItem value="unprotected">
              {t("list.noScheduledBackup")}
            </SelectItem>
            <SelectItem value="public">{t("list.publiclyExposed")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {resultCount === totalCount
            ? t("list.count", { count: totalCount })
            : t("list.countFiltered", {
                shown: resultCount,
                total: totalCount,
              })}
        </span>
        <span>
          {updatedAt > 0
            ? t("list.updated", {
                time: new Date(updatedAt).toLocaleTimeString(locale, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })
            : t("list.waitingRefresh")}
        </span>
      </div>
    </div>
  )
}

function LoadError({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation("databases")
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4"
      role="alert"
    >
      <div>
        <p className="text-sm font-medium text-destructive">
          {t("list.loadFailed")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("list.tryAgain")}
      </Button>
    </div>
  )
}

function EmptyState({
  onCreate,
  disabled,
}: {
  onCreate: () => void
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation("databases")
  return (
    <div className="rounded-2xl border border-dashed border-panel-border bg-panel-inset px-6 py-12 text-center">
      <RiDatabase2Line className="mx-auto size-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-semibold text-foreground">
        {t("list.emptyTitle")}
      </p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {t("list.emptyBody")}
      </p>
      <Button className="mt-5" size="sm" onClick={onCreate} disabled={disabled}>
        {t("create.title")}
      </Button>
    </div>
  )
}

function FilteredEmptyState({
  onClear,
}: {
  onClear: () => void
}): React.JSX.Element {
  const { t } = useTranslation("databases")
  return (
    <div className="rounded-2xl border border-dashed border-panel-border bg-panel-inset px-6 py-10 text-center">
      <RiSearchLine className="mx-auto size-5 text-muted-foreground" />
      <p className="mt-3 text-sm font-semibold text-foreground">
        {t("list.filteredTitle")}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("list.filteredBody")}
      </p>
      <Button className="mt-4" size="sm" variant="outline" onClick={onClear}>
        {t("list.clearFilters")}
      </Button>
    </div>
  )
}

function DatabasesGridSkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="rounded-[10px] bg-panel-inset p-4 shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]"
        >
          <div className="h-4 w-32 skeleton-surface rounded" />
          <div className="mt-2 h-3 w-44 skeleton-surface rounded" />
          <div className="mt-6 h-3 w-20 skeleton-surface rounded" />
          <div className="mt-2 h-3 w-28 skeleton-surface rounded" />
        </div>
      ))}
    </div>
  )
}
