// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  RiDeleteBin6Line,
  RiEraserLine,
  RiHardDriveLine,
  RiLoader4Line,
  RiRefreshLine,
} from "@remixicon/react"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { cn } from "@workspace/ui/lib/utils"
import {
  getDiskJob,
  getDiskJobs,
  getDiskUsage,
  cleanupDocker,
  pruneBuildCache,
  pruneImages,
} from "../../../lib/disk"
import { notifyMutationError } from "../../../lib/second-factor-toast"
import type { ApiError } from "../../../lib/api"
import type {
  DiskJobStatus,
  DiskUsageCategoryKind,
  DiskUsageResponse,
} from "@ploydok/shared"

export const Route = createFileRoute("/_authed/admin/disk")({
  component: AdminDiskPage,
})

const DISK_USAGE_QUERY_KEY = ["admin", "disk", "usage"] as const

const CATEGORY_KEYS: Record<
  DiskUsageCategoryKind,
  "adminDisk.images" | "adminDisk.containers" | "adminDisk.volumes" | "adminDisk.buildCache"
> = {
  images: "adminDisk.images",
  containers: "adminDisk.containers",
  volumes: "adminDisk.volumes",
  build_cache: "adminDisk.buildCache",
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function diskBarTone(pct: number): string {
  if (pct >= 90) return "bg-destructive"
  if (pct >= 75) return "bg-amber-500"
  return "bg-primary"
}

// Absolute rather than relative: nothing re-renders this panel on a timer, so
// an "N seconds ago" label would freeze at whatever it said on the last fetch.
function formatMeasuredAt(iso: string): string {
  return new Date(iso).toLocaleTimeString()
}

function AdminDiskPage(): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const qc = useQueryClient()
  const [activeJob, setActiveJob] = React.useState<{
    id: string
    label: string
  } | null>(null)
  const { data, isLoading, error } = useQuery<DiskUsageResponse, ApiError>({
    queryKey: DISK_USAGE_QUERY_KEY,
    queryFn: () => getDiskUsage(),
    // Matches the API-side cache window; a shorter one would just re-serve the
    // same cached breakdown. While the API reports `stale`, poll until the
    // background refresh lands.
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.stale ? 5_000 : false),
  })

  // Forced refresh — makes the API re-run `docker system df` instead of
  // answering from cache. Used by the Refresh button and after a prune, where
  // the cached numbers still describe the pre-prune host.
  const refreshMutation = useMutation({
    mutationFn: () => getDiskUsage(true),
    onSuccess: (fresh: DiskUsageResponse) =>
      qc.setQueryData(DISK_USAGE_QUERY_KEY, fresh),
    onError: (err: unknown) =>
      notifyMutationError(err, t("adminDisk.refreshFailed")),
  })

  // The API answers a forced refresh immediately with the previous numbers and
  // runs the walk behind it, so the button has to stay pending until `stale`
  // clears — releasing it on the request would flash and lie.
  const isRefreshing = refreshMutation.isPending || data?.stale === true

  const { data: job, error: jobError } = useQuery<DiskJobStatus, ApiError>({
    queryKey: ["admin", "disk", "job", activeJob?.id],
    queryFn: () => getDiskJob(activeJob!.id),
    enabled: activeJob !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === "pending" || status === "running" ? 1_000 : false
    },
  })
  const { data: history = [] } = useQuery<DiskJobStatus[], ApiError>({
    queryKey: ["admin", "disk", "jobs"],
    queryFn: getDiskJobs,
    refetchInterval: 10_000,
  })

  React.useEffect(() => {
    if (!activeJob) return
    if (jobError) {
      toast.error(
        jobError.message ||
          t("adminDisk.trackFailed", { label: activeJob.label })
      )
      setActiveJob(null)
      return
    }
    if (!job) return
    if (job.status === "succeeded") {
      const reclaimed =
        job.kind === "gc.images" &&
        job.result &&
        "spaceReclaimedBytes" in job.result
          ? t("adminDisk.reclaimed", {
              bytes: formatBytes(job.result.spaceReclaimedBytes),
            })
          : ""
      toast.success(
        `${t("adminDisk.complete", { label: activeJob.label })}${reclaimed}`
      )
      refreshMutation.mutate()
      setActiveJob(null)
    } else if (job.status === "failed" || job.status === "cancelled") {
      toast.error(
        job.errorMessage ?? t("adminDisk.failed", { label: activeJob.label })
      )
      setActiveJob(null)
    }
  }, [activeJob, job, jobError])

  const pruneImagesMutation = useMutation({
    mutationFn: pruneImages,
    onSuccess: ({ jobId }: { jobId: string }) => {
      toast.success(t("adminDisk.reclaimQueued"))
      setActiveJob({ id: jobId, label: t("adminDisk.reclaimLabel") })
    },
    onError: (err: unknown) =>
      notifyMutationError(err, t("adminDisk.reclaimFailed")),
  })

  const pruneBuildCacheMutation = useMutation({
    mutationFn: pruneBuildCache,
    onSuccess: ({ jobId }: { jobId: string }) => {
      toast.success(t("adminDisk.pruneQueued"))
      setActiveJob({ id: jobId, label: t("adminDisk.pruneLabel") })
    },
    onError: (err: unknown) =>
      notifyMutationError(err, t("adminDisk.pruneFailed")),
  })

  const dockerCleanupMutation = useMutation({
    mutationFn: cleanupDocker,
    onSuccess: ({ jobId }: { jobId: string }) => {
      toast.success(t("adminDisk.cleanupQueued"))
      setActiveJob({ id: jobId, label: t("adminDisk.cleanupLabel") })
    },
    onError: (err: unknown) =>
      notifyMutationError(err, t("adminDisk.cleanupFailed")),
  })

  return (
    <div className="w-full space-y-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t("adminDisk.title")}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("adminDisk.description")}
          </p>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 sm:w-auto"
            loading={isRefreshing}
            onClick={() => refreshMutation.mutate()}
          >
            <RiRefreshLine className="size-4" />
            {t("common:refresh")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 sm:w-auto"
            loading={pruneImagesMutation.isPending}
            disabled={activeJob !== null}
            onClick={() => pruneImagesMutation.mutate()}
          >
            <RiDeleteBin6Line className="size-4" />
            {t("adminDisk.reclaimImages")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2 sm:w-auto"
            loading={pruneBuildCacheMutation.isPending}
            disabled={activeJob !== null}
            onClick={() => pruneBuildCacheMutation.mutate()}
          >
            <RiEraserLine className="size-4" />
            {t("adminDisk.pruneCache")}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                className="w-full gap-2 sm:w-auto"
                loading={dockerCleanupMutation.isPending}
                disabled={activeJob !== null}
              >
                <RiEraserLine className="size-4" />
                {t("adminDisk.cleanupDocker")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("adminDisk.cleanupConfirmTitle")}</AlertDialogTitle>
                <AlertDialogDescription>{t("adminDisk.cleanupConfirmDescription")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => dockerCleanupMutation.mutate()}
                >
                  {t("adminDisk.cleanupDocker")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {activeJob ? (
        <p
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          aria-live="polite"
        >
          <RiLoader4Line className="mr-2 inline size-4 animate-spin" />
          {activeJob.label}{" "}
          {job?.status === "running"
            ? t("adminDisk.running")
            : t("adminDisk.queued")}
          …
        </p>
      ) : null}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="text-sm font-medium">{t("adminDisk.history")}</h2>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          {history.map((entry) => (
            <li key={entry.jobId} className="rounded border border-border px-3 py-2">
              <span className="font-medium text-foreground">{entry.kind}</span>{" "}
              — {entry.status}
              {entry.errorMessage ? `: ${entry.errorMessage}` : null}
              {entry.result ? <pre className="mt-2 overflow-auto text-xs">{JSON.stringify(entry.result, null, 2)}</pre> : null}
            </li>
          ))}
        </ul>
      </section>

      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {t("adminDisk.loadFailed")}
        </div>
      ) : null}

      {isLoading ? (
        <div className="space-y-3">
          <div className="h-24 skeleton-surface rounded-xl border border-border" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="h-28 skeleton-surface rounded-xl border border-border"
              />
            ))}
          </div>
        </div>
      ) : null}

      {data?.host ? <HostUsageCard host={data.host} /> : null}

      {data ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">
              {t("adminDisk.categories")}
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-mono">
                {t("adminDisk.imageLayers", {
                  bytes: formatBytes(data.layersSizeBytes),
                })}
              </span>
              <span aria-live="polite">
                {isRefreshing
                  ? t("adminDisk.refreshing")
                  : t("adminDisk.measuredAt", {
                      time: formatMeasuredAt(data.refreshedAt),
                    })}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {data.categories.map((category) => (
              <CategoryCard key={category.kind} category={category} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function HostUsageCard({
  host,
}: {
  host: NonNullable<DiskUsageResponse["host"]>
}): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  const pct =
    host.totalBytes > 0
      ? Math.min((host.usedBytes / host.totalBytes) * 100, 100)
      : 0

  return (
    <section
      aria-label={t("adminDisk.hostUsage")}
      className="rounded-2xl rounded-xl bg-panel p-4"
    >
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <RiHardDriveLine className="size-4 text-muted-foreground" />
        {t("adminDisk.hostDisk")}
      </div>
      <div className="mt-3 space-y-1.5">
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {t("adminDisk.usedOf", {
              used: formatBytes(host.usedBytes),
              total: formatBytes(host.totalBytes),
            })}
          </span>
          <span className="tabular-nums">{pct.toFixed(0)}%</span>
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={cn(
              "h-full rounded-full transition-all",
              diskBarTone(pct)
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("adminDisk.free", { bytes: formatBytes(host.freeBytes) })}
        </p>
      </div>
    </section>
  )
}

function CategoryCard({
  category,
}: {
  category: DiskUsageResponse["categories"][number]
}): React.JSX.Element {
  const { t } = useTranslation("monitoring")
  return (
    <div className="flex flex-col gap-2 rounded-2xl rounded-xl bg-panel p-4">
      <p className="text-sm font-medium text-foreground">
        {t(CATEGORY_KEYS[category.kind])}
      </p>
      <p className="text-xl font-medium text-foreground tabular-nums">
        {formatBytes(category.totalBytes)}
      </p>
      <dl className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
        <dt>{t("adminDisk.reclaimable")}</dt>
        <dd className="text-right tabular-nums">
          {formatBytes(category.reclaimableBytes)}
        </dd>
        <dt>{t("adminDisk.count")}</dt>
        <dd className="text-right tabular-nums">{category.count}</dd>
      </dl>
    </div>
  )
}
