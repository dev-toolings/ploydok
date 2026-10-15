// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { RiAddLine } from "@remixicon/react"
import { Badge } from "@workspace/ui/components/badge"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import { ShellPage, ShellPanel } from "../../../../components/layout/AppShell"
import { MembersTable } from "../../../../components/members/MembersTable"
import { InviteDialog } from "../../../../components/members/InviteDialog"
import { useMembers, useRevokeInvitation } from "../../../../lib/memberships"
import i18n from "../../../../lib/i18n"
import type { Invitation, Member } from "../../../../lib/memberships"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/members")({
  head: createPageHead("members"),
  component: MembersPage,
})

function MembersPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { orgSlug } = Route.useParams()
  const [inviteOpen, setInviteOpen] = React.useState(false)

  const { data, isLoading, error } = useMembers(orgSlug)
  const members: Array<Member> = data?.members ?? []
  const invitations: Array<Invitation> = data?.invitations ?? []

  const currentMember = members.find((m) => m.is_me)
  const isOwner = currentMember?.role === "owner"

  return (
    <ShellPage
      title={t("members.title")}
      description={t("members.description")}
      eyebrow={t("eyebrow")}
      actions={
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          <RiAddLine className="h-4 w-4" />
          {t("members.invite")}
        </Button>
      }
    >
      <div className="space-y-6">
        {/* Members section */}
        <ShellPanel
          title={t("members.title")}
          description={t("members.panelDescription")}
        >
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-16 skeleton-surface rounded-lg border border-border"
                />
              ))}
            </div>
          ) : error ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
              role="alert"
            >
              {t("members.loadFailed")}
            </p>
          ) : members.length > 0 ? (
            <MembersTable
              members={members}
              orgSlug={orgSlug}
              isOwner={isOwner}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-panel-border bg-panel-inset px-6 py-12 text-center">
              <p className="text-sm font-semibold text-foreground">
                {t("members.empty")}
              </p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("members.emptyHint")}
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Button size="sm" onClick={() => setInviteOpen(true)}>
                  {t("members.invite")}
                </Button>
              </div>
            </div>
          )}
        </ShellPanel>

        {/* Pending invitations section */}
        {invitations.length > 0 && (
          <ShellPanel
            title={t("members.pending")}
            description={t("members.pendingDescription")}
          >
            <div className="space-y-3">
              {invitations.map((invitation) => (
                <PendingInvitationRow
                  key={invitation.id}
                  invitation={invitation}
                  orgSlug={orgSlug}
                  isOwner={isOwner}
                />
              ))}
            </div>
          </ShellPanel>
        )}
      </div>

      <InviteDialog
        open={inviteOpen}
        orgSlug={orgSlug}
        onClose={() => setInviteOpen(false)}
      />
    </ShellPage>
  )
}

function formatRelativeTime(date: Date | string): string {
  const dateObj = typeof date === "string" ? new Date(date) : date
  const now = new Date()
  const seconds = Math.floor((now.getTime() - dateObj.getTime()) / 1000)

  if (seconds < 60) return i18n.t("common:relative.justNow")
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return i18n.t("common:relative.minutesAgo", { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18n.t("common:relative.hoursAgo", { count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return i18n.t("common:relative.daysAgo", { count: days })
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return i18n.t("common:relative.weeksAgo", { count: weeks })
  const months = Math.floor(days / 30)
  if (months < 12) return i18n.t("common:relative.monthsAgo", { count: months })
  const years = Math.floor(days / 365)
  return i18n.t("common:relative.yearsAgo", { count: years })
}

interface PendingInvitationRowProps {
  invitation: Invitation
  orgSlug: string
  isOwner: boolean
}

function PendingInvitationRow({
  invitation,
  orgSlug,
  isOwner,
}: PendingInvitationRowProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const revokeMutation = useRevokeInvitation()

  const expiresIn = formatRelativeTime(invitation.expires_at)

  const handleRevoke = () => {
    revokeMutation.mutate({ orgSlug, invitationId: invitation.id })
  }

  return (
    <div className="flex items-center justify-between rounded-xl border border-panel-border bg-panel-inset p-4 shadow-sm">
      <div className="flex-1">
        <p className="text-sm font-medium text-foreground">
          {invitation.email}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("members.expires", { when: expiresIn })}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="secondary">{invitation.role}</Badge>
        {isOwner && (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleRevoke}
            loading={revokeMutation.isPending}
          >
            {t("members.revoke")}
          </Button>
        )}
      </div>
    </div>
  )
}
