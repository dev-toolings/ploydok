// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, isNull, lte, ne, or, sql } from "drizzle-orm"
import { nanoid } from "nanoid"
import { resource_creation_sagas } from "../schema"
import type {
  CreationSagaOwnedResources,
  CreationSagaResourceType,
  ResourceCreationSagaRow,
} from "../schema"
import type { Db } from "../client"

export function creationSagaId(
  resourceType: CreationSagaResourceType,
  resourceId: string
): string {
  return `${resourceType}:${resourceId}`
}

export async function createCreationSaga(
  db: Pick<Db, "insert">,
  input: {
    resourceType: CreationSagaResourceType
    resourceId: string
    projectId: string
    requestedByUserId?: string | null
    completedSteps?: string[]
    ownedResources?: CreationSagaOwnedResources
    inputCiphertext?: Buffer | null
    inputNonce?: Buffer | null
    inputDigest?: string | null
    maxAttempts?: number
  }
): Promise<void> {
  await db
    .insert(resource_creation_sagas)
    .values({
      id: creationSagaId(input.resourceType, input.resourceId),
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      project_id: input.projectId,
      requested_by_user_id: input.requestedByUserId ?? null,
      completed_steps: input.completedSteps ?? [],
      owned_resources: input.ownedResources ?? {},
      input_ciphertext: input.inputCiphertext ?? null,
      input_nonce: input.inputNonce ?? null,
      input_digest: input.inputDigest ?? null,
      max_attempts: input.maxAttempts ?? 8,
    })
    .onConflictDoNothing({ target: resource_creation_sagas.id })
}

export async function claimCreationSaga(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  options: { now?: Date; leaseMs?: number; token?: string } = {}
): Promise<{ saga: ResourceCreationSagaRow; token: string } | null> {
  const now = options.now ?? new Date()
  const token = options.token ?? nanoid()
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? 30_000))
  const rows = await db
    .update(resource_creation_sagas)
    .set({
      // An expired compensation lease must resume cleanup, never provisioning.
      state: sql`CASE
        WHEN ${resource_creation_sagas.state} = 'compensating' THEN 'compensating'
        ELSE 'provisioning'
      END`,
      lease_token: token,
      lease_until: leaseUntil,
      attempt_count: sql`${resource_creation_sagas.attempt_count} + 1`,
      last_error: sql`CASE
        WHEN ${resource_creation_sagas.state} = 'compensating'
          THEN ${resource_creation_sagas.last_error}
        ELSE NULL
      END`,
      updated_at: now,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        sql`${resource_creation_sagas.state} NOT IN ('complete', 'compensated')`,
        lte(resource_creation_sagas.next_retry_at, now),
        or(
          isNull(resource_creation_sagas.lease_until),
          lte(resource_creation_sagas.lease_until, now)
        )
      )
    )
    .returning()
  return rows[0] ? { saga: rows[0], token } : null
}

export async function fenceCreationSaga(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  token: string,
  options: { now?: Date; leaseMs?: number } = {}
): Promise<boolean> {
  const now = options.now ?? new Date()
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? 30_000))
  const rows = await db
    .update(resource_creation_sagas)
    .set({ lease_until: leaseUntil, updated_at: now })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        eq(resource_creation_sagas.lease_token, token),
        gt(resource_creation_sagas.lease_until, now),
        sql`${resource_creation_sagas.state} IN ('provisioning', 'compensating')`
      )
    )
    .returning({ id: resource_creation_sagas.id })
  return rows.length === 1
}

export async function getCreationSaga(
  db: Pick<Db, "select">,
  resourceType: CreationSagaResourceType,
  resourceId: string
): Promise<ResourceCreationSagaRow | null> {
  const rows = await db
    .select()
    .from(resource_creation_sagas)
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId)
      )
    )
    .limit(1)
  return rows[0] ?? null
}

export async function beginCreationSagaAttempt(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  now = new Date()
): Promise<void> {
  await db
    .update(resource_creation_sagas)
    .set({
      state: "provisioning",
      attempt_count: sql`${resource_creation_sagas.attempt_count} + 1`,
      last_error: null,
      updated_at: now,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        ne(resource_creation_sagas.state, "complete")
      )
    )
}

export async function recordCreationSagaStep(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  step: string,
  ownedResources: CreationSagaOwnedResources = {},
  now = new Date()
): Promise<void> {
  await db
    .update(resource_creation_sagas)
    .set({
      completed_steps: sql`CASE
        WHEN ${step} = ANY(${resource_creation_sagas.completed_steps})
          THEN ${resource_creation_sagas.completed_steps}
        ELSE array_append(${resource_creation_sagas.completed_steps}, ${step})
      END`,
      owned_resources: sql`${resource_creation_sagas.owned_resources} || ${JSON.stringify(ownedResources)}::jsonb`,
      updated_at: now,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        ne(resource_creation_sagas.state, "complete")
      )
    )
}

