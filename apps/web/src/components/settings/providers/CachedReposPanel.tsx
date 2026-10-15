// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  RiCheckboxCircleFill,
  RiErrorWarningFill,
  RiRefreshLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { toast } from "sonner"
import i18n from "../../../lib/i18n"

// ---------------------------------------------------------------------------
// Types — minimal shape shared by the GitHub multi-installation view and the
// GitLab single-installation view. Each row maps 1:1 to a provider_installation
// in Postgres + a COUNT of provider_repos joined on it.
// ---------------------------------------------------------------------------

export interface CachedReposEntry {
  id: string
  accountLogin: string
  avatarUrl: string | null
  htmlUrl: string | null
  lastSyncedAt: string
  repoCount: number
  ageMs: number
  status: "fresh" | "stale"
}

export interface CachedReposPanelProps {
  title: string
  description: string
  entries: Array<CachedReposEntry>
  isLoading: boolean
  isError: boolean
  errorMessage?: string
  onSyncOne?: (id: string) => Promise<unknown>
  onSyncAll?: () => Promise<unknown>
  isSyncing: boolean
  /**
   * Scope of an in-flight sync: `"all"` highlights every row, an installation
   * id highlights only that one. Used to show "Syncing" instead of the
   * server-computed Fresh/Stale pill while the worker is writing.
   */
  syncingScope?: "all" | string
  emptyState: React.ReactNode
}

// ---------------------------------------------------------------------------

export function CachedReposPanel(
  props: CachedReposPanelProps
): React.JSX.Element {
  const { t } = useTranslation("settings")
  const {
    title,
    description,
    entries,
    isLoading,
    isError,
    errorMessage,
    onSyncOne,
    onSyncAll,
    isSyncing,
    syncingScope,
    emptyState,
  } = props

  const [pendingId, setPendingId] = React.useState<string | null>(null)

  async function handleOne(id: string): Promise<void> {
    if (!onSyncOne) return
    setPendingId(id)
    try {
      await onSyncOne(id)
      toast.success(t("cache.syncTriggered"))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t("cache.syncFailed", { message: msg }))
    } finally {
      setPendingId(null)
    }
  }

  async function handleAll(): Promise<void> {
    if (!onSyncAll) return
    try {
      await onSyncAll()
      toast.success(t("cache.syncAllTriggered"))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(t("cache.syncFailed", { message: msg }))
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {onSyncAll && entries.length > 1 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleAll()}
            loading={isSyncing}
          >
            {!isSyncing && <RiRefreshLine className="mr-1.5 size-3.5" />}
            {isSyncing ? t("cache.syncing") : t("cache.syncAll")}
          </Button>
        )}
      </div>

      <div className="rounded-2xl bg-panel">
        {isLoading ? (
          <div
            className="space-y-2 p-6"
            aria-busy="true"
            aria-label={t("cache.loading")}
          >
            <Skeleton className="h-10 w-full rounded-md" />
            <Skeleton className="h-10 w-full rounded-md" />
          </div>
        ) : isError ? (
          <p className="p-6 text-sm text-destructive" role="alert">
            {t("cache.loadFailed", {
              message: errorMessage ?? t("cache.unknownError"),
            })}
          </p>
        ) : entries.length === 0 ? (
          <div className="space-y-3 p-6">
            {emptyState}
            {onSyncAll && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleAll()}
                loading={isSyncing}
              >
                {!isSyncing && <RiRefreshLine className="mr-1.5 size-3.5" />}
                {isSyncing ? t("cache.syncing") : t("cache.syncNow")}
              </Button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <CacheRow
                key={e.id}
                entry={e}
                pending={pendingId === e.id}
                disabled={isSyncing}
                syncing={syncingScope === "all" || syncingScope === e.id}
                onSync={onSyncOne ? () => void handleOne(e.id) : undefined}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

function CacheRow({
  entry,
  pending,
  disabled,
  syncing,
  onSync,
}: {
  entry: CachedReposEntry
  pending: boolean
  disabled: boolean
  syncing: boolean
  onSync?: () => void
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {entry.avatarUrl ? (
        <img
          src={entry.avatarUrl}
          alt=""
          className="size-8 shrink-0 rounded-full border border-border"
          loading="lazy"
        />
      ) : (
        <div className="size-8 shrink-0 rounded-full border border-border bg-muted" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{entry.accountLogin}</p>
          <StatusPill status={syncing ? "syncing" : entry.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("cache.repoCount", {
            count: entry.repoCount,
            age: formatAge(entry.ageMs),
          })}
        </p>
      </div>

      {onSync && (
        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          loading={pending || syncing}
          disabled={disabled}
        >
          {!(pending || syncing) && (
            <RiRefreshLine className="mr-1.5 size-3.5" />
          )}
          {pending || syncing ? t("cache.syncing") : t("cache.sync")}
        </Button>
      )}
    </li>
  )
}

function StatusPill({
  status,
}: {
  status: "fresh" | "stale" | "syncing"
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  if (status === "syncing") {
    return (
      <span className="inline-flex items-center gap-1 font-sans text-xs text-blue-600 dark:text-blue-400">
        <RiRefreshLine className="size-3 animate-spin" />
        {t("cache.syncingShort")}
      </span>
    )
  }
  if (status === "fresh") {
    return (
      <span className="inline-flex items-center gap-1 font-sans text-xs text-emerald-600 dark:text-emerald-400">
        <RiCheckboxCircleFill className="size-3" />
        {t("cache.fresh")}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 font-sans text-xs text-amber-600 dark:text-amber-400">
      <RiErrorWarningFill className="size-3" />
      {t("cache.stale")}
    </span>
  )
}

// ---------------------------------------------------------------------------
// formatAge — human-friendly relative time. Avoids importing Intl.RelativeTime
// to keep this pure and SSR-safe.
// ---------------------------------------------------------------------------

function formatAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return i18n.t("settings:cache.ageSeconds", { count: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return i18n.t("settings:cache.ageMinutes", { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return i18n.t("settings:cache.ageHours", { count: hr })
  const day = Math.floor(hr / 24)
  return i18n.t("settings:cache.ageDays", { count: day })
}
