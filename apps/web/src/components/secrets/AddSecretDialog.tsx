// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useCreateSecret } from "../../lib/secrets"
import type { SecretPhase, SecretScope } from "../../lib/secrets"

interface AddSecretDialogProps {
  appId: string
  open: boolean
  defaultScope?: SecretScope
  onOpenChange: (open: boolean) => void
}

const SCOPES: Array<SecretScope> = ["shared", "prod", "preview", "dev"]
const PHASES: Array<SecretPhase> = ["runtime", "build", "both"]

export function AddSecretDialog({
  appId,
  open,
  defaultScope = "shared",
  onOpenChange,
}: AddSecretDialogProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const [key, setKey] = React.useState("")
  const [value, setValue] = React.useState("")
  const [scope, setScope] = React.useState<SecretScope>(defaultScope)
  const [phase, setPhase] = React.useState<SecretPhase>("runtime")
  const [showValue, setShowValue] = React.useState(false)
  const [keyError, setKeyError] = React.useState<string | null>(null)

  const { mutate: createSecret, isPending } = useCreateSecret(appId)

  React.useEffect(() => {
    if (open) setScope(defaultScope)
  }, [defaultScope, open])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      setKeyError(t("secrets.keyFormat"))
      return
    }
    setKeyError(null)

    createSecret(
      { key, value, scope, phase },
      {
        onSuccess: () => {
          toast.success(t("secrets.saved", { key }))
          setKey("")
          setValue("")
          setScope(defaultScope)
          setPhase("runtime")
          onOpenChange(false)
        },
        onError: (err) => {
          toast.error(err.message)
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("secrets.add")}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="secret-key">{t("secrets.key")}</FieldLabel>
            <FieldContent>
              <Input
                id="secret-key"
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                placeholder="MY_SECRET_KEY"
                autoComplete="off"
                required
              />
            </FieldContent>
            {keyError && <FieldError>{keyError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="secret-scope">{t("secrets.scope")}</FieldLabel>
            <FieldContent>
              <Select
                value={scope}
                onValueChange={(next) => setScope(next as SecretScope)}
              >
                <SelectTrigger id="secret-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldContent>
          </Field>

          <Field>
            <FieldLabel htmlFor="secret-phase">{t("secrets.phase")}</FieldLabel>
            <FieldContent>
              <Select
                value={phase}
                onValueChange={(next) => setPhase(next as SecretPhase)}
              >
                <SelectTrigger id="secret-phase">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHASES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldContent>
          </Field>

          <Field>
            <FieldLabel htmlFor="secret-value">{t("secrets.value")}</FieldLabel>
            <FieldContent>
              <div className="relative">
                <Input
                  id="secret-value"
                  type={showValue ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={t("secrets.placeholder")}
                  autoComplete="new-password"
                  required
                  className="pr-16"
                />
                <button
                  type="button"
                  onClick={() => setShowValue((v) => !v)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                >
                  {showValue ? t("secrets.hide") : t("secrets.show")}
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
              {t("cancel", { ns: "common" })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isPending ? t("secrets.saving") : t("secrets.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
