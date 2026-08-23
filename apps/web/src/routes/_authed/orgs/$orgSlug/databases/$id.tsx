// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { ShellPage } from "../../../../../components/layout/AppShell"
import {
  useDatabase,
  useStartDatabase,
  useStopDatabase,
  useUpdateDatabaseNetwork,
} from "../../../../../lib/databases"
import { LogViewer } from "../../../../../components/apps/BuildLogViewer"
import { RevealConnectionDialog } from "../../../../../components/databases/RevealConnectionDialog"
import { RestartDatabaseDialog } from "../../../../../components/databases/RestartDatabaseDialog"
import { RotationPanel } from "../../../../../components/databases/RotationPanel"
import { BackupConfigPanel } from "../../../../../components/databases/BackupConfigPanel"
import { BackupsList } from "../../../../../components/databases/BackupsList"
import { DeleteDatabaseDialog } from "../../../../../components/databases/DeleteDatabaseDialog"
import { DatabaseStatusBadge } from "../../../../../components/databases/DatabaseStatusBadge"
import { OpenAdminerDialog } from "../../../../../components/databases/OpenAdminerDialog"
import { ResourceCard } from "../../../../../components/monitoring/ResourceCard"
import { useBackupNow } from "../../../../../lib/backups"
import {
  useMonitoring,
  useMonitoringEvents,
} from "../../../../../lib/monitoring"
import {
  organizationPath,
  useCurrentOrganizationSlug,
} from "../../../../../lib/organizations"
import type { ContainerSnapshot } from "@ploydok/shared"
import type { DbExposureMode } from "../../../../../lib/databases"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/databases/$id")({
  component: DatabaseDetailPage,
})

const MONITORING_RING_SIZE = 60

function appendMonitoringRing(
  values: Array<number>,
  nextValue: number
): Array<number> {
  const next = [...values, nextValue]
  return next.length > MONITORING_RING_SIZE
    ? next.slice(next.length - MONITORING_RING_SIZE)
    : next
}

function findDatabaseSnapshot(
  containers: Array<ContainerSnapshot>,
  dbId: string
): ContainerSnapshot | null {
  return (
    containers.find(
      (container) => container.kind === "database" && container.app_id === dbId
    ) ??
    containers.find((container) => container.app_id === dbId) ??
    null
  )
}

function exposureLabel(
  mode: DbExposureMode,
  t: (key: string) => string
): string {
  if (mode === "direct_port") return t("exposure.directPort")
  if (mode === "public_proxy") return t("exposure.publicProxy")
  return t("exposure.internal")
}

function DatabaseMonitoringPanel({
  dbId,
}: {
  dbId: string
}): React.JSX.Element {
  const { t, i18n } = useTranslation("databases")
  const { data, isLoading, error, isFetching, refetch } = useMonitoring()
  const [snapshot, setSnapshot] = React.useState<ContainerSnapshot | null>(null)
  const [cpuHistory, setCpuHistory] = React.useState<Array<number>>([])
  const [memHistory, setMemHistory] = React.useState<Array<number>>([])

  const overviewSnapshot = React.useMemo(
    () => findDatabaseSnapshot(data?.containers ?? [], dbId),
    [data?.containers, dbId]
  )

  useMonitoringEvents(
    React.useCallback(
      (nextSnapshot) => {
        if (nextSnapshot.kind !== "database" || nextSnapshot.app_id !== dbId) {
          return
        }
        setSnapshot(nextSnapshot)
        setCpuHistory((current) =>
          appendMonitoringRing(current, nextSnapshot.cpu_pct)
        )
        setMemHistory((current) =>
          appendMonitoringRing(current, nextSnapshot.mem_bytes)
        )
      },
      [dbId]
    )
  )

  React.useEffect(() => {
    setSnapshot(null)
    setCpuHistory([])
    setMemHistory([])
  }, [dbId])

  React.useEffect(() => {
    if (!overviewSnapshot) return
    setSnapshot((current) => {
      if (
        current?.id === overviewSnapshot.id &&
        current.last_seen_ms === overviewSnapshot.last_seen_ms
      ) {
        return current
      }
      return overviewSnapshot
    })
    setCpuHistory((current) =>
      current.at(-1) === overviewSnapshot.cpu_pct
        ? current
        : appendMonitoringRing(current, overviewSnapshot.cpu_pct)
    )
    setMemHistory((current) =>
      current.at(-1) === overviewSnapshot.mem_bytes
        ? current
        : appendMonitoringRing(current, overviewSnapshot.mem_bytes)
    )
  }, [overviewSnapshot])

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("detail.monitoringUnavailableTitle")}</AlertTitle>
        <AlertDescription>
          {t("detail.monitoringLoadFailed", { message: error.message })}
        </AlertDescription>
      </Alert>
    )
  }

  if (!snapshot) {
    return (
      <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        {isLoading
          ? t("detail.monitoringLoading")
          : t("detail.monitoringEmpty")}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {t("detail.liveSnapshot", {
            time: new Date(snapshot.last_seen_ms).toLocaleTimeString(
              i18n.language
            ),
          })}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={isFetching}
          onClick={() => void refetch()}
        >
          {isFetching ? t("detail.refreshing") : t("common:refresh")}
        </Button>
      </div>
      <ResourceCard
        snapshot={snapshot}
        cpuHistory={cpuHistory}
        memHistory={memHistory}
      />
    </div>
  )
}

