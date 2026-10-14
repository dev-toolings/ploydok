// SPDX-License-Identifier: AGPL-3.0-only
import type { JobsOptions } from "bullmq"
import type { Db } from "@ploydok/db"
import { insertQueueOutboxEvent } from "@ploydok/db/queries"
import { dispatchQueueOutboxEventById } from "./queue-outbox-dispatcher"

const MAX_DURABLE_JSON_BYTES = 64 * 1024
const ALLOWED_JOB_OPTION_KEYS = new Set(["attempts"])

const REFERENCE_PAYLOAD_KEYS = {
  "deploy\0deploy.requested": ["buildId"],
  "service.install\0service.install.requested": ["serviceId"],
  "gc.registry\0gc.registry.requested": ["jobId"],
  "gc.images\0gc.images.requested": ["jobId"],
  "gc.buildcache\0gc.buildcache.requested": ["jobId"],
  "gc.docker\0gc.docker.requested": ["jobId"],
  "app.delete\0app.delete.requested": ["jobId"],
} as const

export const TRANSACTIONAL_QUEUE_CONTRACTS = Object.freeze(
  Object.keys(REFERENCE_PAYLOAD_KEYS).map((key) => {
    const [queueName, jobName] = key.split("\0")
    return { queueName: queueName!, jobName: jobName! }
  })
)

export function deterministicQueueJobId(
  _queueName: string,
  sourceRowId: string
): string {
  // All critical source rows use nanoid-compatible identifiers. Keeping that
  // ID preserves API response/job lookup contracts while making Redis replay
  // deterministic. BullMQ forbids ':' in custom IDs.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sourceRowId)) {
    throw new Error("Queue source row ID is not BullMQ-safe")
  }
  return sourceRowId
}

export interface QueuePublisher {
  readonly name: string
  add(
    name: string,
    data: unknown,
    options?: JobsOptions
  ): Promise<{ id?: string | null }>
}

function assertReferencePayload(
  queueName: string,
  jobName: string,
  value: Record<string, unknown>
): void {
  const contractKey = `${queueName}\0${jobName}`
  const allowed = REFERENCE_PAYLOAD_KEYS[
    contractKey as keyof typeof REFERENCE_PAYLOAD_KEYS
  ] as readonly string[] | undefined
  if (!allowed) {
    throw new Error(
      `Queue outbox has no reference payload contract for ${queueName}/${jobName}`
    )
  }
  const keys = Object.keys(value)
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new Error(
      `Queue outbox payload for ${queueName}/${jobName} must contain only ${allowed.join(", ")}`
    )
  }
  for (const key of allowed) {
    const reference = value[key]
    if (
      typeof reference !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(reference)
    ) {
      throw new Error(
        `Queue outbox reference ${key} for ${queueName}/${jobName} is invalid`
      )
    }
  }
}

export function durableJsonObject(
  value: unknown,
  label: "payload" | "jobOptions"
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Queue outbox ${label} must be a JSON object`)
  }
  let encoded: string
  try {
    encoded = JSON.stringify(value)
  } catch (cause) {
    throw new Error(`Queue outbox ${label} is not JSON serializable`, { cause })
  }
  if (Buffer.byteLength(encoded) > MAX_DURABLE_JSON_BYTES) {
    throw new Error(`Queue outbox ${label} exceeds 64 KiB`)
  }
  const decoded = JSON.parse(encoded) as unknown
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`Queue outbox ${label} must remain a JSON object`)
  }
  return decoded as Record<string, unknown>
}

export function assertTransactionalQueueRegistry(
  queues: readonly Pick<QueuePublisher, "name">[]
): void {
  const expected = new Set(
    TRANSACTIONAL_QUEUE_CONTRACTS.map((contract) => contract.queueName)
  )
  const actual = new Set(queues.map((queue) => queue.name))
  const missing = [...expected].filter((name) => !actual.has(name))
  const unexpected = [...actual].filter((name) => !expected.has(name))
  if (missing.length || unexpected.length || actual.size !== queues.length) {
    throw new Error(
      `Transactional queue registry mismatch (missing: ${missing.join(", ") || "none"}; unexpected/duplicate: ${unexpected.join(", ") || "none"})`
    )
  }
}

function assertSafeJobOptions(value: Record<string, unknown>): void {
  const unexpected = Object.keys(value).filter(
    (key) => !ALLOWED_JOB_OPTION_KEYS.has(key)
  )
  if (unexpected.length) {
    throw new Error(
      `Queue outbox jobOptions contains unsupported keys: ${unexpected.join(", ")}`
    )
  }
  if (
    value.attempts !== undefined &&
    (!Number.isSafeInteger(value.attempts) ||
      (value.attempts as number) < 1 ||
      (value.attempts as number) > 100)
  ) {
    throw new Error(
      "Queue outbox jobOptions.attempts must be an integer 1..100"
    )
  }
}

export async function enqueueWithDbRow<
  TPayload,
  TRow extends { id: string },
>(opts: {
  db: Db
  queue: QueuePublisher
  jobName: string
  insertRow: (txDb: any) => Promise<TRow>
  buildPayload: (row: TRow) => TPayload
  jobOptions?: JobsOptions
  dispatchAfterCommit?: typeof dispatchQueueOutboxEventById
}): Promise<{ jobId: string; row: TRow }> {
  const result = await opts.db.transaction((tx) =>
    persistQueueOutboxWithDbRow({ ...opts, db: tx as any })
  )

  // Low-latency best effort only. Failure is intentionally not surfaced: the
  // committed outbox row is the durable acceptance and the poller will retry.
  const dispatch = opts.dispatchAfterCommit ?? dispatchQueueOutboxEventById
  await dispatch(opts.db, opts.queue, result.eventId).catch(
    () => "retry" as const
  )
  return { jobId: result.jobId, row: result.row }
}

/** Persist a source row and its queue intent inside a transaction owned by the caller. */
export async function persistQueueOutboxWithDbRow<
  TPayload,
  TRow extends { id: string },
>(opts: {
  db: any
  queue: QueuePublisher
  jobName: string
  insertRow: (txDb: any) => Promise<TRow>
  buildPayload: (row: TRow) => TPayload
  jobOptions?: JobsOptions
}): Promise<{ jobId: string; eventId: string; row: TRow }> {
  const row = await opts.insertRow(opts.db)
  const jobId = deterministicQueueJobId(opts.queue.name, row.id)
  const payload = durableJsonObject(opts.buildPayload(row), "payload")
  assertReferencePayload(opts.queue.name, opts.jobName, payload)
  const rawOptions = { ...(opts.jobOptions ?? {}) } as Record<string, unknown>
  delete rawOptions.jobId
  const jobOptions = durableJsonObject(rawOptions, "jobOptions")
  assertSafeJobOptions(jobOptions)
  const actor =
    typeof (row as any)?.requested_by_user_id === "string"
      ? (row as any).requested_by_user_id
      : null
  const source =
    typeof (row as any)?.source === "string" ? (row as any).source : "system"
  const eventId = `queue:${opts.queue.name}:${jobId}`

  await insertQueueOutboxEvent(opts.db, {
    id: eventId,
    queue_name: opts.queue.name,
    job_name: opts.jobName,
    job_id: jobId,
    source_row_id: row.id,
    actor_user_id: actor,
    source,
    payload,
    job_options: jobOptions,
  })
  return { row, jobId, eventId }
}
