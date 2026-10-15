// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock, beforeEach } from "bun:test"
import { Hono } from "hono"
import type { Db } from "@ploydok/db"
import type { MemberListItem } from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"

type InvitationRow = {
  id: string
  org_id: string
  email?: string
  role?: string
  token_hash?: string
  invited_by?: string
  expires_at?: Date
  accepted_at?: Date | null
}

type InvitationColumn = "id" | "org_id"

const memberRows: MemberListItem[] = []
const invitationRows: InvitationRow[] = []
const createdInvitations: InvitationRow[] = []
const outboxEvents: Array<{
  id: string
  delivered_at: Date | null
  dead_lettered_at?: Date | null
  lease_until?: Date | null
  available_at: Date
}> = []
let outboxFailure = false
const invitationColumns = new Set<InvitationColumn>(["id", "org_id"])

mock.module("@ploydok/db", () => ({
  membership_invitations: {
    id: "id",
    org_id: "org_id",
  },
  projects: {
    id: "id",
    slug: "slug",
  },
}))

mock.module("@ploydok/db/queries", () => ({
  countOwners: async () => 2,
  createInvitation: async (_db: Db, values: InvitationRow) => {
    const invitation = { ...values, accepted_at: null }
    createdInvitations.push(invitation)
    return invitation
  },
  deleteExpiredInvitations: async (
    _db: Db,
    options: { now: Date; orgId: string; email: string }
  ) => {
    const before = createdInvitations.length
    for (let index = createdInvitations.length - 1; index >= 0; index -= 1) {
      const row = createdInvitations[index]!
      if (
        row.org_id === options.orgId &&
        row.email === options.email &&
        row.accepted_at == null &&
        row.expires_at &&
        row.expires_at <= options.now
      ) {
        createdInvitations.splice(index, 1)
      }
    }
    return before - createdInvitations.length
  },
  deleteInvitationUnlessDeliveryActive: async (
    _db: Db,
    invitationId: string,
    orgId: string
  ) => {
    const index = invitationRows.findIndex(
      (row) => row.id === invitationId && row.org_id === orgId
    )
    if (index < 0) return "not-found"
    const event = outboxEvents.find(
      (candidate) => candidate.id === `invitation-email:${invitationId}`
    )
    if (event?.lease_until && event.lease_until > new Date()) return "busy"
    invitationRows.splice(index, 1)
    const eventIndex = outboxEvents.indexOf(event!)
    if (eventIndex >= 0) outboxEvents.splice(eventIndex, 1)
    return "deleted"
  },
  findPendingInvitationByEmail: async (_db: Db, orgId: string, email: string) =>
    createdInvitations.find(
      (row) =>
        row.org_id === orgId &&
        row.email === email &&
        row.accepted_at == null &&
        row.expires_at &&
        row.expires_at > new Date()
    ) ?? null,
  getOutboxEvent: async (_db: Db, id: string) =>
    outboxEvents.find((event) => event.id === id) ?? null,
  insertOutboxEvent: async (
    _db: Db,
    values: { id: string; available_at?: Date }
  ) => {
    if (outboxFailure) throw new Error("outbox unavailable")
    const event = {
      id: values.id,
      delivered_at: null,
      available_at: values.available_at ?? new Date(),
    }
    outboxEvents.push(event)
    return event
  },
  makeOutboxEventAvailable: async (_db: Db, id: string) => {
    const event = outboxEvents.find((candidate) => candidate.id === id)
    if (!event || event.delivered_at) return false
    event.available_at = new Date()
    return true
  },
  getMembership: async () => ({ role: "owner", accepted_at: new Date() }),
  isOrgOwner: async () => true,
  listMembershipsForOrg: async () => memberRows,
  listPendingInvitationsForOrg: async () => [],
  removeMembership: async () => undefined,
  updateMembershipRole: async () => undefined,
}))

mock.module("../mailer", () => ({
  renderInvitationEmail: () => ({ subject: "Invite", html: "", text: "" }),
}))

mock.module("../secrets/crypto", () => ({
  encryptSecret: async () => ({
    enc: Buffer.from("encrypted"),
    nonce: Buffer.from("nonce"),
  }),
}))

const { membership_invitations } = await import("@ploydok/db")
const { createMembershipsRouter } = await import("./memberships")

const fakeUser: AuthUser = {
  id: "owner-user",
  email: "owner@example.com",
  display_name: "Owner",
  session_id: "session-1",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function queryChunks(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value["queryChunks"])) {
    return value["queryChunks"]
  }
  return []
}

function stringChunk(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value["value"])) {
    return null
  }
  const parts = value["value"]
  return parts.every((part) => typeof part === "string") ? parts.join("") : null
}

