// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@workspace/ui/components/chart"
import { getDiskInsights } from "../../lib/disk"
import type { DiskJobStatus, DiskUsageResponse } from "@ploydok/shared"

const KIND_KEYS = {
  images: "images",
  containers: "containers",
  volumes: "volumes",
  build_cache: "buildCache",
} as const

function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  const index =
    value === 0 ? 0 : Math.min(Math.floor(Math.log2(Math.abs(value)) / 10), 4)
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

function reclaimed(job: DiskJobStatus | undefined): number | null {
  const result = job?.result
  if (!result) return null
  if ("spaceReclaimedBytes" in result) return result.spaceReclaimedBytes
  if ("imagesSpaceReclaimedBytes" in result)
    return (
      result.imagesSpaceReclaimedBytes +
      result.builderCacheSpaceReclaimedBytes +
      result.localCacheSpaceReclaimedBytes
    )
  return null
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-2xl bg-panel p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-medium tabular-nums leading-[34px]">{value}</p>
      <p className="mt-2 text-xs leading-5 break-words text-muted-foreground">
        {hint}
      </p>
    </div>
  )
}

export function DiskInsightsPanel({
  usage,
  jobs,
}: {
  usage: DiskUsageResponse | undefined
  jobs: Array<DiskJobStatus>
}): React.JSX.Element {
  const { t, i18n } = useTranslation("monitoring")
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin", "disk", "insights"],
    queryFn: getDiskInsights,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })
  const latestCleanup = jobs.find(
    (job) => job.status === "succeeded" && reclaimed(job) !== null
  )
  const lastGain = reclaimed(latestCleanup)
  const inodePercent =
    usage?.host?.inodesTotal && usage.host.inodesUsed !== null
      ? Math.min(100, (usage.host.inodesUsed / usage.host.inodesTotal) * 100)
      : null
  const history = data?.history ?? []
  const chartData = React.useMemo(
    () =>
      history.flatMap((point, index) => {
        const at = Date.parse(point.measuredAt)
        const previous = history[index - 1]
        const gap =
          index > 0 && at - Date.parse(previous.measuredAt) > 2 * 3_600_000
        const row = { at, usedBytes: point.usedBytes }
        return gap ? [{ at: at - 1, usedBytes: null }, row] : [row]
      }),
    [history]
  )
  const formatDate = (value: number) =>
    new Date(value).toLocaleDateString(i18n.resolvedLanguage, {
      day: "numeric",
      month: "short",
    })
  const measurementPending = !usage || usage.stale
  const measurementState = t(
    measurementPending
      ? "adminDisk.kpi.measuringValue"
      : "adminDisk.kpi.measurementMissing"
  )
  const trendState = isLoading
    ? t("common:loading")
    : error
      ? t("adminDisk.kpi.historyError")
      : t(
          history.length === 0 ||
            Date.parse(history[0].measuredAt) > Date.now() - 7 * 86_400_000
            ? "adminDisk.kpi.collectingValue"
            : "adminDisk.kpi.insufficientHistory"
        )
  const noConsumers =
    usage?.cleanupReclaimableBytes != null && usage.topConsumers.length === 0
  const config = {
    usedBytes: { label: t("adminDisk.kpi.used"), color: "var(--primary)" },
  }

  return (
    <section
      className="min-w-0 space-y-5"
      aria-label={t("adminDisk.kpi.title")}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi
          label={t("adminDisk.kpi.reclaimable")}
          value={
            usage?.cleanupReclaimableBytes != null
              ? bytes(usage.cleanupReclaimableBytes)
              : measurementState
          }
          hint={t(
            usage?.cleanupReclaimableBytes != null || measurementPending
              ? "adminDisk.kpi.reclaimableHint"
              : "adminDisk.kpi.measurementMissingHint"
          )}
        />
        <Kpi
          label={t("adminDisk.kpi.growth")}
          value={
            data?.growth7dBytes != null
              ? `${data.growth7dBytes > 0 ? "+" : ""}${bytes(data.growth7dBytes)}`
              : trendState
          }
          hint={t(
            data?.growth7dBytes != null
              ? "adminDisk.kpi.growthHint"
              : "adminDisk.kpi.needsWeek"
          )}
        />
        <Kpi
          label={t("adminDisk.kpi.runway")}
          value={
            data?.daysTo90Percent != null
              ? t("adminDisk.kpi.days", {
                  count: Math.ceil(data.daysTo90Percent),
                })
              : data?.growth7dBytes != null && data.growth7dBytes <= 0
                ? t("adminDisk.kpi.stableOrDecreasing")
                : trendState
          }
          hint={t(
            data?.growth7dBytes != null && data.growth7dBytes <= 0
              ? "adminDisk.kpi.notGrowing"
              : data?.daysTo90Percent != null
                ? "adminDisk.kpi.runwayHint"
                : "adminDisk.kpi.needsWeek"
          )}
        />
        <Kpi
          label={t("adminDisk.kpi.inodes")}
          value={
            inodePercent !== null
              ? `${inodePercent.toFixed(1)}%`
              : t(usage ? "adminDisk.kpi.measurementMissing" : "common:loading")
          }
          hint={t("adminDisk.kpi.inodesHint")}
        />
        <Kpi
          label={t("adminDisk.kpi.largest")}
          value={
            usage?.topConsumers[0]
              ? bytes(usage.topConsumers[0].sizeBytes)
              : noConsumers
                ? t("common:none")
                : measurementState
          }
          hint={
            usage?.topConsumers[0]?.name ??
            t(
              noConsumers
                ? "adminDisk.kpi.noConsumers"
                : "adminDisk.kpi.topPending"
            )
          }
        />
        <Kpi
          label={t("adminDisk.kpi.lastCleanup")}
          value={
            lastGain !== null
              ? bytes(lastGain)
              : t("adminDisk.kpi.noMeasuredCleanup")
          }
          hint={
            latestCleanup?.finishedAt
              ? new Date(latestCleanup.finishedAt).toLocaleString(
                  i18n.resolvedLanguage
                )
              : t("adminDisk.kpi.noCleanup")
          }
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("adminDisk.kpi.historyFailed")}
        </p>
      ) : null}
      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-2">
        <div className="min-w-0 rounded-2xl bg-panel p-4">
          <h2 className="text-sm font-medium">
            {t("adminDisk.kpi.historyTitle")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("adminDisk.kpi.historyHint")}
          </p>
          {history.length >= 2 ? (
            <ChartContainer
              config={config}
              className="mt-4 aspect-auto h-56 w-full"
            >
              <AreaChart
                accessibilityLayer
                data={chartData}
                margin={{ top: 12, right: 12, left: 0, bottom: 0 }}
              >
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="at"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={formatDate}
                  minTickGap={40}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tickFormatter={bytes}
                  width={72}
                  tickLine={false}
                  axisLine={false}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(_, payload) =>
                        payload[0]?.payload?.at
                          ? new Date(
                              payload[0].payload.at as number
                            ).toLocaleString(i18n.resolvedLanguage)
                          : ""
                      }
                      formatter={(value) => (
                        <span className="font-sans tabular-nums">
                          {bytes(Number(value))}
                        </span>
                      )}
                    />
                  }
                />
                <Area
                  type="linear"
                  dataKey="usedBytes"
                  stroke="var(--color-usedBytes)"
                  fill="var(--color-usedBytes)"
                  fillOpacity={0.12}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <p className="flex min-h-56 items-center justify-center text-center text-sm text-muted-foreground">
              {isLoading
                ? t("common:loading")
                : error
                  ? t("adminDisk.kpi.historyFailed")
                  : t("adminDisk.kpi.collecting", { count: history.length })}
            </p>
          )}
          <div className="mt-3 text-xs">
            <h3 className="font-medium text-muted-foreground">
              {t("adminDisk.kpi.viewMeasurements")}
            </h3>
            <div className="mt-2 max-h-48 overflow-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th scope="col" className="py-2 font-medium">
                      {t("adminDisk.kpi.measuredAt")}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t("adminDisk.kpi.used")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="py-3 text-muted-foreground">
                        {t(
                          isLoading
                            ? "common:loading"
                            : error
                              ? "adminDisk.kpi.historyFailed"
                              : "adminDisk.kpi.noMeasurements"
                        )}
                      </td>
                    </tr>
                  ) : null}
                  {history.map((sample) => (
                    <tr key={sample.measuredAt}>
                      <td className="py-1">
                        {new Date(sample.measuredAt).toLocaleString(
                          i18n.resolvedLanguage
                        )}
                      </td>
                      <td className="py-1 tabular-nums">
                        {bytes(sample.usedBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="min-w-0 rounded-2xl bg-panel p-4">
          <h2 className="text-sm font-medium">
            {t("adminDisk.kpi.topTitle")}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("adminDisk.kpi.topHint")}
          </p>
          {usage && usage.topConsumers.length > 0 ? (
            <ol className="mt-4 divide-y divide-border">
              {usage.topConsumers.map((consumer, index) => (
                <li
                  key={`${consumer.kind}:${consumer.name}`}
                  className="flex min-w-0 items-start gap-3 py-3"
                >
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs break-all">
                      {consumer.name}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(`adminDisk.${KIND_KEYS[consumer.kind]}`)}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {bytes(consumer.sizeBytes)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-6 text-sm text-muted-foreground">
              {t(
                usage?.stale
                  ? "adminDisk.measuring"
                  : noConsumers
                    ? "adminDisk.kpi.noConsumers"
                    : "adminDisk.kpi.topPending"
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
