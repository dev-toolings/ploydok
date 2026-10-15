// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { toast } from "sonner"
import { apiFetch } from "../../lib/api"
import { RotateNowDialog } from "./RotateNowDialog"
import type { Database } from "../../lib/databases"

interface RotationPanelProps {
  db: Database
  onScheduleChange: (schedule: Database["rotation_schedule"]) => void
}

function formatRotatedAt(
  isoStr: string | null,
  t: (key: string, options?: { count: number }) => string
): string {
  if (!isoStr) return t("rotation.never")
  const ms = Date.now() - new Date(isoStr).getTime()
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days === 0) return t("rotation.today")
  if (days === 1) return t("rotation.yesterday")
  return t("rotation.daysAgo", { count: days })
}

export function RotationPanel({
  db,
  onScheduleChange,
}: RotationPanelProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const [rotateOpen, setRotateOpen] = React.useState(false)
  const [scheduleLoading, setScheduleLoading] = React.useState(false)
  const rotationSupported = db.kind !== "libsql"

  async function handleScheduleChange(value: string) {
    setScheduleLoading(true)
    try {
      await apiFetch(`/databases/${db.id}`, {
        method: "PATCH",
        body: { rotation_schedule: value },
        headers: { "content-type": "application/json" },
      })
      onScheduleChange(value as Database["rotation_schedule"])
      toast.success(t("toasts.scheduleUpdated"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toasts.updateFailed"))
    } finally {
      setScheduleLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{t("rotation.title")}</h2>
        {!rotationSupported ? (
          <Badge variant="outline">{t("rotation.notSupported")}</Badge>
        ) : db.rotation_in_progress ? (
          <Badge variant="secondary" className="bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700]">
            {t("rotation.inProgress")}
          </Badge>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="mb-1 block text-xs text-muted-foreground">
            {t("rotation.lastRotated")}
          </span>
          <div className="font-medium">
            {formatRotatedAt(db.password_rotated_at, t)}
          </div>
        </div>
        <div>
          <span className="mb-1 block text-xs text-muted-foreground">
            {t("rotation.schedule")}
          </span>
          <Select
            value={db.rotation_schedule}
            onValueChange={handleScheduleChange}
            disabled={
              scheduleLoading || db.rotation_in_progress || !rotationSupported
            }
          >
            <SelectTrigger className="h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">{t("rotation.manual")}</SelectItem>
              <SelectItem value="30d">{t("rotation.every30")}</SelectItem>
              <SelectItem value="60d">{t("rotation.every60")}</SelectItem>
              <SelectItem value="90d">{t("rotation.every90")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={
          db.rotation_in_progress ||
          db.status !== "running" ||
          !rotationSupported
        }
        onClick={() => setRotateOpen(true)}
      >
        {t("rotation.rotateNow")}
      </Button>

      <RotateNowDialog
        databaseId={rotateOpen ? db.id : null}
        onClose={() => setRotateOpen(false)}
      />
    </div>
  )
}
