// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test"
import { createDb, preview_deployments, preview_queue_jobs, queue_outbox_events, type Db } from "@ploydok/db"
import { eq, sql } from "drizzle-orm"
import { enqueuePreviewIntent, loadPreviewIntentPayload, completePreviewIntent } from "./preview-intents"
import { dispatchQueueOutboxEventById } from "./queue-outbox-dispatcher"

async function isolated(run: (db: Db) => Promise<void>) {
  const db = createDb(process.env.DATABASE_URL!)
  try {
    await db.transaction(async tx => {
      for (const table of ["preview_deployments", "preview_queue_jobs", "queue_outbox_events"])
        await tx.execute(sql.raw(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL) ON COMMIT DROP`))
      await run(tx as unknown as Db)
    })
  } finally { await db.$client.end() }
}
const deploy = { action: "deploy" as const, appId: "app-fixture", prNumber: 7,
  headSha: "sha-one", domain: "pr-7.example.test", expiresAt: new Date(), source: "webhook:pull_request" }
const unavailable = (name: string) => ({ name, add: async () => { throw new Error("Redis unavailable") } })

test.skipIf(!process.env.DATABASE_URL).each(["deploy", "teardown"] as const)("preview %s intent survives failed Redis publication and replays the same job reference", async action => {
  await isolated(async db => {
    await enqueuePreviewIntent(db, unavailable("preview.deploy"), deploy)
    if (action === "teardown") {
      await db.update(preview_deployments).set({ container_id: "existing-container", status: "running" })
      await enqueuePreviewIntent(db, unavailable("preview.teardown"), {
        action: "teardown", appId: deploy.appId, prNumber: deploy.prNumber, source: "cron:preview",
      })
    }
    const [event] = await db.select().from(queue_outbox_events).where(eq(queue_outbox_events.queue_name, `preview.${action}`))
    expect(event?.dispatched_at).toBeNull()
    expect(event?.attempt_count).toBe(1)
    expect(event?.last_error).toContain("Redis unavailable")
    const [preview] = await db.select().from(preview_deployments)
    expect(preview?.status).toBe(action === "teardown" ? "tearing_down" : "pending")
    if (action === "teardown") expect(preview?.container_id).toBe("existing-container")
    expect(event?.payload).toEqual({ previewJobId: event?.job_id })
    const published: unknown[] = []
    const queue = { name: `preview.${action}`, add: async (_name: string, payload: unknown, options: any) => {
      published.push(payload); return { id: options.jobId }
    } }
    const now = new Date(Date.now() + 120_000)
    expect(await dispatchQueueOutboxEventById(db, queue, event!.id, now, { audit: () => {} })).toBe("dispatched")
    expect(published).toEqual([event?.payload])
    const payload = await loadPreviewIntentPayload(db, published[0], action)
    expect(payload).toMatchObject({ appId: deploy.appId, prNumber: 7 })
    if (action === "deploy") expect(payload).toMatchObject({ headSha: "sha-one" })
    await completePreviewIntent(db, published[0])
    expect(await loadPreviewIntentPayload(db, published[0], action)).toBeNull()
    expect(await dispatchQueueOutboxEventById(db, queue, event!.id, now)).toBe("idle")
    const [saved] = await db.select().from(queue_outbox_events).where(eq(queue_outbox_events.id, event!.id))
    expect(saved?.dispatched_at).not.toBeNull()
  })
})

test.skipIf(!process.env.DATABASE_URL)("a newer preview transition fences stale replay while preserving immutable heads", async () => {
  await isolated(async db => {
    const first = await enqueuePreviewIntent(db, unavailable("preview.deploy"), deploy)
    const second = await enqueuePreviewIntent(db, unavailable("preview.deploy"), { ...deploy, headSha: "sha-two" })
    expect(first.jobId).not.toBe(second.jobId)
    expect(await loadPreviewIntentPayload(db, { previewJobId: first.jobId }, "deploy")).toBeNull()
    expect(await loadPreviewIntentPayload(db, { previewJobId: second.jobId }, "deploy")).toMatchObject({ headSha: "sha-two" })
    const [snapshot] = await db.select().from(preview_queue_jobs).where(eq(preview_queue_jobs.id, first.jobId))
    expect(snapshot?.head_sha).toBe("sha-one")
  })
})

test.skipIf(!process.env.DATABASE_URL)("failure to persist the outbox rolls back the preview and snapshot together", async () => {
  await isolated(async db => {
    await db.execute(sql.raw("ALTER TABLE pg_temp.queue_outbox_events ADD CONSTRAINT fixture_reject CHECK (false)"))
    await expect(enqueuePreviewIntent(db, unavailable("preview.deploy"), deploy)).rejects.toThrow()
    expect(await db.select().from(preview_deployments)).toHaveLength(0)
    expect(await db.select().from(preview_queue_jobs)).toHaveLength(0)
  })
})
