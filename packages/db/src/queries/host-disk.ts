// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, lt } from "drizzle-orm"
import { host_disk_samples } from "../schema/host-disk-samples"
import type { HostDiskSample } from "../schema/host-disk-samples"
import type { Db } from "../client"

export async function recordHostDiskSample(
  db: Db,
  hostKey: string,
  measuredAt: Date,
  usedBytes: number,
  totalBytes: number
): Promise<void> {
  const bucketAt = new Date(
    Math.floor(measuredAt.getTime() / 3_600_000) * 3_600_000
  )
  await db
    .insert(host_disk_samples)
    .values({
      host_key: hostKey,
      bucket_at: bucketAt,
      measured_at: measuredAt,
      used_bytes: usedBytes,
      total_bytes: totalBytes,
    })
    .onConflictDoUpdate({
      target: [host_disk_samples.host_key, host_disk_samples.bucket_at],
      set: {
        measured_at: measuredAt,
        used_bytes: usedBytes,
        total_bytes: totalBytes,
      },
    })
  await db
    .delete(host_disk_samples)
    .where(
      and(
        eq(host_disk_samples.host_key, hostKey),
        lt(
          host_disk_samples.bucket_at,
          new Date(measuredAt.getTime() - 31 * 86_400_000)
        )
      )
    )
}

export async function listHostDiskSamples(
  db: Db,
  hostKey: string,
  since: Date
): Promise<Array<HostDiskSample>> {
  return db
    .select()
    .from(host_disk_samples)
    .where(
      and(
        eq(host_disk_samples.host_key, hostKey),
        gte(host_disk_samples.measured_at, since)
      )
    )
    .orderBy(asc(host_disk_samples.measured_at))
    .limit(745)
}
