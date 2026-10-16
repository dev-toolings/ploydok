// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useInviteMember } from "../../lib/memberships"

interface InviteDialogProps {
  open: boolean
  orgSlug: string
  onClose: () => void
}

export function InviteDialog({
  open,
  orgSlug,
  onClose,
}: InviteDialogProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const [email, setEmail] = React.useState("")
  const [role, setRole] = React.useState<"member">("member")
  const [error, setError] = React.useState<string | null>(null)
  const inviteMutation = useInviteMember()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      setError(t("members.invalidEmail"))
      return
    }

    inviteMutation.mutate(
      { orgSlug, email, role },
      {
        onSuccess: () => {
          setEmail("")
          setRole("member")
          onClose()
        },
        onError: (err) => {
          const message =
            err instanceof Error ? err.message : t("members.inviteFailed")
          setError(message)
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={(newOpen) => !newOpen && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("members.inviteTitle")}</DialogTitle>
          <DialogDescription>
            {t("members.inviteDescription")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="email"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("members.emailAddress")}
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("members.emailPlaceholder")}
              className="h-9"
              required
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="role"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("members.role")}
            </label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as "member")}
            >
              <SelectTrigger id="role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t("members.member")}</SelectItem>
                <SelectItem value="owner" disabled>
                  {t("members.ownerLater")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && (
            <p
              className="rounded-md bg-neg-100 dark:bg-[#4d0218]/60 px-3 py-2 text-sm text-neg-700 dark:text-[#ff637e]"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={inviteMutation.isPending}
            >
              {t("common:cancel")}
            </Button>
            <Button
              type="submit"
              loading={inviteMutation.isPending}
              className="flex-1"
            >
              {inviteMutation.isPending
                ? t("members.sending")
                : t("members.sendInvitation")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
