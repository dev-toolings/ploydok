// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

export type Role = "owner" | "member"

export const RoleSchema = z.enum(["owner", "member"])

export const MembershipRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  user_id: z.string(),
  role: z.string(), // 'owner' | 'member'
  invited_by: z.string().nullable(),
  invited_at: z.date(),
  accepted_at: z.date().nullable(),
})
export type MembershipRow = z.infer<typeof MembershipRowSchema>

export const MemberListItemSchema = z.object({
  user_id: z.string(),
  role: z.string(),
  invited_at: z.date(),
  accepted_at: z.date().nullable(),
  user: z.object({
    email: z.string(),
    display_name: z.string(),
  }),
})
export type MemberListItem = z.infer<typeof MemberListItemSchema>

export const InvitationRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  email: z.string().email(),
  role: z.string(),
  token_hash: z.string(),
  expires_at: z.date(),
  invited_by: z.string(),
  accepted_at: z.date().nullable(),
  created_at: z.date(),
})
export type InvitationRow = z.infer<typeof InvitationRowSchema>

export const InviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(["member"]),
})
export type InviteBody = z.infer<typeof InviteBodySchema>

export const UpdateRoleBodySchema = z.object({
  role: z.enum(["owner", "member"]),
})
export type UpdateRoleBody = z.infer<typeof UpdateRoleBodySchema>

export const AcceptInvitationBodySchema = z.object({
  token: z.string().min(1),
})
export type AcceptInvitationBody = z.infer<typeof AcceptInvitationBodySchema>

export const RegisterFromInvitationBodySchema = z.object({
  token: z.string().min(1),
  display_name: z.string().trim().min(1).max(120),
  password: z.string().min(1),
})
export type RegisterFromInvitationBody = z.infer<
  typeof RegisterFromInvitationBodySchema
>

export const RegisterFromInvitationResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().email(),
    display_name: z.string(),
  }),
  accessExpiresAt: z.number(),
  organization: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
})
export type RegisterFromInvitationResponse = z.infer<
  typeof RegisterFromInvitationResponseSchema
>

export const InvitationPreviewSchema = z.object({
  org_name: z.string(),
  inviter_email: z.string(),
  role: z.string(),
  email: z.string(),
  expires_at: z.string().datetime(),
})
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>

export const InvitationAcceptResponseSchema = z.object({
  organization: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
})
export type InvitationAcceptResponse = z.infer<
  typeof InvitationAcceptResponseSchema
>

export const MembersListResponseSchema = z.object({
  members: z.array(MemberListItemSchema.extend({ is_me: z.boolean() })),
  pending_invitations: z.array(InvitationRowSchema),
})
export type MembersListResponse = z.infer<typeof MembersListResponseSchema>

export const CreateInvitationResponseSchema = z.object({
  invitation: z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    expires_at: z.string().datetime(),
  }),
  delivery_status: z.enum(["queued", "delivered"]),
})
export type CreateInvitationResponse = z.infer<
  typeof CreateInvitationResponseSchema
>
