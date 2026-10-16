// SPDX-License-Identifier: AGPL-3.0-only
import type { HostStatsResponse } from "@ploydok/agent-proto"

export interface HostStatsBody {
  cpu_percent: number
  cpu_count: number
  mem_total_bytes: number
  mem_used_bytes: number
  mem_available_bytes: number
  swap_total_bytes: number
  swap_used_bytes: number
  load_1: number
  load_5: number
  load_15: number
  disk_total_bytes: number
  disk_used_bytes: number
  disk_free_bytes: number
  inodes_total: number
  inodes_used: number
  uptime_seconds: number
  gpu_count: number
  gpu_utilization_pct: number
  gpu_mem_used_bytes: number
  gpu_mem_total_bytes: number
  gpu_name: string
  thresholds: {
    disk_warn_pct: number
    mem_warn_pct: number
    load_warn_per_cpu: number
  }
  alerts: string[]
  error: string
  fetched_at: number
}

const DEFAULT_THRESHOLDS = {
  disk_warn_pct: 85,
  mem_warn_pct: 90,
  load_warn_per_cpu: 1.5,
}

export function buildHostStatsBody(
  r: HostStatsResponse,
  fetchedAt: number
): HostStatsBody {
  const memPct =
    r.memTotalBytes > 0
      ? ((r.memTotalBytes - r.memAvailableBytes) / Number(r.memTotalBytes)) *
        100
      : 0
  const diskPct =
    r.diskTotalBytes > 0
      ? (Number(r.diskUsedBytes) / Number(r.diskTotalBytes)) * 100
      : 0
  const loadPerCpu = r.cpuCount > 0 ? r.load1 / r.cpuCount : r.load1

  const alerts: string[] = []
  if (diskPct > DEFAULT_THRESHOLDS.disk_warn_pct) {
    alerts.push(`disk_high:${diskPct.toFixed(1)}%`)
  }
  if (memPct > DEFAULT_THRESHOLDS.mem_warn_pct) {
    alerts.push(`mem_high:${memPct.toFixed(1)}%`)
  }
  if (loadPerCpu > DEFAULT_THRESHOLDS.load_warn_per_cpu) {
    alerts.push(`load_high:${loadPerCpu.toFixed(2)}/cpu`)
  }

  const body: HostStatsBody = {
    cpu_percent: r.cpuPercent,
    cpu_count: r.cpuCount,
    mem_total_bytes: Number(r.memTotalBytes),
    mem_used_bytes: Number(r.memTotalBytes) - Number(r.memAvailableBytes),
    mem_available_bytes: Number(r.memAvailableBytes),
    swap_total_bytes: Number(r.swapTotalBytes),
    swap_used_bytes: Number(r.swapUsedBytes),
    load_1: r.load1,
    load_5: r.load5,
    load_15: r.load15,
    disk_total_bytes: Number(r.diskTotalBytes),
    disk_used_bytes: Number(r.diskUsedBytes),
    disk_free_bytes: Number(r.diskFreeBytes),
    inodes_total: Number(r.inodesTotal),
    inodes_used: Number(r.inodesUsed),
    uptime_seconds: Number(r.uptimeSeconds),
    gpu_count: r.gpuCount,
    gpu_utilization_pct: r.gpuUtilizationPct,
    gpu_mem_used_bytes: Number(r.gpuMemUsedBytes),
    gpu_mem_total_bytes: Number(r.gpuMemTotalBytes),
    gpu_name: r.gpuName,
    thresholds: DEFAULT_THRESHOLDS,
    alerts,
    error: r.error ?? "",
    fetched_at: fetchedAt,
  }
  return body
}
