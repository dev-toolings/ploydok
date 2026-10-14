// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { DEFAULT_DATABASE_ENV_PREFIX } from "../../lib/database-env"
import { useDatabases, useLinkDatabase } from "../../lib/databases"
import type { Database } from "../../lib/databases"

interface LinkDatabaseDialogProps {
  open: boolean
  appId: string
  projectId: string
  onClose: () => void
}

const PREFIX_REGEX = /^[A-Z0-9_]+$/

export function LinkDatabaseDialog({
  open,
  appId,
  projectId,
  onClose,
}: LinkDatabaseDialogProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const [selectedDbId, setSelectedDbId] = React.useState("")
  const [envPrefix, setEnvPrefix] = React.useState(DEFAULT_DATABASE_ENV_PREFIX)
  const [prefixError, setPrefixError] = React.useState("")

  const { data: databases, isLoading } = useDatabases(projectId, {
    enabled: open,
  })
  const { mutate: linkDb, isPending } = useLinkDatabase()

  const runningDbs = (databases ?? []).filter(
    (db: Database) => db.status === "running"
  )

  function validatePrefix(v: string): boolean {
    if (!PREFIX_REGEX.test(v)) {
      setPrefixError(t("link.prefixError"))
      return false
    }
    setPrefixError("")
    return true
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedDbId) return
    if (!validatePrefix(envPrefix)) return

    linkDb(
      { appId, databaseId: selectedDbId, env_prefix: envPrefix },
      {
        onSuccess: () => {
          setSelectedDbId("")
          setEnvPrefix(DEFAULT_DATABASE_ENV_PREFIX)
          onClose()
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("link.title")}</DialogTitle>
          <DialogDescription>{t("link.description")}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="db-select">{t("link.database")}</Label>
            {isLoading ? (
              <Skeleton className="h-9 w-full rounded-md" />
            ) : runningDbs.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {t("link.empty")}
              </div>
            ) : (
              <Select value={selectedDbId} onValueChange={setSelectedDbId}>
                <SelectTrigger id="db-select">
                  <SelectValue placeholder={t("link.select")} />
                </SelectTrigger>
                <SelectContent>
                  {runningDbs.map((db: Database) => (
                    <SelectItem key={db.id} value={db.id}>
                      {db.name} ({db.kind})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="env-prefix">{t("link.prefix")}</Label>
            <Input
              id="env-prefix"
              value={envPrefix}
              onChange={(e) => {
                const v = e.target.value.toUpperCase()
                setEnvPrefix(v)
                if (v) validatePrefix(v)
              }}
              placeholder={DEFAULT_DATABASE_ENV_PREFIX}
            />
            {prefixError && (
              <span className="text-xs text-destructive">{prefixError}</span>
            )}
            <span className="text-xs text-muted-foreground">
              {t("link.prefixHint")}
            </span>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isPending}
            >
              {t("common:cancel")}
            </Button>
            <Button
              type="submit"
              loading={isPending}
              disabled={!selectedDbId || runningDbs.length === 0}
            >
              {isPending ? t("link.linking") : t("link.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
