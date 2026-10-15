// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import {
  RiAddLine,
  RiExternalLinkLine,
  RiLoader4Line,
  RiMore2Line,
  RiRefreshLine,
} from "@remixicon/react"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  useCreateGitHubAppFlow,
  useForgetLocalGitHubApp,
  useGitHubAppConfig,
  useGitHubAppCredentialsStatus,
  useGitHubCacheStatus,
  useGitHubOrganizationLookup,
  useInstallations,
  useRemoveGitHubInstallation,
  useResetGitHubApp,
  useSyncGitHubInstallations,
} from "../../../lib/github"
import { useMe } from "../../../lib/auth"
import { useGitProviderStatus } from "../../../lib/git-providers"
import { apiBaseUrl } from "../../../lib/api/base"
import { usePendingAction } from "../../../lib/hooks/use-pending-action"
import { CachedReposPanel, StatusPill, formatAge } from "./CachedReposPanel"
import { GitHubAppSetupCard, GitHubIcon } from "./GitHubAppSetupCard"
import { SyncProgressDialog } from "./SyncProgressDialog"
import { useSyncWithProgress } from "./useSyncWithProgress"
import type { CachedReposEntry } from "./CachedReposPanel"
import type {
  AppInstallation,
  GitHubAppCredentialsStatus,
  GitHubAppSummary,
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
  // Started together with the App config instead of after it: each query
  // in the chain used to paint its own skeleton.
  const credentialsStatus = useGitHubAppCredentialsStatus({
    enabled: isAdmin,
  })
  const installationsEnabled = isAdmin
    ? canLoadGitHubInstallations(
        appConfig?.configured === true,
        credentialsStatus.data?.status
      )
    : providerStatus.data?.github.configured === true
  const installations = useInstallations({ enabled: installationsEnabled })
  const cacheStatus = useGitHubCacheStatus({
    enabled: isAdmin && installationsEnabled,
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

  if (
    meLoading ||
    providerStatus.isLoading ||
    (isAdmin &&
      (appLoading || credentialsStatus.isLoading || cacheStatus.isLoading)) ||
    installations.isLoading
  ) {
    return <GitHubPanelSkeleton />
  }

  if (!isAdmin) {
    const status = providerStatus.data?.github
    return (
      <div className="space-y-6">
        <GitHubUserConnection status={status} />
        {status?.configured && <InstallationsCard role="member" />}
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
      {appSuccess && (
        <p className="text-sm text-green-600 dark:text-green-400" role="status">
          {t("github.configuredSuccess")}
        </p>
      )}

      {appConfig?.configured ? (
        <InstallationsCard
          role="admin"
          accounts={{
            apps: appConfig.apps ?? [],
            installationsEnabled,
            resettingAppId,
            resetError,
            onResetApp: (appId) => void handleResetApp(appId),
            organizationApp: {
              isPending: createApp.isPending,
              error: createApp.error,
              onCreate: (organization) => void createApp.start(organization),
            },
          }}
        />
      ) : (
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-medium">{t("github.appTitle")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("github.appDescription")}
            </p>
          </div>
          <div className="rounded-2xl bg-panel p-6">
            <GitHubAppSetupCard
              isPending={createApp.isPending}
              onCreate={() => void createApp.start()}
              onImported={() => setAppSuccess(true)}
              error={createApp.error}
            />
          </div>
        </section>
      )}

      <GitHubCredentialsRecovery unreadable={credentialsUnreadable} />

      {appConfig?.configured && credentialsStatus.isError && (
        <p className="text-sm text-destructive" role="alert">
          {t("github.verifyCredentialsFailed", {
            message: credentialsStatus.error.message,
          })}
        </p>
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

/** One GitHub owner: its App (admin view) and its installation, if any. */
export interface GitHubAccount {
  key: string
  app: GitHubAppSummary | null
  installation: AppInstallation | null
}

/**
 * Pairs each App with its installation. A private App is installable only on
 * its owner, so it has at most one; installations recorded before their App
 * was known are matched on the owner login, then listed on their own.
 */
export function buildGitHubAccounts(
  apps: ReadonlyArray<GitHubAppSummary>,
  installations: ReadonlyArray<AppInstallation>
): Array<GitHubAccount> {
  const used = new Set<number>()
  const accounts: Array<GitHubAccount> = apps.map((app) => {
    const installation =
      installations.find((inst) => inst.githubAppId === app.id) ??
      installations.find(
        (inst) =>
          !inst.githubAppId &&
          !!app.owner_login &&
          inst.accountLogin.toLowerCase() === app.owner_login.toLowerCase()
      ) ??
      null
    if (installation) used.add(installation.id)
    return { key: app.id, app, installation }
  })
  for (const installation of installations) {
    if (used.has(installation.id)) continue
    accounts.push({
      key: `installation-${installation.id}`,
      app: null,
      installation,
    })
  }
  return accounts
}

interface AdminAccountsProps {
  apps: ReadonlyArray<GitHubAppSummary>
  installationsEnabled: boolean
  resettingAppId: string | null
  resetError: string | null
  onResetApp: (appId: string) => void
  organizationApp: {
    isPending: boolean
    error: string | null
    onCreate: (organization: string) => void
  }
}

export function InstallationsCard({
  role,
  accounts,
}: {
  role: InstallationRole
  accounts?: AdminAccountsProps
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data, isLoading, error, refetch } = useInstallations({
    enabled: accounts?.installationsEnabled ?? true,
  })
  const [resetTarget, setResetTarget] = React.useState<
    GitHubAppSummary | undefined
  >(undefined)
  const [installingAppId, setInstallingAppId] = React.useState<string | null>(
    null
  )
  // Mount and focus refetches are automatic: only an explicit click spins.
  const [refreshing, setRefreshing] = React.useState(false)
  const install = usePendingAction(
    async (url: string): Promise<void> => {
      window.location.href = url
    },
    { keepPendingOnSuccess: true }
  )
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

  // The dialog closes at once; the row keeps a loader until the refreshed
  // list no longer shows the installation (the mutation awaits the refetch).
  const handleRemove = async (installation: AppInstallation): Promise<void> => {
    setRevokeError(null)
    setSelectedInstallation(undefined)
    setPendingId(installation.id)
    try {
      await remove.mutateAsync(installation.id)
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

  const handleInstall = (app: GitHubAppSummary): void => {
    const url = connectionHref(app.install_url)
    if (!url) return
    setInstallingAppId(app.id)
    void install.run(url).catch(() => undefined)
  }

  const hasInstallation =
    Boolean(justInstalled) || Boolean(data && data.installations.length > 0)
  const autoSync = React.useMemo(
    () =>
      justInstalled?.syncId
        ? { installationId: justInstalled.id, syncId: justInstalled.syncId }
        : null,
    [justInstalled]
  )
  // Admin accounts fold the repository cache into each account row.
  const cacheSync = useGitHubCacheSync(
    accounts ? autoSync : null,
    accounts?.installationsEnabled ?? false
  )
  const cacheEntries = cacheSync.cache.data?.installations ?? []
  const cacheEntryFor = (
    installation: AppInstallation | null
  ): CachedReposEntry | undefined =>
    installation
      ? cacheEntries.find(
          (entry) =>
            entry.id === `github:${installation.id}` ||
            entry.id === String(installation.id)
        )
      : undefined

  return (
    <>
      <div
        className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"
        data-testid="github-installations-header"
      >
        <div>
          <h2 className="text-base font-medium">
            {accounts ? t("github.accounts.title") : t("github.installations")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {accounts
              ? t("github.accounts.hint")
              : role === "admin"
                ? t("github.installationsHintAdmin")
                : t("github.installationsHintMember")}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:shrink-0 sm:flex-row sm:flex-wrap sm:justify-end">
          {accounts ? (
            hasInstallation && (
              <Button
                className="w-full sm:w-auto"
                variant="outline"
                size="sm"
                onClick={() =>
                  void cacheSync.startSync({}).catch(() => undefined)
                }
                loading={cacheSync.isSyncing && cacheSync.scope === "all"}
                disabled={cacheSync.isSyncing}
              >
                <RiRefreshLine aria-hidden="true" />
                {cacheSync.isSyncing && cacheSync.scope === "all"
                  ? t("cache.syncing")
                  : t("cache.syncAll")}
              </Button>
            )
          ) : (
            <Button
              className="w-full sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => {
                setRefreshing(true)
                void refetch().finally(() => setRefreshing(false))
              }}
              loading={refreshing}
            >
              {refreshing ? t("github.refreshing") : t("common:refresh")}
            </Button>
          )}
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

      {accounts ? (
        <div className="space-y-4 rounded-2xl bg-panel p-6">
          {accounts.installationsEnabled && isLoading ? (
            <GitHubStatusSkeleton />
          ) : (
            <ul className="divide-y divide-border">
              {buildGitHubAccounts(
                accounts.apps,
                data?.installations ?? []
              ).map((account) => (
                <GitHubAccountRow
                  key={account.key}
                  account={account}
                  cacheEntry={cacheEntryFor(account.installation)}
                  syncing={
                    cacheSync.isSyncing &&
                    account.installation !== null &&
                    (cacheSync.scope === "all" ||
                      cacheSync.scope === String(account.installation.id) ||
                      cacheSync.scope === `github:${account.installation.id}`)
                  }
                  syncDisabled={cacheSync.isSyncing}
                  onSync={() => {
                    if (!account.installation) return
                    void cacheSync
                      .startSync({
                        installationId: String(account.installation.id),
                      })
                      .catch(() => undefined)
                  }}
                  installPending={
                    install.pending && installingAppId === account.app?.id
                  }
                  removing={
                    account.app !== null &&
                    accounts.resettingAppId === account.app.id
                      ? "remove"
                      : account.installation !== null &&
                          pendingId === account.installation.id
                        ? "revoke"
                        : null
                  }
                  onInstall={() => account.app && handleInstall(account.app)}
                  onRevoke={() => {
                    if (!account.installation) return
                    setRevokeError(null)
                    setSelectedInstallation(account.installation)
                  }}
                  onReset={() => account.app && setResetTarget(account.app)}
                />
              ))}
            </ul>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {t("github.loadInstallationsFailed", { message: error.message })}
            </p>
          )}
          {accounts.resetError && (
            <p className="text-sm text-destructive" role="alert">
              {accounts.resetError}
            </p>
          )}
          <AddGitHubOrganizationApp {...accounts.organizationApp} />
        </div>
      ) : (
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
      )}

      {accounts
        ? cacheSync.dialog
        : role === "admin" &&
          hasInstallation && <GitHubCacheSection autoSync={autoSync} />}

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

      <AlertDialog
        open={resetTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setResetTarget(undefined)
        }}
      >
        <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("github.resetAppConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("github.resetAppHint", { name: resetTarget?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={responsiveDialogActionClassName}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className={responsiveDialogActionClassName}
              variant="destructive"
              onClick={() => {
                if (resetTarget) accounts?.onResetApp(resetTarget.id)
                setResetTarget(undefined)
              }}
            >
              {t("github.resetApp")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function GitHubAccountRow({
  account,
  cacheEntry,
  syncing,
  syncDisabled,
  onSync,
  installPending,
  removing,
  onInstall,
  onRevoke,
  onReset,
}: {
  account: GitHubAccount
  cacheEntry: CachedReposEntry | undefined
  syncing: boolean
  syncDisabled: boolean
  onSync: () => void
  installPending: boolean
  removing: "revoke" | "remove" | null
  onInstall: () => void
  onRevoke: () => void
  onReset: () => void
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { app, installation } = account
  const login =
    installation?.accountLogin || app?.owner_login || app?.name || ""
  const type = installation?.accountType || app?.owner_type || null
  const count = installation?.repositoryCount ?? null
  const selection = !installation
    ? null
    : installation.repositorySelection === "all"
      ? t("github.allRepositories")
      : count === null
        ? t("github.accounts.selectedRepositories")
        : t("github.repository", { count })

  return (
    <li
      aria-busy={removing !== null}
      className={cn(
        "flex flex-col gap-3 py-4 transition-opacity first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4",
        removing && "pointer-events-none opacity-60"
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {installation?.avatarUrl ? (
          <img
            src={installation.avatarUrl}
            alt=""
            className="size-10 shrink-0 rounded-full"
          />
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
            <GitHubIcon className="size-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
            <span className="truncate">@{login}</span>
            {type && (
              <span className="text-xs font-normal text-muted-foreground">
                {type === "Organization"
                  ? t("github.accounts.organization")
                  : t("github.accounts.personal")}
              </span>
            )}
            {cacheEntry && (
              <StatusPill status={syncing ? "syncing" : cacheEntry.status} />
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {!installation ? (
              <span className="text-amber-700 dark:text-amber-400">
                {t("github.accounts.notInstalled")}
              </span>
            ) : cacheEntry ? (
              t("cache.repoCount", {
                count: cacheEntry.repoCount,
                age: formatAge(cacheEntry.ageMs),
              })
            ) : (
              selection
            )}
            {installation?.suspendedAt && (
              <span className="ml-1 text-destructive">
                · {t("github.suspended")}
              </span>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:shrink-0">
        {removing ? (
          <span
            role="status"
            className="inline-flex h-8 items-center gap-1.5 text-sm text-muted-foreground"
          >
            <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
            {removing === "revoke"
              ? t("github.revoking")
              : t("github.accounts.removing")}
          </span>
        ) : (
          <>
            {app && !installation && (
              <Button size="sm" loading={installPending} onClick={onInstall}>
                {t("github.accounts.install")}
              </Button>
            )}
            {installation && (
              <Button
                size="sm"
                variant="outline"
                loading={syncing}
                disabled={syncDisabled}
                onClick={onSync}
              >
                <RiRefreshLine aria-hidden="true" />
                {syncing ? t("cache.syncing") : t("cache.sync")}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("github.accounts.more", { login })}
                >
                  <RiMore2Line aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto">
                {installation?.htmlUrl && (
                  <DropdownMenuItem className="whitespace-nowrap" asChild>
                    <a
                      href={installation.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("github.accounts.manage")}
                      <RiExternalLinkLine aria-hidden="true" />
                    </a>
                  </DropdownMenuItem>
                )}
                {installation && (
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    onSelect={onRevoke}
                  >
                    {t("github.accounts.revokeInstallation")}
                  </DropdownMenuItem>
                )}
                {app && (
                  <DropdownMenuItem
                    className="whitespace-nowrap"
                    variant="destructive"
                    onSelect={onReset}
                  >
                    {t("github.accounts.deleteApp")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </li>
  )
}

/**
 * Repository cache status plus the sync flow (trigger, progress dialog,
 * per-installation scope). An `autoSync` started by the install callback is
 * followed once.
 */
function useGitHubCacheSync(
  autoSync: { installationId: string; syncId: string } | null,
  enabled: boolean
) {
  const { t } = useTranslation("settings")
  const queryClient = useQueryClient()
  const sync = useSyncGitHubInstallations()
  const cache = useGitHubCacheStatus({ enabled })
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
      void queryClient.invalidateQueries({
        queryKey: ["github", "installations"],
      })
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

  return {
    cache,
    scope,
    startSync,
    isSyncing: sync.isPending || progress.status === "running",
    dialog: (
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
    ),
  }
}

function GitHubCacheSection({
  autoSync,
}: {
  autoSync: { installationId: string; syncId: string } | null
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { cache, scope, startSync, isSyncing, dialog } = useGitHubCacheSync(
    autoSync,
    true
  )

  return (
    <>
      <CachedReposPanel
        title={t("github.cachedTitle")}
        description={t("github.cachedHint")}
        entries={cache.data?.installations ?? []}
        isLoading={cache.isLoading}
        isError={cache.isError}
        errorMessage={cache.error?.message}
        isSyncing={isSyncing}
        syncingScope={isSyncing ? scope : undefined}
        onSyncOne={(installationId) => startSync({ installationId })}
        onSyncAll={() => startSync({})}
        emptyState={
          <p className="text-sm text-muted-foreground">
            {t("github.cachedEmpty")}
          </p>
        }
      />
      {dialog}
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

/** Mirrors the loaded accounts section so the page paints one skeleton. */
function GitHubPanelSkeleton(): React.JSX.Element {
  const { t } = useTranslation("common")
  return (
    <div className="space-y-4" aria-busy="true" aria-label={t("loading")}>
      <div className="space-y-2">
        <div className="h-4 w-36 skeleton-surface rounded" />
        <div className="h-3 w-80 max-w-full skeleton-surface rounded" />
      </div>
      <div className="divide-y divide-border rounded-2xl bg-panel p-6">
        {[0, 1].map((row) => (
          <div
            key={row}
            className="flex items-center gap-4 py-4 first:pt-0 last:pb-0"
          >
            <div className="size-10 shrink-0 skeleton-surface rounded-full" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-32 skeleton-surface rounded" />
              <div className="h-3 w-48 max-w-full skeleton-surface rounded" />
            </div>
            <div className="hidden h-8 w-36 skeleton-surface rounded-md sm:block" />
          </div>
        ))}
      </div>
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
  const [open, setOpen] = React.useState(false)
  const [organization, setOrganization] = React.useState("")
  const [debounced, setDebounced] = React.useState("")
  const trimmed = organization.trim()
  const valid = GITHUB_LOGIN_PATTERN.test(trimmed)

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(valid ? trimmed : ""), 400)
    return () => clearTimeout(timer)
  }, [trimmed, valid])

  const lookup = useGitHubOrganizationLookup(debounced)
  const settled = debounced === trimmed && valid
  const found =
    settled && lookup.data && !lookup.data.hasApp ? lookup.data : null

  if (!open) {
    return (
      <div className="border-t border-border pt-4">
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <RiAddLine aria-hidden="true" />
          {t("github.orgApp.open")}
        </Button>
      </div>
    )
  }

  return (
    <form
      className="space-y-3 border-t border-border pt-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (found) onCreate(found.login)
      }}
    >
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("github.orgApp.title")}</p>
        <p className="text-xs text-muted-foreground">
          {t("github.orgApp.hint")}
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="github-org-app-login">{t("github.orgApp.label")}</Label>
        <Input
          id="github-org-app-login"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
          placeholder={t("github.orgApp.placeholder")}
          autoComplete="off"
          autoFocus
          spellCheck={false}
        />
      </div>
      <div className="min-h-10 text-sm" aria-live="polite">
        {trimmed && !valid ? (
          <p className="text-destructive">{t("github.orgApp.invalid")}</p>
        ) : !settled || lookup.isFetching ? (
          trimmed ? (
            <p className="text-muted-foreground">
              {t("github.orgApp.checking")}
            </p>
          ) : null
        ) : lookup.error ? (
          <p className="text-destructive">
            {lookup.error.status === 404
              ? t("github.orgApp.notFound", { login: trimmed })
              : t("github.orgApp.lookupFailed")}
          </p>
        ) : lookup.data?.hasApp ? (
          <p className="text-muted-foreground">
            {t("github.orgApp.alreadyConnected", { login: lookup.data.login })}
          </p>
        ) : found ? (
          <div className="flex items-center gap-3">
            {found.avatarUrl ? (
              <img
                src={found.avatarUrl}
                alt=""
                className="size-10 rounded-full"
              />
            ) : null}
            <div className="min-w-0">
              <p className="truncate font-medium">
                {found.name ?? found.login}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                @{found.login}
              </p>
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            setOrganization("")
          }}
        >
          {t("common:cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={!found} loading={isPending}>
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
