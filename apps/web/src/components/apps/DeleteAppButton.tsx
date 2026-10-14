// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import { RiCheckLine, RiDeleteBinLine, RiFileCopyLine } from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { useTranslation } from "react-i18next"
import { useDeleteApp } from "../../lib/apps-mutations"
import { useMe } from "../../lib/auth"
import { useCurrentOrganizationSlug } from "../../lib/organizations"
import { usePendingAction } from "../../lib/hooks/use-pending-action"
import type { AppDetail } from "../../lib/apps"

interface DeleteAppButtonProps {
  app: AppDetail
}

export function DeleteAppButton({
  app,
}: DeleteAppButtonProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const router = useRouter()
  const orgSlug = useCurrentOrganizationSlug()
  const [open, setOpen] = React.useState(false)
  const [confirmName, setConfirmName] = React.useState("")
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const confirmInput = React.useRef<HTMLInputElement>(null)
  const confirmId = React.useId()

  const deleteApp = useDeleteApp(app.id)
  const { data: me } = useMe()
  const needs2FA = Boolean(me?.needs_second_factor)
  const lockTitle = needs2FA ? t("actions.need2fa") : t("actions.deleteApp")
  const { pending, run } = usePendingAction(
    async () => {
      await deleteApp.mutateAsync()
      const href = orgSlug ? `/orgs/${orgSlug}/apps` : "/apps"
      await router.navigate({ href })
    },
    { keepPendingOnSuccess: true }
  )

  const close = (): void => {
    setOpen(false)
    setConfirmName("")
    setActionError(null)
    setCopied(false)
  }

  const handleDelete = async (): Promise<void> => {
    if (confirmName !== app.name) return
    try {
      await run()
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : t("actions.deleteFailed")
      )
    }
  }

  const copyName = async (): Promise<void> => {
    setCopying(true)
    setActionError(null)
    try {
      await navigator.clipboard.writeText(app.name)
      setCopied(true)
      confirmInput.current?.focus()
    } catch {
      setCopied(false)
      setActionError(t("actions.copyNameFailed"))
    } finally {
      setCopying(false)
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={needs2FA}
        loading={pending}
        title={lockTitle}
        onClick={() => setOpen(true)}
        className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
        {t("actions.deleteApp")}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !pending) close()
        }}
      >
        <AlertDialogContent
          className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto data-[size=default]:max-w-xl data-[size=default]:sm:max-w-xl"
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("actions.deleteTitle", { name: app.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("actions.deleteConsequences")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              if (confirmName === app.name && !pending) void handleDelete()
            }}
          >
            <div className="space-y-3">
              <label
                htmlFor={confirmId}
                className="block text-sm text-muted-foreground"
              >
                {t("actions.deleteConfirmLabel")}
              </label>
              <Button
                type="button"
                variant="ghost"
                loading={copying}
                disabled={pending}
                onClick={() => void copyName()}
                aria-label={t(
                  copied ? "actions.nameCopied" : "actions.copyName",
                  { name: app.name }
                )}
                className="h-auto min-h-11 max-w-full justify-start gap-2 px-2 text-base font-semibold"
              >
                <span className="min-w-0 break-all whitespace-normal">
                  {app.name}
                </span>
                {copied ? (
                  <RiCheckLine
                    className="text-emerald-600"
                    aria-hidden="true"
                  />
                ) : (
                  <RiFileCopyLine aria-hidden="true" />
                )}
              </Button>
              <span className="sr-only" role="status">
                {copied ? t("actions.nameCopied", { name: app.name }) : ""}
              </span>
              <Input
                ref={confirmInput}
                id={confirmId}
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={app.name}
                className="h-11 text-base focus-visible:border-destructive focus-visible:ring-destructive/20"
                disabled={pending}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
              />
            </div>

            {actionError && (
              <p className="text-sm text-destructive" role="alert">
                {actionError}
              </p>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel
                type="button"
                onClick={close}
                disabled={pending}
              >
                {t("common:cancel")}
              </AlertDialogCancel>
              <Button
                type="submit"
                loading={pending}
                disabled={confirmName !== app.name}
                className="bg-destructive bg-none text-white hover:bg-destructive/90"
              >
                {pending ? t("actions.deleting") : t("actions.deleteApp")}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