function columnName(value: unknown): InvitationColumn | null {
  if (
    typeof value === "string" &&
    invitationColumns.has(value as InvitationColumn)
  ) {
    return value as InvitationColumn
  }

  const chunk = stringChunk(value)
  if (chunk && invitationColumns.has(chunk as InvitationColumn)) {
    return chunk as InvitationColumn
  }

  if (isRecord(value) && typeof value["name"] === "string") {
    const name = value["name"]
    return invitationColumns.has(name as InvitationColumn)
      ? (name as InvitationColumn)
      : null
  }

  return null
}

function paramValue(value: unknown): unknown {
  if (typeof value === "string") return value
  if (isRecord(value) && "encoder" in value && "value" in value) {
    return value["value"]
  }
  return undefined
}

function collectEquals(condition: unknown): Partial<InvitationRow> {
  const equals: Partial<InvitationRow> = {}
  const chunks = queryChunks(condition)

  for (const chunk of chunks) {
    if (queryChunks(chunk).length > 0) {
      Object.assign(equals, collectEquals(chunk))
    }
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const name = columnName(chunks[index])
    if (!name) continue
    const operator = stringChunk(chunks[index + 1])?.trim()
    if (operator === "=") {
      const value = paramValue(chunks[index + 2])
      if (typeof value === "string") {
        equals[name] = value
      }
    }
  }

  return equals
}

function buildDb(): Db {
  const db: Record<string, unknown> = {
    select: () => {
      const chain = {
        from() {
          return chain
        },
        where() {
          return chain
        },
        limit: async () => [{ id: "org-a" }],
      }
      return chain
    },
    delete: (table: unknown) => ({
      where: (condition: unknown) => ({
        returning: async () => {
          if (table !== membership_invitations) return []
          const filters = collectEquals(condition)
          const deleted: Array<{ id: string }> = []
          for (let index = invitationRows.length - 1; index >= 0; index -= 1) {
            const row = invitationRows[index]
            if (
              row &&
              row.id === filters.id &&
              (!filters.org_id || row.org_id === filters.org_id)
            ) {
              invitationRows.splice(index, 1)
              const outboxIndex = outboxEvents.findIndex(
                (event) => event.id === `invitation-email:${row.id}`
              )
              if (outboxIndex >= 0) outboxEvents.splice(outboxIndex, 1)
              deleted.push({ id: row.id })
            }
          }
          return deleted
        },
      }),
    }),
    transaction: async (callback: (tx: Db) => Promise<unknown>) => {
      const invitationCount = createdInvitations.length
      const outboxCount = outboxEvents.length
      try {
        return await callback(db as unknown as Db)
      } catch (error) {
        createdInvitations.length = invitationCount
        outboxEvents.length = outboxCount
        throw error
      }
    },
  }

  return db as unknown as Db
}

function buildApp(db: Db, user: AuthUser = fakeUser) {
  const app = new Hono<{ Variables: { user: AuthUser } }>()
  app.use("*", async (c, next) => {
    c.set("user", user)
    await next()
  })
  app.route("/", createMembershipsRouter(db))
  return app
}

beforeEach(() => {
  memberRows.length = 0
  invitationRows.length = 0
  createdInvitations.length = 0
  outboxEvents.length = 0
  outboxFailure = false
})

describe("GET /:orgId/members", () => {
  it("sets is_me true only for the caller on each request", async () => {
    memberRows.push(
      ...[fakeUser.id, "other-owner", "member-user"].map((userId) => ({
        user_id: userId,
        role: userId === "member-user" ? "member" : "owner",
        invited_at: new Date(),
        accepted_at: new Date(),
        user: { email: `${userId}@example.com`, display_name: userId },
      }))
    )

    for (const callerId of [fakeUser.id, "member-user"]) {
      const response = await buildApp(buildDb(), {
        ...fakeUser,
        id: callerId,
      }).request("/org-a/members")

      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        members: Array<{ user_id: string; is_me: boolean }>
        pending_invitations: unknown[]
      }
      expect(
        body.members.map((member) => ({
          user_id: member.user_id,
          is_me: member.is_me,
        }))
      ).toEqual(
        memberRows.map((member) => ({
          user_id: member.user_id,
          is_me: member.user_id === callerId,
        }))
      )
      expect(body.pending_invitations).toEqual([])
    }
    expect(memberRows.every((member) => !("is_me" in member))).toBe(true)
  })
})

