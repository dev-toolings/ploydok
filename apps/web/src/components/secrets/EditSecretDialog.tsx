// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiEyeLine, RiEyeOffLine } from "@remixicon/react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldContent, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useUpdateSecret } from "../../lib/secrets"
import type { SecretMeta } from "../../lib/secrets"

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
  const [value, setValue] = React.useState("")
  const [showValue, setShowValue] = React.useState(false)
  const { mutate: updateSecret, isPending } = useUpdateSecret(appId)
  const isDatabaseManaged = secret?.managed_by === "database"
  const canSubmit = Boolean(secret && value && !isPending && !isDatabaseManaged)

  React.useEffect(() => {
    if (!open) {
      setValue("")
      setShowValue(false)
    }
  }, [open])

  React.useEffect(() => {
    if (open) {
      setValue("")
      setShowValue(false)
    }
  }, [open, secret?.key, secret?.scope, secret?.phase])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!secret || !value || isDatabaseManaged) return

    updateSecret(
      {
        key: secret.key,
        scope: secret.scope,
        phase: secret.phase,
        value,
      },
      {
        onSuccess: () => {
          toast.success(`Updated ${secret.key}`)
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
          <DialogTitle>Edit secret</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field>
            <FieldLabel htmlFor="edit-secret-key">Key</FieldLabel>
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
              <FieldLabel>Scope</FieldLabel>
              <FieldContent>
                <Badge variant="outline" className="font-sans">
                  {secret?.scope ?? "shared"}
                </Badge>
              </FieldContent>
            </Field>

            <Field>
              <FieldLabel>Phase</FieldLabel>
              <FieldContent>
                <Badge variant="outline" className="font-sans">
                  {secret?.phase ?? "runtime"}
                </Badge>
              </FieldContent>
            </Field>
          </div>

          {isDatabaseManaged && (
            <Alert variant="destructive">
              <AlertDescription>
                Managed by database link — unlink to edit
              </AlertDescription>
            </Alert>
          )}

          <Field>
            <FieldLabel htmlFor="edit-secret-value">New value</FieldLabel>
            <FieldContent>
              <div className="relative">
                <Input
                  id="edit-secret-value"
                  type={showValue ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Secret value"
                  autoComplete="new-password"
                  required
                  disabled={isDatabaseManaged}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowValue((visible) => !visible)}
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  aria-label={showValue ? "Hide value" : "Show value"}
                  title={showValue ? "Hide value" : "Show value"}
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
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
