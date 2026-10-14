// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"
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
import { useRevealDatabase } from "../../lib/databases"

const AUTO_HIDE_MS = 30_000

interface RevealConnectionDialogProps {
  databaseId: string | null
  onClose: () => void
}

export function RevealConnectionDialog({
  databaseId,
  onClose,
}: RevealConnectionDialogProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const [connString, setConnString] = React.useState<string | null>(null)
  const [countdown, setCountdown] = React.useState(0)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const { mutate: reveal, isPending } = useRevealDatabase()

  React.useEffect(() => {
    if (connString !== null) {
      setCountdown(AUTO_HIDE_MS / 1000)
      timerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            clearInterval(timerRef.current!)
            setConnString(null)
            return 0
          }
          return c - 1
        })
      }, 1000)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [connString])

  function handleClose() {
    if (timerRef.current) clearInterval(timerRef.current)
    setConnString(null)
    onClose()
  }

  function handleConfirm() {
    if (!databaseId) return
    reveal(
      { id: databaseId },
      {
        onSuccess: (value) => {
          setConnString(value)
        },
        onError: (err: Error) => {
          toast.error(err.message || t("toasts.revealFailed"))
        },
      }
    )
  }

  function handleCopy() {
    if (!connString) return
    navigator.clipboard
      .writeText(connString)
      .then(() => toast.success(t("reveal.copied")))
  }

  const isOpen = Boolean(databaseId)

  if (!connString) {
    return (
      <AlertDialog open={isOpen} onOpenChange={(v) => !v && handleClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reveal.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("reveal.description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleClose}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleConfirm()
              }}
              loading={isPending}
            >
              {isPending ? t("reveal.revealing") : t("common:reveal")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("reveal.connection")}</DialogTitle>
          <DialogDescription>
            {t("reveal.autoHide", { seconds: countdown })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label>{t("reveal.connection")}</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={connString}
              className="font-mono text-xs"
              type="text"
            />
            <Button size="sm" variant="outline" onClick={handleCopy}>
              {t("common:copy")}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t("common:close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
