// SPDX-License-Identifier: AGPL-3.0-only
import { nanoid } from "nanoid"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import type { Db } from "@ploydok/db"
import { projects } from "@ploydok/db"
import {
  listMembershipsForOrg,
  getMembership,
  removeMembership,
  updateMembershipRole,
  countOwners,
} from "@ploydok/db/queries"
import {
  InviteBodySchema,
  UpdateRoleBodySchema,
  MembersListResponseSchema,
} from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"
import { requireRole } from "../auth/require-role"
import { renderInvitationEmail } from "../mailer"
import { env } from "../env"
import {
  createInvitation,
  deleteInvitationUnlessDeliveryActive,
  deleteExpiredInvitations,
  findPendingInvitationByEmail,
  getOutboxEvent,
  insertOutboxEvent,
  listPendingInvitationsForOrg,
  makeOutboxEventAvailable,
} from "@ploydok/db/queries"
import { createHash } from "crypto"
import { encryptSecret } from "../secrets/crypto"

class InvitationAlreadyPendingError extends Error {}
class InvitationDeliveryDeadLetterError extends Error {}

function getUser(c: { get: (key: string) => unknown }): AuthUser {
  return c.get("user") as AuthUser
}

// Resolved by requireRole from the :orgId param (slug or id).
function getOrgId(c: { get: (key: string) => unknown }): string {
  return c.get("org_id") as string
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function createMembershipsRouter(db: Db): Hono {
  const router = new Hono()

  // GET /orgs/:slug/members — list members and pending invitations
  router.get(
    "/:orgId/members",
    requireRole(db, ["owner", "member"]),
    async (c) => {
      const user = getUser(c)
      const orgId = getOrgId(c)
      const members = await listMembershipsForOrg(db, orgId)
      const pendingInvitations = await listPendingInvitationsForOrg(db, orgId)

      const response = MembersListResponseSchema.parse({
        members: members.map((member) => ({
          ...member,
          is_me: member.user_id === user.id,
        })),
        pending_invitations: pendingInvitations,
      })

      return c.json(response)
    }
  )

  // POST /orgs/:slug/members/invite — invite a member (owner only)
  router.post(
    "/:orgId/members/invite",
    requireRole(db, ["owner"]),
    async (c) => {
      const user = getUser(c)
      const orgId = getOrgId(c)

      const body = await c.req.json().catch(() => null)
      const parsed = InviteBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Invalid invite payload",
            },
          },
          400
        )
      }

      const invitationEmail = parsed.data.email.trim().toLowerCase()

      // Generate token and hash
      const token = await import("crypto").then((m) =>
        m.randomBytes(32).toString("base64url")
      )
      const tokenHash = hashToken(token)

      // Expired rows are removed before insertion because PostgreSQL partial
      // index predicates cannot safely depend on the current clock.
      const expiresAt = new Date()
      expiresAt.setDate(expiresAt.getDate() + 7)
      const orgRows = await db
        .select()
        .from(projects)
        .where(eq(projects.id, orgId))
        .limit(1)
      const org = orgRows[0]
      if (!org) {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Organization not found" } },
          404
        )
      }

      const invitationId = nanoid()
      const outboxEventId = `invitation-email:${invitationId}`
      const acceptUrl = `${env.WEB_ORIGIN}/invitations/accept?token=${token}`
      const emailContent = renderInvitationEmail({
        orgName: org.name,
        inviterName: user.display_name,
        acceptUrl,
        expiresAt,
      })
      const encryptedPayload = await encryptSecret(
        JSON.stringify({
          kind: "mail",
          invitationId,
          to: invitationEmail,
          subject: emailContent.subject,
          text: emailContent.text,
          html: emailContent.html,
          messageId: `<invitation-${invitationId}@ploydok.local>`,
        })
      )

      let result: {
        invitation: Awaited<ReturnType<typeof createInvitation>>
        deliveryStatus: "queued" | "delivered"
        created: boolean
      }
      try {
        result = await db.transaction(async (tx) => {
          await deleteExpiredInvitations(tx, {
            now: new Date(),
            orgId,
            email: invitationEmail,
          })
          const existing = await findPendingInvitationByEmail(
            tx,
            orgId,
            invitationEmail
          )
          if (existing) {
            const existingEventId = `invitation-email:${existing.id}`
            const existingEvent = await getOutboxEvent(tx, existingEventId)
            if (!existingEvent) throw new InvitationAlreadyPendingError()
            if (existingEvent.dead_lettered_at) {
              throw new InvitationDeliveryDeadLetterError()
            }
            if (existingEvent.delivered_at) {
              return {
                invitation: existing,
                deliveryStatus: "delivered" as const,
                created: false,
              }
            }
            await makeOutboxEventAvailable(tx, existingEventId)
            return {
              invitation: existing,
              deliveryStatus: "queued" as const,
              created: false,
            }
          }

          const created = await createInvitation(tx, {
            id: invitationId,
            org_id: orgId,
            email: invitationEmail,
            role: parsed.data.role,
            token_hash: tokenHash,
            invited_by: user.id,
            expires_at: expiresAt,
          })
          await insertOutboxEvent(tx, {
            id: outboxEventId,
            invitation_id: invitationId,
            topic: "mail.invitation",
            payload_ciphertext: encryptedPayload.enc,
            payload_nonce: encryptedPayload.nonce,
          })
          return {
            invitation: created,
            deliveryStatus: "queued" as const,
            created: true,
          }
        })
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : null
        if (
          error instanceof InvitationAlreadyPendingError ||
          code === "23505"
        ) {
          return c.json(
            {
              error: {
                code: "CONFLICT",
                message: "Invitation already pending for this email",
              },
            },
            409
          )
        }
        if (error instanceof InvitationDeliveryDeadLetterError) {
          return c.json(
            {
              error: {
                code: "INVITATION_DELIVERY_FAILED",
                message: "Revoke this invitation before sending a new one",
              },
            },
            409
          )
        }
        throw error
      }

      const { invitation, deliveryStatus, created } = result
      return c.json(
        {
          invitation: {
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            expires_at: invitation.expires_at.toISOString(),
          },
          delivery_status: deliveryStatus,
        },
        created ? 202 : 200
      )
    }
  )

  // DELETE /orgs/:slug/members/:userId — remove member (owner only)
  router.delete(
    "/:orgId/members/:userId",
    requireRole(db, ["owner"]),
    async (c) => {
      const user = getUser(c)
      const orgId = getOrgId(c)
      const userId = c.req.param("userId")!

      // Prevent self-removal if sole owner (keeps the ">= 1 owner" invariant)
      if (user.id === userId) {
        const ownerCount = await countOwners(db, orgId)
        if (ownerCount <= 1) {
          return c.json(
            {
              error: {
                code: "BAD_REQUEST",
                message: "Cannot remove yourself while being the sole owner",
              },
            },
            400
          )
        }
      }

      await removeMembership(db, orgId, userId)
      return c.json({})
    }
  )

  // PATCH /orgs/:slug/members/:userId/role — update member role (owner only)
  router.patch(
    "/:orgId/members/:userId/role",
    requireRole(db, ["owner"]),
    async (c) => {
      const orgId = getOrgId(c)
      const userId = c.req.param("userId")!

      const body = await c.req.json().catch(() => null)
      const parsed = UpdateRoleBodySchema.safeParse(body)
      if (!parsed.success) {
        return c.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "Invalid role payload",
            },
          },
          400
        )
      }

      // Prevent downgrading the sole owner (keeps the ">= 1 owner" invariant)
      if (parsed.data.role === "member") {
        const memberToChange = await getMembership(db, orgId, userId)
        if (memberToChange?.role === "owner") {
          const ownerCount = await countOwners(db, orgId)
          if (ownerCount <= 1) {
            return c.json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: "Cannot downgrade the sole owner",
                },
              },
              400
            )
          }
        }
      }

      await updateMembershipRole(db, orgId, userId, parsed.data.role)
      return c.json({})
    }
  )

  // DELETE /orgs/:slug/invitations/:invitationId — cancel invitation (owner only)
  router.delete(
    "/:orgId/invitations/:invitationId",
    requireRole(db, ["owner"]),
    async (c) => {
      const orgId = getOrgId(c)
      const invitationId = c.req.param("invitationId")!

      // The conditional delete and outbox cascade share one transaction. A
      // 409 means SMTP may still be in flight, so a later retry is safe.
      const deletion = await db.transaction((tx) =>
        deleteInvitationUnlessDeliveryActive(tx, invitationId, orgId)
      )

      if (deletion === "busy") {
        c.header("Retry-After", "5")
        return c.json(
          {
            error: {
              code: "INVITATION_DELIVERY_ACTIVE",
              message: "Invitation delivery is active; retry revocation",
            },
          },
          409
        )
      }
      if (deletion === "not-found") {
        return c.json(
          { error: { code: "NOT_FOUND", message: "Invitation not found" } },
          404
        )
      }

      return c.json({})
    }
  )

  return router
}
