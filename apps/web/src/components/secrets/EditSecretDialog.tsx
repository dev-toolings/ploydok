// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { RiEyeLine, RiEyeOffLine } from "@remixicon/react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldContent, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { NativeSelect } from "@workspace/ui/components/native-select"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useUpdateSecret } from "../../lib/secrets"
import type { SecretMeta, SecretPhase } from "../../lib/secrets"

const PHASES: Array<SecretPhase> = ["runtime", "build", "both"]

interface EditSecretDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  appId: string
  secret: SecretMeta | null
}

export function EditSecretDialog({
  open,
  onOpenChange,
  appId,
  secret,
}: EditSecretDialogProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const [value, setValue] = React.useState("")
  const [phase, setPhase] = React.useState<SecretPhase>("runtime")
  const [showValue, setShowValue] = React.useState(false)
  const { mutate: updateSecret, isPending } = useUpdateSecret(appId)
  const isDatabaseManaged = secret?.managed_by === "database"
  const phaseChanged = Boolean(secret && phase !== secret.phase)
  const canSubmit = Boolean(
    secret && (value || phaseChanged) && !isDatabaseManaged
  )

  React.useEffect(() => {
    if (open) {
      setValue("")
      setShowValue(false)
      setPhase(secret?.phase ?? "runtime")
    }
  }, [open, secret?.key, secret?.scope, secret?.phase])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!secret || !canSubmit) return

    updateSecret(
      {
        key: secret.key,
        scope: secret.scope,
        phase: secret.phase,
        ...(value ? { value } : {}),
        ...(phaseChanged ? { newPhase: phase } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t("secrets.updated", { key: secret.key }))
          onOpenChange(false)
        },
        onError: (err) => {
          toast.error(
            err.code === "SECRET_EXISTS"
              ? t("secrets.phaseTaken", { key: secret.key, phase })
              : err.message
          )
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("secrets.edit")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="edit-secret-key">
              {t("secrets.key")}
            </FieldLabel>
            <FieldContent>
              <Input
                id="edit-secret-key"
                value={secret?.key ?? ""}
                disabled
                className="font-mono"
              />
            </FieldContent>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel>{t("secrets.scope")}</FieldLabel>
              <FieldContent>
                <Badge variant="outline" className="font-sans">
                  {secret?.scope ?? "shared"}
                </Badge>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel htmlFor="edit-secret-phase">
                {t("secrets.phase")}
              </FieldLabel>
              <FieldContent>
                <NativeSelect
                  id="edit-secret-phase"
                  value={phase}
                  onChange={(e) => setPhase(e.target.value as SecretPhase)}
                  disabled={isDatabaseManaged}
                >
                  {PHASES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </NativeSelect>
              </FieldContent>
            </Field>
          </div>

          {isDatabaseManaged && (
            <Alert variant="destructive">
              <AlertDescription>{t("secrets.managedEdit")}</AlertDescription>
            </Alert>
          )}

          <Field>
            <FieldLabel htmlFor="edit-secret-value">
              {t("secrets.newValue")}
            </FieldLabel>
            <FieldContent>
              <div className="relative">
                <Input
                  id="edit-secret-value"
                  type={showValue ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={t("secrets.keepValueHint")}
                  autoComplete="new-password"
                  disabled={isDatabaseManaged}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowValue((visible) => !visible)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  aria-label={showValue ? t("secrets.hide") : t("secrets.show")}
                  title={showValue ? t("secrets.hide") : t("secrets.show")}
                  disabled={isDatabaseManaged}
                >
                  {showValue ? (
                    <RiEyeOffLine className="size-4" />
                  ) : (
                    <RiEyeLine className="size-4" />
                  )}
                </button>
              </div>
            </FieldContent>
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={!canSubmit} loading={isPending}>
              {isPending ? t("secrets.saving") : t("common:save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
