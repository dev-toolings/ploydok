// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useRestoreBackup } from "../../lib/backups"
import type { Backup } from "../../lib/backups"

interface RestoreDialogProps {
  backup: Backup
  databaseId: string
  databaseName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RestoreDialog({
  backup,
  databaseId,
  databaseName,
  open,
  onOpenChange,
}: RestoreDialogProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const restore = useRestoreBackup(databaseId)
  const [ageIdentity, setAgeIdentity] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const expectedConfirm = `restore ${databaseName}`

  function handleClose() {
    setAgeIdentity("")
    setConfirm("")
    onOpenChange(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await restore.mutateAsync({
      backupId: backup.id,
      ageIdentity: ageIdentity || undefined,
      confirm,
    })
    handleClose()
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("restore.title")}</DialogTitle>
          <DialogDescription>
            {t("restore.fromBackup", { id: backup.id })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Alert variant="destructive">
            <AlertDescription>
              {t("restore.destroy", { name: databaseName })}
            </AlertDescription>
          </Alert>

          {backup.ageEncrypted && (
            <div className="space-y-1.5">
              <Label htmlFor="age-identity">{t("restore.ageKey")}</Label>
              <Textarea
                id="age-identity"
                placeholder="AGE-SECRET-KEY-..."
                value={ageIdentity}
                onChange={(e) => setAgeIdentity(e.target.value)}
                rows={3}
                className="font-mono text-xs"
                required={backup.ageEncrypted}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t("restore.ageHint")}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="restore-confirm">
              {t("restore.typeConfirm", { phrase: expectedConfirm })}
            </Label>
            <Input
              id="restore-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={expectedConfirm}
              autoComplete="off"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              {t("common:cancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              loading={restore.isPending}
              disabled={
                confirm !== expectedConfirm ||
                (backup.ageEncrypted && !ageIdentity)
              }
            >
              {restore.isPending ? t("restore.restoring") : t("restore.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
