// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNotNull } from "drizzle-orm"
import { services, projects, memberships } from "../schema"
import type { Db } from "../client"

export type ServiceRow = typeof services.$inferSelect
export type ServiceInsert = typeof services.$inferInsert

export async function listServicesForProject(
  db: Db,
  projectId: string
): Promise<ServiceRow[]> {
  return db.select().from(services).where(eq(services.project_id, projectId))
}

export async function getServiceById(
  db: Db,
  serviceId: string
): Promise<ServiceRow | null> {
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1)
  return rows[0] ?? null
}

export async function getServiceForUser(
  db: Db,
  serviceId: string,
  userId: string
): Promise<ServiceRow | null> {
  const rows = await db
    .select({ service: services })
    .from(services)
    .innerJoin(projects, eq(services.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(services.id, serviceId))
    .limit(1)
  return rows[0]?.service ?? null
}

export async function getServiceForOwner(
  db: Db,
  serviceId: string,
  userId: string
): Promise<ServiceRow | null> {
  const rows = await db
    .select({ service: services })
    .from(services)
    .innerJoin(projects, eq(services.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        eq(memberships.role, "owner"),
        isNotNull(memberships.accepted_at)
      )
    )
    .where(eq(services.id, serviceId))
    .limit(1)
  return rows[0]?.service ?? null
}

export async function listServicesForOwner(
  db: Db,
  userId: string
): Promise<ServiceRow[]> {
  const rows = await db
    .select({ service: services })
    .from(services)
    .innerJoin(projects, eq(services.project_id, projects.id))
    .innerJoin(
      memberships,
      and(
        eq(memberships.org_id, projects.id),
        eq(memberships.user_id, userId),
        eq(memberships.role, "owner"),
        isNotNull(memberships.accepted_at)
      )
    )
  return rows.map((r) => r.service)
}

export async function insertService(
  db: Db,
  values: ServiceInsert
): Promise<ServiceRow> {
  await db.insert(services).values(values)
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.id, values.id!))
    .limit(1)
  return rows[0]!
}

export async function updateServiceStatus(
  db: Db,
  serviceId: string,
  status: NonNullable<ServiceRow["status"]>
): Promise<void> {
  await db
    .update(services)
    .set({ status, updated_at: new Date() })
    .where(eq(services.id, serviceId))
}

export async function updateServiceContainers(
  db: Db,
  serviceId: string,
  containerIds: string[]
): Promise<void> {
  await db
    .update(services)
    .set({ container_ids: containerIds, updated_at: new Date() })
    .where(eq(services.id, serviceId))
}

export async function updateServiceSwarmNames(
  db: Db,
  serviceId: string,
  swarmServiceNames: string[]
): Promise<void> {
  await db
    .update(services)
    .set({
      swarm_service_names: swarmServiceNames,
      container_ids: [],
      updated_at: new Date(),
    })
    .where(eq(services.id, serviceId))
}

export async function markServiceDeleting(
  db: Db,
  serviceId: string
): Promise<void> {
  await db
    .update(services)
    .set({ status: "deleting", updated_at: new Date() })
    .where(eq(services.id, serviceId))
}

export async function uniqueServiceSlug(
  db: Db,
  projectId: string,
  base: string,
  excludeServiceId?: string
): Promise<string> {
  let candidate = base || "service"
  let attempt = 1
  for (;;) {
    const existing = await db
      .select({ id: services.id })
      .from(services)
      .where(
        and(eq(services.project_id, projectId), eq(services.slug, candidate))
      )
      .limit(1)

    const conflict = existing.find((r) => r.id !== excludeServiceId)
    if (!conflict) return candidate
    attempt++
    candidate = `${base}-${attempt}`
  }
}
