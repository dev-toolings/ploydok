// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { cn } from "@workspace/ui/lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import {
  useCreateGitHubAppFlow,
  useForgetLocalGitHubApp,
  useGitHubAppConfig,
  useGitHubAppCredentialsStatus,
  useGitHubCacheStatus,
  useInstallations,
  useRemoveGitHubInstallation,
  useResetGitHubApp,
  useSyncGitHubInstallations,
} from "../../../lib/github"
import { useMe } from "../../../lib/auth"
import { useGitProviderStatus } from "../../../lib/git-providers"
import { apiBaseUrl } from "../../../lib/api/base"
import { CachedReposPanel } from "./CachedReposPanel"
import { GitHubAppSetupCard, GitHubIcon } from "./GitHubAppSetupCard"
import { SyncProgressDialog } from "./SyncProgressDialog"
import { useSyncWithProgress } from "./useSyncWithProgress"
import type {
  AppInstallation,
  GitHubAppCredentialsStatus,
} from "../../../lib/github"

type CredentialsStatus = GitHubAppCredentialsStatus["status"] | undefined

const responsiveDialogActionClassName =
  "h-auto min-h-11 min-w-0 w-full max-w-full whitespace-normal py-2 text-center sm:w-auto"

const recoveryDialogActionClassName =
  "h-auto min-h-11 min-w-0 w-full max-w-full whitespace-normal py-2 text-center"

const INSTALL_ERROR_KEYS = [
  "admin_required",
  "state_mismatch",
  "missing_installation_id",
  "sync_failed",
  "github_app_required",
] as const

type InstallErrorKey = (typeof INSTALL_ERROR_KEYS)[number]

function isInstallErrorKey(value: string): value is InstallErrorKey {
  return (INSTALL_ERROR_KEYS as ReadonlyArray<string>).includes(value)
}

export function shouldOpenGitHubCredentialsDialog(
  status: CredentialsStatus,
  dismissed: boolean
): boolean {
  return status === "unreadable" && !dismissed
}

export function canLoadGitHubInstallations(
  configured: boolean,
  status: CredentialsStatus
): boolean {
  return configured && status === "readable"
}