describe("POST /:orgId/members/invite", () => {
  it("keeps one active pending invitation per normalized org email", async () => {
    createdInvitations.push({
      id: "active",
      org_id: "org-a",
      email: "member@example.com",
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: null,
    })

    const res = await buildApp(buildDb()).request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Member@Example.com", role: "member" }),
    })

    expect(res.status).toBe(409)
    expect(createdInvitations).toHaveLength(1)
    expect(createdInvitations[0]?.id).toBe("active")
  })

  it("removes an expired pending row before reinviting the same email", async () => {
    createdInvitations.push({
      id: "expired",
      org_id: "org-a",
      email: "member@example.com",
      expires_at: new Date(Date.now() - 60_000),
      accepted_at: null,
    })

    const res = await buildApp(buildDb()).request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Member@Example.com", role: "member" }),
    })

    expect(res.status).toBe(202)
    expect(createdInvitations).toHaveLength(1)
    expect(createdInvitations[0]).toMatchObject({
      org_id: "org-a",
      email: "member@example.com",
    })
    expect(createdInvitations[0]?.id).not.toBe("expired")
    expect(outboxEvents).toHaveLength(1)
  })

  it("rolls the invitation back when its outbox event cannot be persisted", async () => {
    const app = buildApp(buildDb())
    outboxFailure = true
    const failed = await app.request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    })

    expect(failed.status).toBe(500)
    expect(createdInvitations).toHaveLength(0)
    expect(outboxEvents).toHaveLength(0)

    outboxFailure = false
    const retried = await app.request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    })
    expect(retried.status).toBe(202)
    expect(createdInvitations).toHaveLength(1)
    expect(outboxEvents).toHaveLength(1)
  })

  it("returns the existing queued delivery on an idempotent request retry", async () => {
    createdInvitations.push({
      id: "active",
      org_id: "org-a",
      email: "member@example.com",
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: null,
    })
    outboxEvents.push({
      id: "invitation-email:active",
      delivered_at: null,
      available_at: new Date(Date.now() + 60_000),
    })

    const res = await buildApp(buildDb()).request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "Member@Example.com", role: "member" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ delivery_status: "queued" })
    expect(createdInvitations).toHaveLength(1)
    expect(outboxEvents).toHaveLength(1)
  })

  it("does not resend an already delivered invitation", async () => {
    createdInvitations.push({
      id: "delivered",
      org_id: "org-a",
      email: "member@example.com",
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: null,
    })
    outboxEvents.push({
      id: "invitation-email:delivered",
      delivered_at: new Date(),
      available_at: new Date(),
    })

    const res = await buildApp(buildDb()).request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ delivery_status: "delivered" })
    expect(outboxEvents).toHaveLength(1)
  })

  it("requires revoke before retrying a dead-lettered invitation", async () => {
    createdInvitations.push({
      id: "failed",
      org_id: "org-a",
      email: "member@example.com",
      expires_at: new Date(Date.now() + 60_000),
      accepted_at: null,
    })
    outboxEvents.push({
      id: "invitation-email:failed",
      delivered_at: null,
      dead_lettered_at: new Date(),
      available_at: new Date(),
    })

    const res = await buildApp(buildDb()).request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: { code: "INVITATION_DELIVERY_FAILED" },
    })
  })
})

describe("DELETE /:orgId/invitations/:invitationId", () => {
  it("returns a retryable conflict while SMTP owns the delivery lease", async () => {
    invitationRows.push({ id: "sending", org_id: "org-a" })
    outboxEvents.push({
      id: "invitation-email:sending",
      delivered_at: null,
      lease_until: new Date(Date.now() + 60_000),
      available_at: new Date(),
    })

    const res = await buildApp(buildDb()).request(
      "/org-a/invitations/sending",
      { method: "DELETE" }
    )

    expect(res.status).toBe(409)
    expect(res.headers.get("retry-after")).toBe("5")
    expect(await res.json()).toMatchObject({
      error: { code: "INVITATION_DELIVERY_ACTIVE" },
    })
    expect(invitationRows).toHaveLength(1)
    expect(outboxEvents).toHaveLength(1)
  })

  it("cancels the linked outbox event before reinviting", async () => {
    invitationRows.push({ id: "old", org_id: "org-a" })
    outboxEvents.push({
      id: "invitation-email:old",
      delivered_at: null,
      available_at: new Date(),
    })
    const app = buildApp(buildDb())

    expect(
      (await app.request("/org-a/invitations/old", { method: "DELETE" })).status
    ).toBe(200)
    expect(outboxEvents).toHaveLength(0)

    const reinvite = await app.request("/org-a/members/invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", role: "member" }),
    })
    expect(reinvite.status).toBe(202)
    expect(outboxEvents).toHaveLength(1)
    expect(outboxEvents[0]?.id).not.toBe("invitation-email:old")
  })

  it("returns 404 when the invitation belongs to another org", async () => {
    invitationRows.push({ id: "inv-cross", org_id: "org-b" })
    const app = buildApp(buildDb())

    const res = await app.request("/org-a/invitations/inv-cross", {
      method: "DELETE",
    })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Invitation not found" },
    })
    expect(invitationRows).toEqual([{ id: "inv-cross", org_id: "org-b" }])
  })
})