export async function recordClaimedCreationSagaStep(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  token: string,
  step: string,
  ownedResources: CreationSagaOwnedResources = {},
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(resource_creation_sagas)
    .set({
      completed_steps: sql`CASE
        WHEN ${step} = ANY(${resource_creation_sagas.completed_steps})
          THEN ${resource_creation_sagas.completed_steps}
        ELSE array_append(${resource_creation_sagas.completed_steps}, ${step})
      END`,
      owned_resources: sql`${resource_creation_sagas.owned_resources} || ${JSON.stringify(ownedResources)}::jsonb`,
      updated_at: now,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        eq(resource_creation_sagas.lease_token, token),
        gt(resource_creation_sagas.lease_until, now)
      )
    )
    .returning({ id: resource_creation_sagas.id })
  return rows.length === 1
}

export async function completeCreationSaga(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  now = new Date()
): Promise<void> {
  await db
    .update(resource_creation_sagas)
    .set({
      state: "complete",
      last_error: null,
      completed_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId)
      )
    )
}

export async function completeClaimedCreationSaga(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  token: string,
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(resource_creation_sagas)
    .set({
      state: "complete",
      last_error: null,
      completed_at: now,
      updated_at: now,
      lease_token: null,
      lease_until: null,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        eq(resource_creation_sagas.lease_token, token),
        gt(resource_creation_sagas.lease_until, now)
      )
    )
    .returning({ id: resource_creation_sagas.id })
  return rows.length === 1
}

export async function failCreationSaga(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  error: unknown,
  now = new Date()
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  await db
    .update(resource_creation_sagas)
    .set({
      state: "failed",
      last_error: message.slice(0, 2_000),
      updated_at: now,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        ne(resource_creation_sagas.state, "complete")
      )
    )
}

export async function retryClaimedCreationSaga(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  token: string,
  error: unknown,
  availableAt: Date,
  now = new Date(),
  retryState: "failed" | "compensating" = "failed"
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error)
  const rows = await db
    .update(resource_creation_sagas)
    .set({
      state: retryState,
      last_error: message.slice(0, 2_000),
      next_retry_at: availableAt,
      lease_token: null,
      lease_until: null,
      updated_at: now,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        eq(resource_creation_sagas.lease_token, token)
      )
    )
    .returning({ id: resource_creation_sagas.id })
  return rows.length === 1
}

export async function beginCreationSagaCompensation(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  now = new Date()
): Promise<void> {
  await db
    .update(resource_creation_sagas)
    .set({ state: "compensating", updated_at: now })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        ne(resource_creation_sagas.state, "complete")
      )
    )
}

export async function beginClaimedCreationSagaCompensation(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  token: string,
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(resource_creation_sagas)
    .set({ state: "compensating", updated_at: now })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        eq(resource_creation_sagas.lease_token, token),
        gt(resource_creation_sagas.lease_until, now)
      )
    )
    .returning({ id: resource_creation_sagas.id })
  return rows.length === 1
}

export async function completeClaimedCreationSagaCompensation(
  db: Pick<Db, "update">,
  resourceType: CreationSagaResourceType,
  resourceId: string,
  token: string,
  error: string,
  now = new Date()
): Promise<boolean> {
  const rows = await db
    .update(resource_creation_sagas)
    .set({
      state: "compensated",
      last_error: error.slice(0, 2_000),
      completed_at: now,
      updated_at: now,
      lease_token: null,
      lease_until: null,
    })
    .where(
      and(
        eq(resource_creation_sagas.resource_type, resourceType),
        eq(resource_creation_sagas.resource_id, resourceId),
        eq(resource_creation_sagas.lease_token, token)
      )
    )
    .returning({ id: resource_creation_sagas.id })
  return rows.length === 1
}

export async function listIncompleteCreationSagas(
  db: Pick<Db, "select">,
  resourceType?: CreationSagaResourceType,
  now = new Date()
): Promise<ResourceCreationSagaRow[]> {
  const condition = resourceType
    ? and(
        eq(resource_creation_sagas.resource_type, resourceType),
        sql`${resource_creation_sagas.state} NOT IN ('complete', 'compensated')`,
        lte(resource_creation_sagas.next_retry_at, now)
      )
    : and(
        sql`${resource_creation_sagas.state} NOT IN ('complete', 'compensated')`,
        lte(resource_creation_sagas.next_retry_at, now)
      )
  return db.select().from(resource_creation_sagas).where(condition)
}
