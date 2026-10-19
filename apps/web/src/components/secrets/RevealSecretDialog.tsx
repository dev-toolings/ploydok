// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
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
import { useRevealSecret } from "../../lib/secrets"
import { useMe } from "../../lib/auth"
import i18n from "../../lib/i18n"
import { copyToClipboard, notifyCopyFailed } from "../../lib/clipboard"
import type { SecretPhase, SecretScope } from "../../lib/secrets"

const AUTO_HIDE_MS = 30_000

interface RevealSecretDialogProps {
  appId: string
  secretKey: string | null
  scope: SecretScope | null
  phase: SecretPhase | null
  onClose: () => void
}

export function RevealSecretDialog({
  appId,
  secretKey,
  scope,
  phase,
  onClose,
}: RevealSecretDialogProps): React.JSX.Element {
  const [totpCode, setTotpCode] = React.useState("")
  const [revealedValue, setRevealedValue] = React.useState<string | null>(null)
  const [countdown, setCountdown] = React.useState(0)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  const { mutate: revealSecret, isPending } = useRevealSecret(appId)
  const { data: me } = useMe()
  const requiresTotp = me?.require_totp_for_secret_reveal ?? true

  // Auto-hide countdown
  React.useEffect(() => {
    if (revealedValue !== null) {
      setCountdown(AUTO_HIDE_MS / 1000)
      timerRef.current = setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            clearInterval(timerRef.current!)
            setRevealedValue(null)
            return 0
          }
          return c - 1
        })
      }, 1000)
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [revealedValue])

  function handleClose() {
    setTotpCode("")
    setRevealedValue(null)
    if (timerRef.current) clearInterval(timerRef.current)
    onClose()
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!secretKey || !scope) return

    revealSecret(
      {
        key: secretKey,
        scope,
        phase: phase ?? "runtime",
        totpCode: requiresTotp ? totpCode : undefined,
      },
      {
        onSuccess: ({ value }) => {
          setRevealedValue(value)
          setTotpCode("")
        },
        onError: (err) => {
          if (err.code === "totp_required" || err.status === 403) {
            toast.error("Invalid or missing TOTP code")
          } else {
            toast.error(err.message)
          }
        },
      }
    )
  }

  function handleCopy() {
    if (revealedValue) {
      copyToClipboard(revealedValue)
        .then(() => toast.success(i18n.t("common:copied")))
        .catch(notifyCopyFailed)
    }
  }

  return (
    <Dialog
      open={Boolean(secretKey)}
      onOpenChange={(open) => !open && handleClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reveal secret</DialogTitle>
          <DialogDescription>
            {requiresTotp ? "Enter your TOTP code to reveal" : "Reveal"}{" "}
            <strong>{secretKey}</strong> ({scope}).
            {phase ? ` Phase: ${phase}.` : ""}
          </DialogDescription>
        </DialogHeader>

        {revealedValue === null ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            {requiresTotp ? (
              <Field>
                <FieldLabel htmlFor="totp-code">TOTP code</FieldLabel>
                <FieldContent>
                  <Input
                    id="totp-code"
                    value={totpCode}
                    onChange={(e) =>
                      setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                    }
                    placeholder="000000"
                    autoComplete="one-time-code"
                    inputMode="numeric"
                    maxLength={6}
                    required
                  />
                </FieldContent>
                <FieldDescription>
                  6-digit code from your authenticator app
                </FieldDescription>
              </Field>
            ) : (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                TOTP confirmation for secret reveal is disabled in security
                settings.
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={isPending}
                disabled={requiresTotp && totpCode.length !== 6}
              >
                {isPending
                  ? requiresTotp
                    ? "Verifying…"
                    : "Revealing…"
                  : "Reveal"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <Field>
              <FieldLabel>Value</FieldLabel>
              <FieldContent>
                <div className="relative">
                  <Input
                    value={revealedValue}
                    readOnly
                    className="pr-16 font-mono text-xs"
                    onClick={(e) => (e.target as HTMLInputElement).select()}
                  />
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    Copy
                  </button>
                </div>
              </FieldContent>
              <FieldDescription className="text-amber-600 dark:text-amber-400">
                Auto-hidden in {countdown}s
              </FieldDescription>
            </Field>

            <DialogFooter>
              <Button variant="ghost" onClick={handleClose}>
                Close
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
