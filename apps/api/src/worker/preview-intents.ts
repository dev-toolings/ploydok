// SPDX-License-Identifier: AGPL-3.0-only
import { nanoid } from "nanoid"
import { eq } from "drizzle-orm"
import { preview_deployments, preview_queue_jobs, type Db } from "@ploydok/db"
import { enqueueWithDbRow, type QueuePublisher } from "./queue-enqueue"

type PreviewRequest = {
  appId: string; prNumber: number; source: string; requestedByUserId?: string
} & ({ action: "deploy"; headSha: string; domain: string; expiresAt: Date } | { action: "teardown" })

export async function enqueuePreviewIntent(db: Db, queue: QueuePublisher, input: PreviewRequest) {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) throw new Error("Invalid preview PR number")
  const expectedQueue = `preview.${input.action}`
  if (queue.name !== expectedQueue) throw new Error("Preview queue/action mismatch")
  const jobId = nanoid()
  const previewId = `${input.appId}:pr-${input.prNumber}`
  return enqueueWithDbRow({
    db, queue, jobName: expectedQueue,
    insertRow: async tx => {
      const now = new Date()
      if (input.action === "deploy") {
        const values = { id: previewId, app_id: input.appId, pr_number: input.prNumber,
          head_sha: input.headSha, domain: input.domain, status: "pending" as const,
          expires_at: input.expiresAt, queue_job_id: jobId, updated_at: now }
        await tx.insert(preview_deployments).values(values).onConflictDoUpdate({
          target: [preview_deployments.app_id, preview_deployments.pr_number],
          set: { head_sha: values.head_sha, domain: values.domain, status: values.status,
            expires_at: values.expires_at, queue_job_id: jobId, updated_at: now },
        })
      } else {
        await tx.update(preview_deployments).set({ status: "tearing_down", queue_job_id: jobId, updated_at: now })
          .where(eq(preview_deployments.id, previewId))
      }
      const [row] = await tx.insert(preview_queue_jobs).values({
        id: jobId, app_id: input.appId, pr_number: input.prNumber, action: input.action,
        head_sha: input.action === "deploy" ? input.headSha : null,
        requested_by_user_id: input.requestedByUserId ?? null, source: input.source,
      }).returning()
      return row!
    },
    buildPayload: row => ({ previewJobId: row.id }),
  })
}

// Read the immutable snapshot, not the potentially newer mutable preview head.
export async function loadPreviewIntentPayload(db: Db, payload: unknown, action: "deploy" | "teardown") {
  const reference = (payload as { previewJobId?: unknown } | null)?.previewJobId
  // Accept already queued jobs from the previous release.
  if (reference === undefined) return payload
  if (typeof reference !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(reference)) throw new Error("Invalid preview job reference")
  const [job] = await db.select().from(preview_queue_jobs).where(eq(preview_queue_jobs.id, reference))
  if (!job || job.action !== action) throw new Error("Preview intention not found or action mismatch")
  if (job.completed_at) return null
  const [preview] = await db.select().from(preview_deployments)
    .where(eq(preview_deployments.id, `${job.app_id}:pr-${job.pr_number}`))
  if (!preview || preview.queue_job_id !== job.id) return null // superseded or removed
  return { appId: job.app_id, prNumber: job.pr_number,
    ...(action === "deploy" ? { headSha: job.head_sha } : {}) }
}

export async function completePreviewIntent(db: Db, payload: unknown) {
  const id = (payload as { previewJobId?: string } | null)?.previewJobId
  if (id) await db.update(preview_queue_jobs).set({ completed_at: new Date() }).where(eq(preview_queue_jobs.id, id))
}