function DatabaseDetailPage(): React.JSX.Element {
  const { t, i18n } = useTranslation("databases")
  const { id: routeDbId } = useParams({ strict: false })
  const dbId = routeDbId!
  const navigate = useNavigate()
  const currentOrgSlug = useCurrentOrganizationSlug()
  const { data: db, isLoading, error, refetch } = useDatabase(dbId)
  const [revealOpen, setRevealOpen] = React.useState(false)
  const [adminerOpen, setAdminerOpen] = React.useState(false)
  const [restartOpen, setRestartOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [publicEnabled, setPublicEnabled] = React.useState(false)
  const [exposureMode, setExposureMode] = React.useState<
    "internal" | "direct_port" | "public_proxy"
  >("internal")
  const { mutate: startDb, isPending: isStarting } = useStartDatabase()
  const { mutate: stopDb, isPending: isStopping } = useStopDatabase()
  const { mutate: backupNow, isPending: isBackingUp } = useBackupNow(dbId)
  const { mutate: updateNetwork, isPending: isUpdatingNetwork } =
    useUpdateDatabaseNetwork()

  React.useEffect(() => {
    if (db) {
      setPublicEnabled(db.public_enabled)
      setExposureMode(db.exposure_mode)
    }
  }, [db])

  if (isLoading) {
    return (
      <ShellPage title={t("detail.title")}>
        <div className="text-muted-foreground">{t("common:loading")}</div>
      </ShellPage>
    )
  }

  if (error || !db) {
    return (
      <ShellPage title={t("detail.title")}>
        <div className="text-destructive">{t("detail.notFound")}</div>
      </ShellPage>
    )
  }

  const isExternal = db.management_mode === "external"
  const adminerSupported =
    !isExternal &&
    (db.kind === "postgres" || db.kind === "mysql" || db.kind === "mariadb")
  const canOpenAdminer = adminerSupported && db.status === "running"
  const planLabel = t(`plans.${db.plan}`, { defaultValue: db.plan })

  return (
    <ShellPage
      title={db.name}
      description={
        isExternal
          ? t("detail.externalKind", { kind: db.kind })
          : t("detail.managedKind", {
              kind: db.kind,
              version: db.version,
              plan: planLabel,
            })
      }
      actions={
        <div className="flex items-center gap-2">
          <DatabaseStatusBadge status={db.status} health={db.health_status} />
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
            {t("common:delete")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="rounded-lg border p-4">
            <div className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <span className="text-muted-foreground">
                  {t("detail.internalHost")}
                </span>
                <div className="font-mono">{db.internal_host ?? "—"}</div>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("detail.internalPort")}
                </span>
                <div className="font-mono">{db.internal_port ?? "—"}</div>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("detail.exposureMode")}
                </span>
                <div>{exposureLabel(db.exposure_mode, t)}</div>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("detail.created")}
                </span>
                <div>
                  {new Date(db.created_at).toLocaleDateString(i18n.language)}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("detail.publicEndpoint")}
                </span>
                <div className="font-mono">
                  {db.public_url ?? t("detail.disabled")}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("detail.lastStart")}
                </span>
                <div>
                  {db.last_started_at
                    ? new Date(db.last_started_at).toLocaleString(i18n.language)
                    : "—"}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border p-4">
            {isExternal ? (
              <>
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {t("detail.externalTitle")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("detail.externalHint")}
                  </span>
                </div>
                <div className="rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
                  {db.internal_host ?? "—"}:{db.internal_port ?? "—"}
                </div>
                <Button variant="outline" onClick={() => setRevealOpen(true)}>
                  {t("detail.revealConnection")}
                </Button>
                {adminerSupported && (
                  <Button
                    variant="outline"
                    onClick={() => setAdminerOpen(true)}
                    disabled={!canOpenAdminer}
                  >
                    {t("adminer.title")}
                  </Button>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">
                      {t("detail.directPublicPort")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t("detail.directPublicHint")}
                    </span>
                  </div>
                  <Switch
                    checked={publicEnabled}
                    onCheckedChange={(next) => {
                      setPublicEnabled(next)
                      setExposureMode(
                        next
                          ? db.exposure_mode === "internal"
                            ? "direct_port"
                            : db.exposure_mode
                          : "internal"
                      )
                    }}
                    disabled={isUpdatingNetwork}
                  />
                </div>
                {publicEnabled && (
                  <Select
                    value={exposureMode}
                    onValueChange={(value) =>
                      setExposureMode(
                        value as "internal" | "direct_port" | "public_proxy"
                      )
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="direct_port">
                        {t("exposure.directPort")}
                      </SelectItem>
                      <SelectItem value="public_proxy">
                        {t("exposure.publicProxy")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {publicEnabled && (
                  <Alert variant="destructive">
                    <AlertTitle>{t("detail.publicWarningTitle")}</AlertTitle>
                    <AlertDescription>
                      {t("detail.publicWarningBody")}
                    </AlertDescription>
                  </Alert>
                )}
                <Button
                  variant={publicEnabled ? "destructive" : "outline"}
                  onClick={() =>
                    updateNetwork({
                      id: dbId,
                      exposureMode: publicEnabled ? exposureMode : "internal",
                      publicEnabled,
                    })
                  }
                  loading={isUpdatingNetwork}
                >
                  {isUpdatingNetwork
                    ? t("detail.updatingNetwork")
                    : publicEnabled
                      ? t("detail.exposePublic")
                      : t("detail.applyNetwork")}
                </Button>
                <div className="grid grid-cols-3 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => startDb(dbId)}
                    disabled={db.status === "running"}
                    loading={isStarting}
                  >
                    {isStarting ? t("detail.starting") : t("detail.start")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => stopDb(dbId)}
                    disabled={db.status === "stopped"}
                    loading={isStopping}
                  >
                    {isStopping ? t("detail.stopping") : t("detail.stop")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setRestartOpen(true)}
                  >
                    {t("detail.restart")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        <Tabs defaultValue="general" className="flex flex-col gap-4">
          <TabsList>
            <TabsTrigger value="general">{t("detail.general")}</TabsTrigger>
            <TabsTrigger value="connection">
              {t("detail.connection")}
            </TabsTrigger>
            <TabsTrigger value="monitoring">
              {t("detail.monitoring")}
            </TabsTrigger>
            <TabsTrigger value="backups">{t("detail.backups")}</TabsTrigger>
            <TabsTrigger value="logs">{t("detail.logs")}</TabsTrigger>
            <TabsTrigger value="advanced">{t("detail.advanced")}</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="flex flex-col gap-4">
            {db.linked_apps && db.linked_apps.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border p-4">
                <h2 className="text-sm font-semibold">
                  {t("detail.linkedApps")}
                </h2>
                {db.linked_apps.map((link) => {
                  const appHref = currentOrgSlug
                    ? organizationPath(currentOrgSlug, `apps/${link.app_id}`)
                    : `/apps/${link.app_id}`
                  return (
                    <div
                      key={link.app_id + link.env_prefix}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Badge variant="secondary">{link.env_prefix}</Badge>
                      {link.app_name ? (
                        <a
                          href={appHref}
                          className="font-medium text-foreground hover:underline"
                        >
                          {link.app_name}
                        </a>
                      ) : (
                        <span className="font-medium text-foreground">
                          {t("detail.unknownApp")}
                        </span>
                      )}
                      <span className="font-mono text-xs text-muted-foreground">
                        {link.app_id}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}

            {isExternal ? (
              <Alert>
                <AlertTitle>{t("detail.externalAlertTitle")}</AlertTitle>
                <AlertDescription>
                  {t("detail.externalAlertBody")}
                </AlertDescription>
              </Alert>
            ) : (
              <RotationPanel db={db} onScheduleChange={() => void refetch()} />
            )}
          </TabsContent>

          <TabsContent value="connection" className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border p-4">
              <div>
                <span className="text-sm text-muted-foreground">
                  {t("detail.internalEndpoint")}
                </span>
                <div className="font-mono text-sm">
                  {db.connections?.internal.host ?? db.internal_host}:
                  {db.connections?.internal.port ?? db.internal_port}
                </div>
              </div>
              <div>
                <span className="text-sm text-muted-foreground">
                  {t("detail.publicEndpoint")}
                </span>
                <div className="font-mono text-sm">
                  {db.connections?.public?.url ??
                    db.public_url ??
                    t("detail.disabled")}
                </div>
              </div>
              <Button variant="outline" onClick={() => setRevealOpen(true)}>
                {t("detail.revealConnection")}
              </Button>
              {adminerSupported ? (
                <Button
                  variant="outline"
                  onClick={() => setAdminerOpen(true)}
                  disabled={!canOpenAdminer}
                >
                  {t("adminer.title")}
                </Button>
              ) : (
                <div className="text-xs text-muted-foreground">
                  {t("detail.adminerUnavailable")}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="monitoring" className="flex flex-col gap-4">
            {isExternal ? (
              <Alert>
                <AlertTitle>
                  {t("detail.monitoringUnavailableTitle")}
                </AlertTitle>
                <AlertDescription>
                  {t("detail.monitoringUnavailableBody")}
                </AlertDescription>
              </Alert>
            ) : (
              <DatabaseMonitoringPanel dbId={dbId} />
            )}
          </TabsContent>

          <TabsContent value="backups" className="flex flex-col gap-4">
            {isExternal ? (
              <Alert>
                <AlertTitle>{t("detail.backupsExternalTitle")}</AlertTitle>
                <AlertDescription>
                  {t("detail.backupsExternalBody")}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
                <div className="rounded-lg border p-4">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold">
                        {t("detail.backupsTitle")}
                      </h2>
                      <p className="text-xs text-muted-foreground">
                        {t("detail.backupsHint")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      onClick={() => backupNow()}
                      loading={isBackingUp}
                    >
                      {isBackingUp
                        ? t("detail.backupStarting")
                        : t("detail.backupNow")}
                    </Button>
                  </div>
                  <BackupsList
                    target={{ kind: "database", databaseId: dbId }}
                    restoreLabel={db.name}
                    onBackupNow={() => backupNow()}
                    backupNowLoading={isBackingUp}
                  />
                </div>

                <div className="rounded-lg border p-4">
                  <div className="mb-4">
                    <h2 className="text-sm font-semibold">
                      {t("detail.policyTitle")}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {t("detail.policyHint")}
                    </p>
                  </div>
                  <BackupConfigPanel
                    target={{ kind: "database", databaseId: dbId }}
                  />
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="logs">
            {isExternal ? (
              <p className="text-sm text-muted-foreground">
                {t("detail.externalLogs")}
              </p>
            ) : (
              <LogViewer
                source={{ kind: "database", resourceId: dbId }}
                resourceName={db.name}
                className="h-[min(70vh,560px)] min-h-[280px]"
              />
            )}
          </TabsContent>

          <TabsContent value="advanced">
            <div className="flex flex-col gap-3 rounded-lg border p-4 text-sm">
              <div>
                <span className="text-muted-foreground">
                  {t("detail.version")}
                </span>
                <div>{db.version}</div>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("detail.rotation")}
                </span>
                <div>{db.rotation_schedule}</div>
              </div>
              <div>
                <span className="text-muted-foreground">
                  {t("detail.container")}
                </span>
                <div className="font-mono">
                  {isExternal ? t("detail.externalContainer") : db.id}
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <RevealConnectionDialog
        databaseId={revealOpen ? dbId : null}
        onClose={() => setRevealOpen(false)}
      />
      <OpenAdminerDialog
        database={adminerOpen ? db : null}
        onClose={() => setAdminerOpen(false)}
      />
      <RestartDatabaseDialog
        database={restartOpen ? db : null}
        open={restartOpen}
        onOpenChange={setRestartOpen}
      />
      <DeleteDatabaseDialog
        database={deleteOpen ? db : null}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => {
          void navigate({
            to: currentOrgSlug
              ? organizationPath(currentOrgSlug, "databases")
              : "/databases",
          })
        }}
      />
    </ShellPage>
  )
}
