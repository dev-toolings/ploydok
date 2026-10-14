// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, useNavigate } from "@tanstack/react-router"
import { RiArrowRightSLine, RiBuilding2Line } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Skeleton } from "@workspace/ui/components/skeleton"
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
import {
  useDeleteOrganization,
  useOrganizations,
} from "../../lib/organizations"
import type { OrganizationSummary } from "@ploydok/shared"

export function WorkspacesSection(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: organizations, isLoading } = useOrganizations()

  return (
    <section
      aria-label={t("workspace.listTitle")}
      className="rounded-2xl rounded-xl bg-panel p-5"
    >
      <header className="mb-4 flex items-start justify-between gap-4">
        <div>
          <p className="font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
            {t("account")}
          </p>
          <h2 className="mt-1 text-base font-semibold text-foreground">
            {t("workspace.listTitle")}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t("workspace.listDescription")}
          </p>
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-md" />
          <Skeleton className="h-14 w-full rounded-md" />
        </div>
      ) : organizations && organizations.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border">
          {organizations.map((org) => (
            <WorkspaceRow key={org.id} organization={org} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{t("workspace.empty")}</p>
      )}
    </section>
  )
}

function WorkspaceRow({
  organization,
}: {
  organization: OrganizationSummary
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const deleteOrg = useDeleteOrganization()
  const { data: organizations } = useOrganizations()
  const navigate = useNavigate()

  const [open, setOpen] = React.useState(false)
  const [confirmText, setConfirmText] = React.useState("")
  const canDelete = confirmText.trim() === organization.name.trim()

  const handleDelete = async (): Promise<void> => {
    try {
      await deleteOrg.mutateAsync({ slug: organization.slug })
      setOpen(false)
      setConfirmText("")

      const remaining = (organizations ?? []).filter(
        (o) => o.slug !== organization.slug
      )
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
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <RiBuilding2Line className="size-4 text-muted-foreground" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {organization.name}
          {organization.is_default ? (
            <span className="ml-2 inline-flex rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
              {t("workspace.default")}
            </span>
          ) : null}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {organization.slug}
        </p>
      </div>

      <Button asChild size="sm" variant="ghost" className="shrink-0 gap-1">
        <Link
          to="/orgs/$orgSlug/settings/general"
          params={{ orgSlug: organization.slug }}
        >
          {t("common:open")}
          <RiArrowRightSLine className="size-3.5" />
        </Link>
      </Button>

      <Button
        size="sm"
        variant="outline"
        className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => {
          setConfirmText("")
          setOpen(true)
        }}
      >
        {t("common:delete")}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!deleteOrg.isPending) setOpen(next)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspace.deleteConfirm")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>{t("workspace.cascade", { name: organization.name })}</p>
                <div className="space-y-1.5">
                  <Label
                    htmlFor={`confirm-${organization.slug}`}
                    className="text-xs font-medium text-foreground"
                  >
                    {t("workspace.typeToConfirm", { name: organization.name })}
                  </Label>
                  <Input
                    id={`confirm-${organization.slug}`}
                    autoFocus
                    autoComplete="off"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={organization.name}
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
              loading={deleteOrg.isPending}
              disabled={!canDelete}
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
              className="bg-destructive bg-none text-white hover:bg-destructive/90"
            >
              {deleteOrg.isPending
                ? t("workspace.deleting")
                : t("workspace.deleteWorkspace")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