export function GitHubCredentialsRecovery({
  unreadable,
}: {
  unreadable: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation("settings")
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [dialogDismissed, setDialogDismissed] = React.useState(false)
  const [forgetDialogOpen, setForgetDialogOpen] = React.useState(false)
  const forgetLocalApp = useForgetLocalGitHubApp()
  const reconnectApp = useCreateGitHubAppFlow("/settings/git-providers/github")

  React.useEffect(() => {
    if (
      shouldOpenGitHubCredentialsDialog(
        unreadable ? "unreadable" : "readable",
        dialogDismissed
      )
    ) {
      setDialogOpen(true)
    }
    if (!unreadable) {
      setDialogOpen(false)
      setDialogDismissed(false)
      setForgetDialogOpen(false)
    }
  }, [dialogDismissed, unreadable])

  const handleForgetLocalApp = async (): Promise<void> => {
    try {
      await forgetLocalApp.mutateAsync()
      setForgetDialogOpen(false)
    } catch {
      // The mutation exposes its structured ApiError in the confirmation.
    }
  }

  if (!unreadable) return null

  return (
    <>
      <div
        className="space-y-3 rounded-2xl border border-destructive/30 bg-destructive/5 p-4"
        role="alert"
      >
        <div>
          <p className="text-sm font-medium text-destructive">
            {t("github.credentialsUnreadable")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("github.credentialsUnreadableHint")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            loading={reconnectApp.isPending}
            onClick={() => void reconnectApp.start()}
          >
            {t("github.reconnectApp")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={reconnectApp.isPending}
            onClick={() => {
              forgetLocalApp.reset()
              setForgetDialogOpen(true)
            }}
          >
            {t("github.resetLocal")}
          </Button>
        </div>
        {reconnectApp.error && (
          <p className="text-sm text-destructive" role="alert">
            {reconnectApp.error}
          </p>
        )}
      </div>

      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (reconnectApp.isPending) return
          setDialogOpen(open)
          if (!open) setDialogDismissed(true)
        }}
      >
        <AlertDialogContent className="@container/github-recovery max-w-2xl sm:max-w-2xl">
          <AlertDialogHeader className="min-w-0 place-items-start text-left">
            <AlertDialogTitle>
              {t("github.credentialsNeedAttention")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("github.credentialsNeedAttentionHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {reconnectApp.error && (
            <p className="text-sm text-destructive" role="alert">
              {reconnectApp.error}
            </p>
          )}
          <AlertDialogFooter className="grid grid-cols-1 @min-[28rem]/github-recovery:grid-cols-2 @min-[38rem]/github-recovery:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
            <AlertDialogCancel
              disabled={reconnectApp.isPending}
              className={cn(
                recoveryDialogActionClassName,
                "col-start-1 row-start-3 @min-[28rem]/github-recovery:row-start-2 @min-[38rem]/github-recovery:row-start-1"
              )}
            >
              {t("github.later")}
            </AlertDialogCancel>
            <Button
              className={cn(
                recoveryDialogActionClassName,
                "row-start-2 @min-[28rem]/github-recovery:col-start-2 @min-[38rem]/github-recovery:row-start-1"
              )}
              variant="destructive"
              disabled={reconnectApp.isPending}
              onClick={() => {
                setDialogOpen(false)
                setDialogDismissed(true)
                forgetLocalApp.reset()
                setForgetDialogOpen(true)
              }}
            >
              {t("github.resetLocal")}
            </Button>
            <Button
              className={cn(
                recoveryDialogActionClassName,
                "col-start-1 row-start-1 @min-[28rem]/github-recovery:col-span-2 @min-[38rem]/github-recovery:col-span-1 @min-[38rem]/github-recovery:col-start-3"
              )}
              loading={reconnectApp.isPending}
              onClick={() => void reconnectApp.start()}
            >
              {t("github.reconnectApp")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={forgetDialogOpen}
        onOpenChange={(open) => {
          if (forgetLocalApp.isPending) return
          setForgetDialogOpen(open)
          if (!open) {
            setDialogDismissed(false)
            setDialogOpen(true)
          }
        }}
      >
        <AlertDialogContent className="max-w-lg sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("github.resetLocalConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("github.resetLocalHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {forgetLocalApp.error && (
            <p className="text-sm text-destructive" role="alert">
              {forgetLocalApp.error.message}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              className={responsiveDialogActionClassName}
              disabled={forgetLocalApp.isPending}
            >
              {t("common:cancel")}
            </AlertDialogCancel>
            <Button
              className={responsiveDialogActionClassName}
              variant="destructive"
              loading={forgetLocalApp.isPending}
              onClick={() => void handleForgetLocalApp()}
            >
              {forgetLocalApp.isPending
                ? t("github.resettingLocal")
                : t("github.resetLocal")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

export function GitHubPanel(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const appParam =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("app")
      : null

  const { data: me, isLoading: meLoading } = useMe()
  const providerStatus = useGitProviderStatus()
  const isAdmin = me?.is_instance_admin === true
  const { data: appConfig, isLoading: appLoading } = useGitHubAppConfig({
    enabled: isAdmin,
  })
  const credentialsStatus = useGitHubAppCredentialsStatus({
    enabled: isAdmin && appConfig?.configured === true,
  })
  const createApp = useCreateGitHubAppFlow("/settings/git-providers/github")
  const resetApp = useResetGitHubApp()
  const [resettingAppId, setResettingAppId] = React.useState<string | null>(
    null
  )
  const [resetError, setResetError] = React.useState<string | null>(null)
  const [appSuccess, setAppSuccess] = React.useState<boolean>(
    appParam === "created"
  )
  const credentialsUnreadable = credentialsStatus.data?.status === "unreadable"

  if (meLoading || providerStatus.isLoading) {
    return <GitHubStatusSkeleton />
  }

  if (!isAdmin) {
    const status = providerStatus.data?.github
    return (
      <div className="space-y-6">
        <GitHubUserConnection status={status} />
        {status?.configured && (
          <InstallationsCard
            role="member"
            installUrl={connectionHref(status.install_url)}
          />
        )}
      </div>
    )
  }

  const handleResetApp = async (appId: string): Promise<void> => {
    setResetError(null)
    setResettingAppId(appId)
    try {
      await resetApp.mutateAsync(appId)
      setAppSuccess(false)
    } catch (err) {
      setResetError(
        err instanceof Error ? err.message : t("github.resetFailed")
      )
    } finally {
      setResettingAppId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">{t("github.appTitle")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("github.appDescription")}
        </p>
      </div>

      <div className="space-y-4 rounded-2xl bg-panel p-6">
        {appSuccess && (
          <p
            className="text-sm text-green-600 dark:text-green-400"
            role="status"
          >
            {t("github.configuredSuccess")}
          </p>
        )}
        {appLoading ? (
          <GitHubStatusSkeleton />
        ) : appConfig?.configured ? (
          <div className="space-y-6">
            {(appConfig.apps ?? []).map((app) => (
              <GitHubAppConfiguredState
                key={app.id}
                name={app.name}
                slug={app.slug}
                ownerLogin={app.owner_login}
                isPending={resettingAppId === app.id}
                onReset={() => void handleResetApp(app.id)}
                error={null}
              />
            ))}
            {resetError && resettingAppId === null && (
              <p className="text-sm text-destructive" role="alert">
                {resetError}
              </p>
            )}
            <AddGitHubOrganizationApp
              isPending={createApp.isPending}
              onCreate={(organization) => void createApp.start(organization)}
              error={createApp.error}
            />
          </div>
        ) : (
          <GitHubAppSetupCard
            isPending={createApp.isPending}
            onCreate={() => void createApp.start()}
            onImported={() => setAppSuccess(true)}
            error={createApp.error}
          />
        )}
      </div>

      <GitHubCredentialsRecovery unreadable={credentialsUnreadable} />

      {appConfig?.configured && credentialsStatus.isError && (
        <p className="text-sm text-destructive" role="alert">
          {t("github.verifyCredentialsFailed", {
            message: credentialsStatus.error.message,
          })}
        </p>
      )}

      {canLoadGitHubInstallations(
        appConfig?.configured === true,
        credentialsStatus.data?.status
      ) && (
        <InstallationsCard
          role="admin"
          installUrl={connectionHref(appConfig?.install_url)}
        />
      )}
    </div>
  )
}

function connectionHref(value?: string | null): string | null {
  if (!value) return null
  if (/^https?:\/\//.test(value)) return value
  return `${apiBaseUrl().replace(/\/$/, "")}/${value.replace(/^\//, "")}`
}

function GitHubUserConnection({
  status,
}: {
  status?: {
    configured: boolean
    connected: boolean
    install_url?: string | null
  }
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <section className="rounded-2xl bg-panel p-6">
      <div className="flex items-start gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <GitHubIcon className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">
            {status?.connected
              ? t("github.connected")
              : t("github.connectAccount")}
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {status?.connected
              ? t("github.connectedHint")
              : status?.configured
                ? t("github.needsLink")
                : t("github.needsAdmin")}
          </p>
        </div>
      </div>
    </section>
  )
}

type InstallationRole = "admin" | "member"

export function InstallationsCard({
  role,
  installUrl: installUrlFallback,
}: {
  role: InstallationRole
  installUrl: string | null
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data, isLoading, isFetching, error, refetch } = useInstallations()
  const remove = useRemoveGitHubInstallation()
  const [pendingId, setPendingId] = React.useState<number | null>(null)
  const [revokeError, setRevokeError] = React.useState<string | null>(null)
  const [selectedInstallation, setSelectedInstallation] = React.useState<
    AppInstallation | undefined
  >(undefined)
  const [justInstalled, setJustInstalled] = React.useState<{
    id: string
    action: string
    syncId: string | null
  } | null>(null)
  const [installError, setInstallError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    const installationId = params.get("installation_id")
    const setupAction = params.get("setup_action")
    const installed = params.get("installed")
    const syncId = params.get("sync_id")
    const installErrorParam = params.get("install_error")

    if (installErrorParam) {
      const key = isInstallErrorKey(installErrorParam)
        ? installErrorParam
        : "generic"
      setInstallError(t(`github.installError.${key}`))
      setJustInstalled(null)
    } else if (installationId && setupAction && installed === "1") {
      setJustInstalled({ id: installationId, action: setupAction, syncId })
      setInstallError(null)
      void refetch()
    } else if (!installationId && !setupAction) {
      return
    }

    params.delete("installation_id")
    params.delete("setup_action")
    params.delete("installed")
    params.delete("sync_id")
    params.delete("install_error")
    params.delete("state")
    const next = params.toString()
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${next ? `?${next}` : ""}`
    )

    const timer = setTimeout(() => setJustInstalled(null), 6_000)
    return () => clearTimeout(timer)
  }, [refetch, t])

  const handleStartInstall = (url: string): void => {
    if (typeof window === "undefined") return
    window.location.href = url
  }

  const handleRemove = async (installation: AppInstallation): Promise<void> => {
    setRevokeError(null)
    setPendingId(installation.id)
    try {
      await remove.mutateAsync(installation.id)
      setSelectedInstallation(undefined)
    } catch (err) {
      setRevokeError(
        err instanceof Error
          ? err.message
          : role === "admin"
            ? t("github.revokeFailed")
            : t("github.disconnectFailed")
      )
    } finally {
      setPendingId(null)
    }
  }

  const installTargets = data?.installTargets ?? []
  const installUrl =
    installTargets[0]?.url ?? data?.installUrl ?? installUrlFallback ?? ""
  const hasInstallation =
    Boolean(justInstalled) || Boolean(data && data.installations.length > 0)

  return (
    <>
      <div
        className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
        data-testid="github-installations-header"
      >
        <div>
          <h2 className="text-base font-medium">
            {t("github.installations")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {role === "admin"
              ? t("github.installationsHintAdmin")
              : t("github.installationsHintMember")}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:shrink-0 sm:flex-row sm:flex-wrap sm:justify-end">
          {role === "admin" &&
            (installTargets.length > 1
              ? installTargets.map((target) => (
                  <Button
                    key={target.appId}
                    className="w-full sm:w-auto"
                    size="sm"
                    onClick={() => handleStartInstall(target.url)}
                  >
                    {t("github.installOn", {
                      owner: target.ownerLogin ?? target.name,
                    })}
                  </Button>
                ))
              : installUrl && (
                  <Button
                    className="w-full sm:w-auto"
                    size="sm"
                    onClick={() => handleStartInstall(installUrl)}
                  >
                    {installTargets[0]?.ownerLogin
                      ? t("github.installOn", {
                          owner: installTargets[0].ownerLogin,
                        })
                      : t("github.addAccount")}
                  </Button>
                ))}
          <Button
            className="w-full sm:w-auto"
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            loading={isFetching}
          >
            {isFetching ? t("github.refreshing") : t("common:refresh")}
          </Button>
        </div>
      </div>

      {justInstalled && (
        <p className="text-sm text-green-600 dark:text-green-400" role="status">
          {justInstalled.action === "update"
            ? t("github.installedUpdated", { id: justInstalled.id })
            : t("github.installedReceived", { id: justInstalled.id })}
        </p>
      )}
      {installError && (
        <p className="text-sm text-destructive" role="alert">
          {installError}
        </p>
      )}

      <div className="space-y-4 rounded-2xl bg-panel p-6">
        {isLoading ? (
          <GitHubStatusSkeleton />
        ) : error ? (
          <p className="text-sm text-destructive" role="alert">
            {t("github.loadInstallationsFailed", { message: error.message })}
          </p>
        ) : !data || data.installations.length === 0 ? (
          <InstallationsEmptyState />
        ) : (
          <ul className="divide-y divide-border">
            {data.installations.map((inst) => (
              <InstallationRow
                key={inst.id}
                installation={inst}
                isPending={pendingId === inst.id}
                role={role}
                onRemove={() => {
                  setRevokeError(null)
                  setSelectedInstallation(inst)
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {role === "admin" && hasInstallation && (
        <GitHubCacheSection
          autoSync={
            justInstalled?.syncId
              ? {
                  installationId: justInstalled.id,
                  syncId: justInstalled.syncId,
                }
              : null
          }
        />
      )}

      <AlertDialog
        open={selectedInstallation !== undefined}
        onOpenChange={(open) => {
          if (!open && pendingId === null) {
            setSelectedInstallation(undefined)
            setRevokeError(null)
          }
        }}
      >
        <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {role === "admin"
                ? t("github.revokeConfirm")
                : t("github.disconnectConfirm")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {role === "admin"
                ? t("github.revokeHint", {
                    login: selectedInstallation?.accountLogin,
                  })
                : t("github.disconnectHint", {
                    login: selectedInstallation?.accountLogin,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {revokeError && (
            <p className="text-sm text-destructive" role="alert">
              {revokeError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel
              className={responsiveDialogActionClassName}
              disabled={pendingId !== null}
            >
              {t("common:cancel")}
            </AlertDialogCancel>
            <Button
              className={responsiveDialogActionClassName}
              variant="destructive"
              loading={pendingId !== null}
              onClick={() => {
                if (selectedInstallation) {
                  void handleRemove(selectedInstallation)
                }
              }}
            >
              {pendingId !== null
                ? role === "admin"
                  ? t("github.revoking")
                  : t("github.disconnecting")
                : role === "admin"
                  ? t("github.revoke")
                  : t("github.disconnect")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function GitHubCacheSection({
  autoSync,
}: {
  autoSync: { installationId: string; syncId: string } | null
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const queryClient = useQueryClient()
  const sync = useSyncGitHubInstallations()
  const cache = useGitHubCacheStatus({})
  const progress = useSyncWithProgress()
  const [scope, setScope] = React.useState<"all" | string | undefined>(
    undefined
  )
  const autoSyncStartedRef = React.useRef<string | null>(null)
  const previousStatusRef = React.useRef(progress.status)

  React.useEffect(() => {
    const previousStatus = previousStatusRef.current
    previousStatusRef.current = progress.status

    if (progress.status === "done" && previousStatus !== "done") {
      void cache.refetch()
      void queryClient.invalidateQueries({ queryKey: ["github", "repos"] })
      setScope(undefined)
    }
    if (progress.status === "error" || progress.status === "idle") {
      setScope(undefined)
    }
  }, [progress.status, cache.refetch, queryClient])

  React.useEffect(() => {
    if (!autoSync || autoSyncStartedRef.current === autoSync.syncId) return
    autoSyncStartedRef.current = autoSync.syncId
    setScope(autoSync.installationId)
    progress.begin(autoSync.syncId)
  }, [autoSync, progress.begin])

  async function startSync(opts: { installationId?: string }): Promise<void> {
    setScope(opts.installationId ?? "all")
    try {
      const res = await sync.mutateAsync(opts)
      progress.begin(res.syncId)
    } catch (err) {
      setScope(undefined)
      progress.fail(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  return (
    <>
      <CachedReposPanel
        title={t("github.cachedTitle")}
        description={t("github.cachedHint")}
        entries={cache.data?.installations ?? []}
        isLoading={cache.isLoading}
        isError={cache.isError}
        errorMessage={cache.error?.message}
        isSyncing={sync.isPending || progress.status === "running"}
        syncingScope={progress.status === "running" ? scope : undefined}
        onSyncOne={(installationId) => startSync({ installationId })}
        onSyncAll={() => startSync({})}
        emptyState={
          <p className="text-sm text-muted-foreground">
            {t("github.cachedEmpty")}
          </p>
        }
      />
      <SyncProgressDialog
        open={progress.open}
        onClose={progress.close}
        status={progress.status}
        startedAt={progress.startedAt}
        importedCount={progress.importedCount}
        totalCount={progress.totalCount}
        errorMessage={progress.errorMessage}
        providerLabel={t("github.title")}
      />
    </>
  )
}

function InstallationRow({
  installation,
  isPending,
  role,
  onRemove,
}: {
  installation: AppInstallation
  isPending: boolean
  role: InstallationRole
  onRemove: () => void
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const count = installation.repositoryCount
  const countLabel =
    count === null
      ? t("github.unknownRepos")
      : installation.repositorySelection === "all"
        ? t("github.allRepositories")
        : t("github.repository", { count })

  return (
    <li className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      {installation.avatarUrl ? (
        <img
          src={installation.avatarUrl}
          alt={installation.accountLogin}
          className="size-10 rounded-full"
        />
      ) : (
        <div className="size-10 rounded-full bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          @{installation.accountLogin}
          <span className="ml-2 text-xs text-muted-foreground">
            {installation.accountType}
          </span>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {countLabel}
          {installation.suspendedAt && (
            <span className="ml-2 text-destructive">
              · {t("github.suspended")}
            </span>
          )}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRemove}
        loading={isPending}
      >
        {isPending
          ? role === "admin"
            ? t("github.revoking")
            : t("github.disconnecting")
          : role === "admin"
            ? t("github.revoke")
            : t("github.disconnect")}
      </Button>
    </li>
  )
}

function InstallationsEmptyState(): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">
        {t("github.emptyInstallations")}
      </p>
    </div>
  )
}

function GitHubStatusSkeleton(): React.JSX.Element {
  const { t } = useTranslation("common")
  return (
    <div
      className="flex items-center gap-4"
      aria-busy="true"
      aria-label={t("loading")}
    >
      <div className="size-10 skeleton-surface rounded-full" />
      <div className="space-y-2">
        <div className="h-4 w-32 skeleton-surface rounded" />
        <div className="h-3 w-48 skeleton-surface rounded" />
      </div>
    </div>
  )
}

// Same rule as GitHub logins: alphanumerics and single hyphens, 39 max.
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

function AddGitHubOrganizationApp({
  isPending,
  onCreate,
  error,
}: {
  isPending: boolean
  onCreate: (organization: string) => void
  error: string | null
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const [organization, setOrganization] = React.useState("")
  const trimmed = organization.trim()
  const valid = GITHUB_LOGIN_PATTERN.test(trimmed)

  return (
    <form
      className="space-y-3 border-t border-border pt-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (valid) onCreate(trimmed)
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("github.orgApp.title")}</p>
        <p className="text-xs text-muted-foreground">
          {t("github.orgApp.hint")}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="github-org-app-login">
            {t("github.orgApp.label")}
          </Label>
          <Input
            id="github-org-app-login"
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            placeholder={t("github.orgApp.placeholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" disabled={!valid} loading={isPending}>
          {isPending
            ? t("github.orgApp.redirecting")
            : t("github.orgApp.create")}
        </Button>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

interface GitHubAppConfiguredStateProps {
  name: string
  slug: string
  ownerLogin: string | null
  isPending: boolean
  onReset: () => void
  error: string | null
}

function GitHubAppConfiguredState({
  name,
  slug,
  ownerLogin,
  isPending,
  onReset,
  error,
}: GitHubAppConfiguredStateProps): React.JSX.Element {
  const { t } = useTranslation("settings")
  const [resetDialogOpen, setResetDialogOpen] = React.useState(false)

  const handleResetConfirm = (): void => {
    setResetDialogOpen(false)
    onReset()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <GitHubIcon className="size-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">
            <span className="font-semibold">{name}</span>{" "}
            <span className="text-xs text-muted-foreground">({slug})</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {ownerLogin
              ? t("github.ownedBy", { owner: ownerLogin })
              : t("github.registeredHint")}
          </p>
        </div>
        <div className="ml-auto">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-pos-100 dark:bg-[#192e03]/60 px-2.5 py-0.5 text-xs font-medium text-pos-700 dark:text-[#9ae600]">
            <span
              className="size-1.5 rounded-full bg-current"
              aria-hidden="true"
            />
            {t("github.configured")}
          </span>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setResetDialogOpen(true)}
          loading={isPending}
        >
          {isPending ? t("github.uninstalling") : t("github.resetApp")}
        </Button>
      </div>

      <AlertDialog
        open={resetDialogOpen}
        onOpenChange={(open) => {
          if (!isPending) setResetDialogOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("github.resetAppConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("github.resetAppHint", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              loading={isPending}
              onClick={handleResetConfirm}
            >
              {isPending ? t("github.uninstalling") : t("github.resetApp")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
