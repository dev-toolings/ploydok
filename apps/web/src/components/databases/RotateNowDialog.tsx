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
import { useRotateDatabase } from "../../lib/databases"

interface RotateNowDialogProps {
  databaseId: string | null
  onClose: () => void
}

export function RotateNowDialog({
  databaseId,
  onClose,
}: RotateNowDialogProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const [confirmed, setConfirmed] = React.useState(false)
  const [totpCode, setTotpCode] = React.useState("")
  const { mutate: rotate, isPending } = useRotateDatabase()

  function handleClose() {
    setConfirmed(false)
    setTotpCode("")
    onClose()
  }

  function handleRotate() {
    if (!databaseId) return
    rotate(
      { id: databaseId, totpCode },
      {
        onSuccess: () => {
          handleClose()
        },
      }
    )
  }

  return (
    <Dialog
      open={Boolean(databaseId)}
      onOpenChange={(v) => !v && handleClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("rotate.title")}</DialogTitle>
          <DialogDescription>{t("rotate.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-amber-500/20 bg-warn-100 dark:bg-[#432004]/60 px-3 py-2 text-sm text-warn-700 dark:text-[#fdc700]">
            {t("rotate.warning")}
          </div>

          {!confirmed ? (
            <Button variant="outline" onClick={() => setConfirmed(true)}>
              {t("rotate.understand")}
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="rotate-database-totp">{t("adminer.totp")}</Label>
              <Input
                id="rotate-database-totp"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={totpCode}
                onChange={(event) =>
                  setTotpCode(
                    event.target.value.replace(/\D+/g, "").slice(0, 6)
                  )
                }
                autoComplete="one-time-code"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isPending}>
            {t("common:cancel")}
          </Button>
          {confirmed && (
            <Button
              variant="destructive"
              onClick={handleRotate}
              loading={isPending}
              disabled={totpCode.length !== 6}
            >
              {isPending ? t("rotate.rotating") : t("rotate.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
