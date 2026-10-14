// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useDeleteDatabase } from "../../lib/databases"
import type { Database } from "../../lib/databases"

interface DeleteDatabaseDialogProps {
  database: Database | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function DeleteDatabaseDialog({
  database,
  open,
  onOpenChange,
  onDeleted,
}: DeleteDatabaseDialogProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const [confirmText, setConfirmText] = React.useState("")
  const { mutate: deleteDatabase, isPending } = useDeleteDatabase()

  React.useEffect(() => {
    if (!open) {
      setConfirmText("")
    }
  }, [open])

  function handleDelete() {
    if (!database) return
    deleteDatabase(
      {
        id: database.id,
        name: database.name,
      },
      {
        onSuccess: () => {
          onOpenChange(false)
          onDeleted?.()
        },
      }
    )
  }

  const expectedConfirm = database ? `delete ${database.name}` : ""
  const canDelete = confirmText === expectedConfirm && !isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("delete.title")}</DialogTitle>
          <DialogDescription>
            {t("delete.confirm", { name: expectedConfirm })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="delete-database-confirm">
              {t("delete.confirmation")}
            </Label>
            <Input
              id="delete-database-confirm"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={expectedConfirm}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {t("common:cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            loading={isPending}
            disabled={!canDelete}
          >
            {isPending ? t("delete.deleting") : t("delete.title")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
