// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  useTargetBackupConfig,
  useUpdateTargetBackupConfig,
} from "../../lib/backups"
import { useCurrentOrganizationSlug } from "../../lib/organizations"
import { useStorageDestinations } from "../../lib/storage-destinations"
import type { BackupTarget, UpdateBackupConfigInput } from "../../lib/backups"

interface BackupConfigPanelProps {
  target: BackupTarget
}

export function BackupConfigPanel({
  target,
}: BackupConfigPanelProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const { data: config, isLoading } = useTargetBackupConfig(target)
  const update = useUpdateTargetBackupConfig(target)
  const currentOrgSlug = useCurrentOrganizationSlug()
  const { data: destinations = [], isLoading: destinationsLoading } =
    useStorageDestinations(currentOrgSlug)

  const [destinationId, setDestinationId] = React.useState("")
  const [s3Prefix, setS3Prefix] = React.useState("")
  const [scheduleCron, setScheduleCron] = React.useState("0 3 * * *")
  const [retentionDays, setRetentionDays] = React.useState(7)
  const [agePublicKey, setAgePublicKey] = React.useState("")
  const [enabled, setEnabled] = React.useState(true)

  React.useEffect(() => {
    if (!config) return
    setDestinationId(config.destinationId ?? "")
    setS3Prefix(config.s3Prefix ?? "")
    setScheduleCron(config.scheduleCron)
    setRetentionDays(config.retentionDays)
    setAgePublicKey(config.ageRecipientPublicKey ?? "")
    setEnabled(config.enabled)
  }, [config])

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const input: UpdateBackupConfigInput = {
      destinationId: destinationId || null,
      scheduleCron,
      retentionDays,
      ageRecipientPublicKey: agePublicKey || null,
      enabled,
    }
    input.s3Prefix = s3Prefix.trim()
    update.mutate(input)
  }

  if (isLoading) {
    return (
      <div aria-busy="true" aria-label={t("backup.loading")}>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    )
  }

  return (
    <form onSubmit={handleSave} className="max-w-xl space-y-5">
      <div className="flex items-center gap-3">
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          id="backup-enabled"
        />
        <Label htmlFor="backup-enabled">{t("backup.enable")}</Label>
      </div>

      <div className="space-y-1.5">
        <Label>{t("backup.destination")}</Label>
        <Select
          value={destinationId}
          onValueChange={setDestinationId}
          disabled={destinationsLoading || destinations.length === 0}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("backup.chooseDestination")} />
          </SelectTrigger>
          <SelectContent>
            {destinations.map((destination) => (
              <SelectItem key={destination.id} value={destination.id}>
                {destination.name} ·{" "}
                {destination.kind === "s3"
                  ? t("backup.s3Option")
                  : t("backup.local")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {destinations.length === 0
            ? t("backup.noDestinations")
            : t("backup.destinationHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t("backup.prefix")}</Label>
        <Input
          placeholder={t("backup.prefixPlaceholder")}
          value={s3Prefix}
          onChange={(e) => setS3Prefix(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("backup.prefixHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t("backup.schedule")}</Label>
        <Input
          placeholder="0 3 * * *"
          value={scheduleCron}
          onChange={(e) => setScheduleCron(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {t("backup.scheduleHint")}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label>{t("backup.retention")}</Label>
        <Input
          type="number"
          min={1}
          max={365}
          value={retentionDays}
          onChange={(e) => setRetentionDays(Number(e.target.value))}
        />
      </div>

      <div className="space-y-1.5">
        <Label>{t("backup.ageKey")}</Label>
        <Textarea
          placeholder="age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
          value={agePublicKey}
          onChange={(e) => setAgePublicKey(e.target.value)}
          rows={2}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          {t("backup.encryptHint")}
        </p>
      </div>

      <Button
        type="submit"
        loading={update.isPending}
        disabled={!destinationId || destinationsLoading}
      >
        {update.isPending ? t("common:saving") : t("backup.save")}
      </Button>
    </form>
  )
}
