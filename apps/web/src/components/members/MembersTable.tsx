// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiDeleteBin6Line, RiLoader4Line } from "@remixicon/react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { DataTable } from "@workspace/ui/components/data-table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useTranslation } from "react-i18next"
import { useRemoveMember, useUpdateMemberRole } from "../../lib/memberships"
import { RemoveMemberDialog } from "./RemoveMemberDialog"
import type { ColumnDef } from "@workspace/ui/components/data-table"
import type { Member } from "../../lib/memberships"

interface MemberCellProps {
  member: Member
  orgSlug: string
  isOwner: boolean
}

export function MembersTable({
  members,
  orgSlug,
  isOwner,
}: Omit<MemberCellProps, "member"> & {
  members: Array<Member>
}): React.JSX.Element {
  const { t, i18n } = useTranslation("workspace")
  const columns = React.useMemo<Array<ColumnDef<Member>>>(
    () => [
      {
        id: "name",
        accessorFn: (member) => member.user.display_name,
        header: t("members.name"),
        cell: ({ row: { original: member } }) => (
          <div className="flex min-w-40 items-center gap-3">
            <div
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary"
            >
              {member.user.display_name.charAt(0).toUpperCase()}
            </div>
            <span className="font-medium">
              {member.user.display_name}
              {member.is_me && (
                <span className="ml-2 text-xs text-muted-foreground">
                  {t("members.you")}
                </span>
              )}
            </span>
          </div>
        ),
      },
      {
        id: "email",
        accessorFn: (member) => member.user.email,
        header: t("members.email"),
        cell: ({ row }) => (
          <span className="break-all text-muted-foreground">
            {row.original.user.email}
          </span>
        ),
      },
      {
        accessorKey: "role",
        header: t("members.role"),
        cell: ({ row }) => (
          <MemberRole
            member={row.original}
            orgSlug={orgSlug}
            isOwner={isOwner}
          />
        ),
      },
      {
        accessorKey: "invited_at",
        header: t("members.addedAt"),
        cell: ({ row }) => {
          const date = new Date(row.original.invited_at)
          return (
            <time
              dateTime={date.toISOString()}
              className="whitespace-nowrap text-muted-foreground tabular-nums"
            >
              {date.toLocaleDateString(i18n.resolvedLanguage)}
            </time>
          )
        },
      },
      ...(isOwner
        ? [
            {
              id: "actions",
              header: t("members.actions"),
              cell: ({ row }) =>
                row.original.is_me ? null : (
                  <MemberActions
                    member={row.original}
                    orgSlug={orgSlug}
                    isOwner={isOwner}
                  />
                ),
            } satisfies ColumnDef<Member>,
          ]
        : []),
    ],
    [t, i18n.resolvedLanguage, orgSlug, isOwner]
  )

  return (
    <DataTable
      columns={columns}
      rows={members}
      paginate={false}
      className="min-w-0"
    />
  )
}

function MemberRole({
  member,
  orgSlug,
  isOwner,
}: MemberCellProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const updateRoleMutation = useUpdateMemberRole()

  if (!isOwner || member.is_me) {
    return (
      <Badge variant="outline">
        {t(member.role === "owner" ? "members.owner" : "members.member")}
      </Badge>
    )
  }

  return (
    <Select
      value={member.role}
      disabled={updateRoleMutation.isPending}
      onValueChange={(role: "member" | "owner") =>
        updateRoleMutation.mutate({ orgSlug, userId: member.user_id, role })
      }
    >
      <SelectTrigger
        className="w-36"
        aria-label={t("members.role")}
        aria-busy={updateRoleMutation.isPending}
      >
        {updateRoleMutation.isPending ? (
          <span className="flex items-center gap-2">
            <RiLoader4Line aria-hidden="true" className="size-4 animate-spin" />
            {t(member.role === "owner" ? "members.owner" : "members.member")}
          </span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="member">{t("members.member")}</SelectItem>
        <SelectItem value="owner">{t("members.owner")}</SelectItem>
      </SelectContent>
    </Select>
  )
}

function MemberActions({
  member,
  orgSlug,
}: MemberCellProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const [removeDialogOpen, setRemoveDialogOpen] = React.useState(false)
  const removeMutation = useRemoveMember()

  const handleRemove = () => {
    setRemoveDialogOpen(true)
  }

  const confirmRemove = () => {
    removeMutation.mutate({ orgSlug, userId: member.user_id })
    setRemoveDialogOpen(false)
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={t("members.removeTitle")}
        onClick={handleRemove}
        loading={removeMutation.isPending}
      >
        <RiDeleteBin6Line className="h-4 w-4" />
      </Button>

      <RemoveMemberDialog
        open={removeDialogOpen}
        member={member}
        onConfirm={confirmRemove}
        onCancel={() => setRemoveDialogOpen(false)}
        isLoading={removeMutation.isPending}
      />
    </>
  )
}
