// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import type { Db } from "@ploydok/db"
import {
  createOrganizationForUser,
  ensureDefaultOrganizationForUser,
  ensureFreeOrgSubscription,
} from "./organizations"

type InsertCall = { table: unknown; values: Record<string, unknown> }

function selectChain(rows: unknown[] = []) {
  const chain: Record<string, unknown> = {}
  const next = () => chain
  chain.from = next
  chain.where = next
  chain.orderBy = next
  chain.limit = next
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(rows).then(resolve, reject)
  return chain
}

type FakeOrgDb = {
  transaction: <T>(cb: (tx: FakeOrgDb) => Promise<T>) => Promise<T>
  select: () => ReturnType<typeof selectChain>
  insert: (table: unknown) => {
    values: (values: Record<string, unknown>) => {
      returning: () => Promise<Record<string, unknown>[]>
      onConflictDoNothing: () => Promise<undefined>
    }
  }
  update: () => {
    set: (patch: Record<string, unknown>) => {
      where: () => {
        returning: () => Promise<Record<string, unknown>[]>
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown
        ) => Promise<unknown>
      }
    }
  }
  query: {
    org_subscriptions: {
      findFirst: () => Promise<unknown>
    }
  }
}

function createFakeOrgDb(opts?: { existingSubscription?: unknown }) {
  const inserts: InsertCall[] = []
  const updates: Record<string, unknown>[] = []

  const api: FakeOrgDb = {
    transaction: async (cb) => cb(api),
    select: () => selectChain([]),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values })
        const rows = [{ ...values }]
        return {
          returning: async () => rows,
          onConflictDoNothing: async () => undefined,
        }
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch)
        const whereChain = {
          returning: async () => [patch],
          then: (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve([]).then(resolve, reject),
        }
        return { where: () => whereChain }
      },
    }),
    query: {
      org_subscriptions: {
        findFirst: async () => opts?.existingSubscription ?? null,
      },
    },
  }

  return { db: api as unknown as Db, inserts, updates }
}

function freeSubscriptionInserts(inserts: InsertCall[]) {
  return inserts.filter(
    (call) =>
      call.values.plan_slug === "free" && typeof call.values.org_id === "string"
  )
}

describe("ensureFreeOrgSubscription", () => {
  it("inserts an active free subscription for the given org", async () => {
    const { db, inserts } = createFakeOrgDb()
    const orgId = "org-created-1"

    await ensureFreeOrgSubscription(db, orgId)

    const subs = freeSubscriptionInserts(inserts)
    expect(subs).toHaveLength(1)
    expect(subs[0]?.values.org_id).toBe(orgId)
    expect(subs[0]?.values.plan_slug).toBe("free")
    expect(subs[0]?.values.status).toBe("active")
    expect(typeof subs[0]?.values.id).toBe("string")
    expect(String(subs[0]?.values.id).length).toBeGreaterThan(0)
    expect(String(subs[0]?.values.id)).not.toMatch(/,/)
  })

  it("is a no-op when a subscription already exists", async () => {
    const orgId = "org-already-paid"
    const { db, inserts, updates } = createFakeOrgDb({
      existingSubscription: {
        id: "sub-1",
        org_id: orgId,
        plan_slug: "pro",
        status: "active",
      },
    })

    await ensureFreeOrgSubscription(db, orgId)

    expect(freeSubscriptionInserts(inserts)).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })
})

describe("createOrganizationForUser", () => {
  it("grants the Free plan to the org that was actually inserted", async () => {
    const { db, inserts } = createFakeOrgDb()

    const org = await createOrganizationForUser(db, "user-1", "Acme")

    expect(org.name).toBe("Acme")
    expect(typeof org.id).toBe("string")
    expect(org.id.length).toBeGreaterThan(0)

    const matching = freeSubscriptionInserts(inserts).filter(
      (call) => call.values.org_id === org.id
    )
    expect(matching).toHaveLength(1)
    expect(matching[0]?.values.plan_slug).toBe("free")
    expect(matching[0]?.values.status).toBe("active")
  })
})

describe("ensureDefaultOrganizationForUser", () => {
  it("grants the Free plan when inserting the default org", async () => {
    const { db, inserts } = createFakeOrgDb()

    const org = await ensureDefaultOrganizationForUser(db, "user-1", "Ada")

    expect(org.id).toBeTruthy()
    const matching = freeSubscriptionInserts(inserts).filter(
      (call) => call.values.org_id === org.id
    )
    expect(matching).toHaveLength(1)
    expect(matching[0]?.values.plan_slug).toBe("free")
    expect(matching[0]?.values.status).toBe("active")
  })
})
