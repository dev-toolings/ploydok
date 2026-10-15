// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Button } from "@workspace/ui/components/button"
import { useTranslation } from "react-i18next"
import { RiServerLine } from "@remixicon/react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"

interface InstallDialogProps {
  open: boolean
  templateName: string
  templateVersion: string
  isPending: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function InstallDialog({
  open,
  templateName,
  templateVersion,
  isPending,
  onConfirm,
  onCancel,
}: InstallDialogProps): React.JSX.Element {
  const { t } = useTranslation("services")
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RiServerLine className="size-5 text-muted-foreground" />
            {t("install.title", { name: templateName })}
          </DialogTitle>
          <DialogDescription>
            {t("install.body", {
              name: templateName,
              version: templateVersion,
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-amber-500/30 bg-warn-100 dark:bg-[#432004]/60 px-3 py-2 text-xs text-warn-700 dark:text-[#fdc700]">
          {t("install.hostHint")}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isPending}
          >
            {t("common:cancel")}
          </Button>
          <Button type="button" onClick={onConfirm} loading={isPending}>
            {isPending ? t("install.installing") : t("install.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
