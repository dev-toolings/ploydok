// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../../lib/page-metadata"
import {
  useCurrentOrganization,
  useDeleteOrganization,
  useOrganizations,
} from "../../../../../lib/organizations"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/settings/general")(
  {
  head: createPageHead("general"),
    component: GeneralSettingsPage,
  }
)

function GeneralSettingsPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { orgSlug } = Route.useParams()
  const organization = useCurrentOrganization()
  const { data: organizations } = useOrganizations()
  const deleteOrg = useDeleteOrganization()
  const navigate = useNavigate()

  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [confirmText, setConfirmText] = React.useState("")

  const expectedConfirm = organization?.name ?? ""
  const canDelete =
    confirmText.trim() === expectedConfirm.trim() && expectedConfirm.length > 0

  const handleDelete = async (): Promise<void> => {
    try {
      await deleteOrg.mutateAsync({ slug: orgSlug })
      setConfirmOpen(false)

      const remaining = (organizations ?? []).filter((o) => o.slug !== orgSlug)
      const next = remaining[0]
      if (next) {
        await navigate({
          to: "/orgs/$orgSlug/dashboard",
          params: { orgSlug: next.slug },
          replace: true,
        })
      } else {
        await navigate({ to: "/dashboard", replace: true })
      }
    } catch {
      // toast already raised by the mutation
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.identity")}</CardTitle>
          <CardDescription>{t("settings.identityHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-name">{t("settings.name")}</Label>
            <Input
              id="ws-name"
              readOnly
              value={organization?.name ?? ""}
              className="bg-muted/40"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ws-slug">{t("settings.slug")}</Label>
            <Input
              id="ws-slug"
              readOnly
              value={organization?.slug ?? ""}
              className="bg-muted/40 font-mono text-sm"
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">{t("settings.danger")}</CardTitle>
          <CardDescription>{t("settings.dangerHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirmText("")
              setConfirmOpen(true)
            }}
            disabled={!organization}
          >
            {t("settings.delete")}
          </Button>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!deleteOrg.isPending) setConfirmOpen(open)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.deleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  {t("settings.deleteBody", {
                    name: organization?.name ?? orgSlug,
                  })}
                </p>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="confirm-name"
                    className="text-xs font-medium text-foreground"
                  >
                    {t("settings.typeToConfirm", { name: expectedConfirm })}
                  </Label>
                  <Input
                    id="confirm-name"
                    autoFocus
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={expectedConfirm}
                    autoComplete="off"
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteOrg.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              loading={deleteOrg.isPending} disabled={!canDelete}
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
              className="bg-none bg-destructive text-white hover:bg-destructive/90"
            >
              {deleteOrg.isPending
                ? t("settings.deleting")
                : t("settings.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
