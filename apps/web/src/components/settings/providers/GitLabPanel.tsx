// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  RiCheckboxCircleFill,
  RiGitlabFill,
  RiLink,
  RiLoopRightLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import {
  gitLabOAuthErrorMessage,
  gitlabConnectUrl,
  useDeleteGitLabConfig,
  useDisconnectGitLab,
  useGitLabCacheStatus,
  useGitLabConfig,
  useSaveGitLabConfig,
  useSyncGitLabInstallations,
} from "../../../lib/gitlab"
import { useMe } from "../../../lib/auth"
import { useGitProviderStatus } from "../../../lib/git-providers"
import { CachedReposPanel } from "./CachedReposPanel"
import { GitLabConfigForm, GitLabSetupHelp } from "./GitLabConfigForm"
import { SyncProgressDialog } from "./SyncProgressDialog"
import { useTranslation } from "react-i18next"
import { useSyncWithProgress } from "./useSyncWithProgress"

export function GitLabPanel(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: me } = useMe()
  const providerStatus = useGitProviderStatus()
  const { data: config, isLoading } = useGitLabConfig()
  const save = useSaveGitLabConfig()
  const del = useDeleteGitLabConfig()
  const disconnect = useDisconnectGitLab()

  const justConnected =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("connected") === "1"
  const oauthError =
    typeof window !== "undefined"
      ? gitLabOAuthErrorMessage(window.location.search)
      : null

  const configured = Boolean(
    providerStatus.data?.gitlab.configured ?? config?.configured
  )
  const connected = Boolean(providerStatus.data?.gitlab.connected)
  const connectionState = providerStatus.data?.gitlab.state
  const isAdmin = me?.is_instance_admin === true

  return (
    <div className="space-y-6">
      {justConnected ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          <RiCheckboxCircleFill className="size-4" />
          <span>
            {t("gitlab.connectedBanner")}
          </span>
        </div>
      ) : null}

      {oauthError ? (
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          {oauthError}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-2xl rounded-xl bg-panel p-5 text-xs text-muted-foreground">
          {t("common:loading")}
        </div>
      ) : configured ? (
        <ConfiguredState
          config={config!}
          onReset={() => del.mutate()}
          onDisconnect={() => disconnect.mutate()}
          resetPending={del.isPending}
          disconnectPending={disconnect.isPending}
          connected={connected}
          connectionState={connectionState}
          isAdmin={isAdmin}
        />
      ) : isAdmin ? (
        <GitLabConfigForm
          onSave={async (values) => {
            await save.mutateAsync(values)
          }}
          pending={save.isPending}
        />
      ) : (
        <section className="rounded-2xl bg-panel p-5 text-sm text-muted-foreground">
          {t("gitlab.needsAdminLong")}
        </section>
      )}

      {isAdmin ? <GitLabSetupHelp callbackUrl={config?.callback_url} /> : null}

      {connected ? <GitLabCacheSection autoRefresh={justConnected} /> : null}
    </div>
  )
}

function GitLabCacheSection({
  autoRefresh,
}: {
  autoRefresh: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const sync = useSyncGitLabInstallations()
  const cache = useGitLabCacheStatus({ autoRefresh })
  const entries = cache.data?.installation ? [cache.data.installation] : []
  const progress = useSyncWithProgress()

  React.useEffect(() => {
    if (progress.status === "done") void cache.refetch()
  }, [progress.status, cache])

  async function startSync(): Promise<void> {
    try {
      const res = await sync.mutateAsync()
      progress.begin(res.syncId)
    } catch (err) {
      progress.fail(err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  return (
    <>
      <CachedReposPanel
        title={t("gitlab.cachedTitle")}
        description={t("gitlab.cachedHint")}
        entries={entries}
        isLoading={cache.isLoading}
        isError={cache.isError}
        errorMessage={cache.error?.message}
        isSyncing={sync.isPending || progress.status === "running"}
        syncingScope={progress.status === "running" ? "all" : undefined}
        onSyncOne={() => startSync()}
        onSyncAll={() => startSync()}
        emptyState={
          <p className="text-sm text-muted-foreground">
            {t("gitlab.cachedEmpty")}
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
        providerLabel="GitLab"
      />
    </>
  )
}

function ConfiguredState({
  config,
  onReset,
  onDisconnect,
  resetPending,
  disconnectPending,
  connected,
  connectionState,
  isAdmin,
}: {
  config: { instance_url?: string; client_id?: string }
  onReset: () => void
  onDisconnect: () => void
  resetPending: boolean
  disconnectPending: boolean
  connected: boolean
  connectionState:
    | "not_configured"
    | "disconnected"
    | "expired"
    | "unavailable"
    | "connected"
    | undefined
  isAdmin: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <section className="space-y-4 rounded-2xl rounded-xl bg-panel p-5">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md border border-border bg-background">
          <RiGitlabFill className="size-5 text-[#fc6d26]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-heading text-base font-medium">
              {t("gitlab.configured")}
            </h2>
            <span
              className={cn(
                "inline-flex items-center gap-1 font-sans text-[10px] tracking-wide uppercase",
                connectionState === "unavailable"
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-emerald-600 dark:text-emerald-400"
              )}
            >
              <RiCheckboxCircleFill className="size-3" />
              {connected
                ? t("gitlab.connected")
                : connectionState === "unavailable"
                  ? t("gitlab.unavailableShort")
                  : connectionState === "expired"
                    ? t("gitlab.expiredShort")
                    : t("gitlab.configuredShort")}
            </span>
          </div>
          <p className="truncate font-mono text-[10px] tracking-wide text-muted-foreground">
            {config.instance_url}
          </p>
        </div>
      </header>

      {connectionState === "unavailable" ? (
        <p
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
          role="alert"
        >
          {t("gitlab.unavailableBanner")}
        </p>
      ) : null}

      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
            {t("gitlab.applicationId")}
          </dt>
          <dd className="mt-0.5 font-mono text-xs">
            {config.client_id ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
            {t("gitlab.instance")}
          </dt>
          <dd className="mt-0.5 truncate font-mono text-xs">
            {config.instance_url ?? "—"}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <a href={gitlabConnectUrl()}>
            <RiLink className="size-3.5" />
            {t("gitlab.connectAccount")}
          </a>
        </Button>
        {connected ? (
          <Button
            variant="outline"
            onClick={onDisconnect}
            loading={disconnectPending}
          >
            {!disconnectPending && <RiLoopRightLine className="size-3.5" />}
            {disconnectPending
              ? t("gitlab.disconnecting")
              : t("gitlab.revokeTokens")}
          </Button>
        ) : null}
        {isAdmin ? (
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onReset}
            loading={resetPending}
          >
            {resetPending ? t("gitlab.deleting") : t("gitlab.deleteConfig")}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
