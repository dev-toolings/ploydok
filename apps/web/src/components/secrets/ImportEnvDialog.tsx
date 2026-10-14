// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
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
          toast.success(
            `Imported ${imported} secret${imported !== 1 ? "s" : ""}`
          )
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
          <DialogTitle>Import .env file</DialogTitle>
          <DialogDescription>
            Upload a .env file. Scope prefixes like{" "}
            <code className="text-xs">@prod MY_KEY=value</code> override the
            default scope.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="import-file">.env file</FieldLabel>
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
            <FieldDescription>
              Standard .env format with optional @scope prefixes
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="import-scope">Default scope</FieldLabel>
            <FieldContent>
              <select
                id="import-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as SecretScope)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                {SCOPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </FieldContent>
          </Field>

          <Field>
            <FieldLabel htmlFor="import-phase">Default phase</FieldLabel>
            <FieldContent>
              <select
                id="import-phase"
                value={phase}
                onChange={(e) => setPhase(e.target.value as SecretPhase)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                {PHASES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </FieldContent>
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" loading={isPending} disabled={!file}>
              {isPending ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
