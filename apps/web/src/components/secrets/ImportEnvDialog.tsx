// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
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
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useImportEnv } from "../../lib/secrets"
import type { SecretPhase, SecretScope } from "../../lib/secrets"

interface ImportEnvDialogProps {
  appId: string
  open: boolean
  defaultScope?: SecretScope
  onOpenChange: (open: boolean) => void
}

const SCOPES: Array<SecretScope> = ["shared", "prod", "preview", "dev"]
const PHASES: Array<SecretPhase> = ["runtime", "build", "both"]

export function ImportEnvDialog({
  appId,
  open,
  defaultScope = "shared",
  onOpenChange,
}: ImportEnvDialogProps): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const [file, setFile] = React.useState<File | null>(null)
  const [scope, setScope] = React.useState<SecretScope>(defaultScope)
  const [phase, setPhase] = React.useState<SecretPhase>("runtime")
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const { mutate: importEnv, isPending } = useImportEnv(appId)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return

    importEnv(
      { file, scope, phase },
      {
        onSuccess: ({ imported }) => {
          toast.success(t("secrets.imported", { count: imported }))
          setFile(null)
          if (fileInputRef.current) fileInputRef.current.value = ""
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
          <DialogTitle>{t("secrets.importTitle")}</DialogTitle>
          <DialogDescription>{t("secrets.importHint")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="import-file">{t("secrets.file")}</FieldLabel>
            <FieldContent>
              <input
                ref={fileInputRef}
                id="import-file"
                type="file"
                accept=".env,text/plain"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="flex h-9 w-full cursor-pointer rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                required
              />
            </FieldContent>
            <FieldDescription>{t("secrets.fileHint")}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="import-scope">
              {t("secrets.defaultScope")}
            </FieldLabel>
            <FieldContent>
              <Select
                value={scope}
                onValueChange={(next) => setScope(next as SecretScope)}
              >
                <SelectTrigger id="import-scope">
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
            <FieldLabel htmlFor="import-phase">
              {t("secrets.defaultPhase")}
            </FieldLabel>
            <FieldContent>
              <Select
                value={phase}
                onValueChange={(next) => setPhase(next as SecretPhase)}
              >
                <SelectTrigger id="import-phase">
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

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t("cancel", { ns: "common" })}
            </Button>
            <Button type="submit" loading={isPending} disabled={!file}>
              {isPending ? t("secrets.importing") : t("secrets.import")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
