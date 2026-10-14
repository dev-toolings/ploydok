// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
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
      setKeyError("Key must be UPPER_SNAKE_CASE (e.g. MY_VAR)")
      return
    }
    setKeyError(null)

    createSecret(
      { key, value, scope, phase },
      {
        onSuccess: () => {
          toast.success(`Secret ${key} saved`)
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
          <DialogTitle>Add secret</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="secret-key">Key</FieldLabel>
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
            <FieldLabel htmlFor="secret-scope">Scope</FieldLabel>
            <FieldContent>
              <select
                id="secret-scope"
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
            <FieldLabel htmlFor="secret-phase">Phase</FieldLabel>
            <FieldContent>
              <select
                id="secret-phase"
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

          <Field>
            <FieldLabel htmlFor="secret-value">Value</FieldLabel>
            <FieldContent>
              <div className="relative">
                <Input
                  id="secret-value"
                  type={showValue ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Secret value"
                  autoComplete="new-password"
                  required
                  className="pr-16"
                />
                <button
                  type="button"
                  onClick={() => setShowValue((v) => !v)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                >
                  {showValue ? "Hide" : "Show"}
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
              Cancel
            </Button>
            <Button type="submit" loading={isPending}>
              {isPending ? "Saving…" : "Save secret"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
