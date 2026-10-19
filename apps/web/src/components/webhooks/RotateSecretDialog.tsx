// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link } from "@tanstack/react-router"
import {
  RiFileCopyLine,
  RiLockPasswordLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
} from "@remixicon/react"
import { toast } from "sonner"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@workspace/ui/components/input-group"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useTotpStatus } from "../../lib/totp"
import i18n from "../../lib/i18n"
import { copyToClipboard } from "../../lib/clipboard"
import { rotateWebhookSecret } from "../../lib/webhooks"
import type { ApiError } from "../../lib/api"

type DialogStep = "totp" | "reveal"

export interface RotateSecretDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  appId: string
  onRotated: () => void
}

export function RotateSecretDialog({
  open,
  onOpenChange,
  appId,
  onRotated,
}: RotateSecretDialogProps): React.JSX.Element {
  const [step, setStep] = React.useState<DialogStep>("totp")
  const [totpCode, setTotpCode] = React.useState("")
  const [newSecret, setNewSecret] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)
  const secretInputRef = React.useRef<HTMLInputElement>(null)

  const { data: totp, isPending: totpPending } = useTotpStatus({
    enabled: open,
  })
  // Rotation is guarded server-side by requireTotpVerified. Submitting a code
  // without an enrolled secret counts as a failed verification and contributes
  // to the lockout throttle, so the form stays out of reach until enrollment.
  const totpMissing = totp?.enrolled === false

  React.useEffect(() => {
    if (!open) return
    setStep("totp")
    setTotpCode("")
    setNewSecret("")
    setPending(false)
    setError(null)
    setCopied(false)
  }, [open])

  const handleRotate = async (): Promise<void> => {
    if (totpCode.length !== 6) {
      setError("Please enter a 6-digit TOTP code.")
      return
    }
    setError(null)
    setPending(true)
    try {
      const result = await rotateWebhookSecret(appId, totpCode)
      setNewSecret(result.secret)
      setStep("reveal")
      requestAnimationFrame(() => {
        secretInputRef.current?.select()
      })
    } catch (err) {
      const apiErr = err as ApiError
      if (apiErr.code === "rotation_cooldown") {
        const hoursMatch = apiErr.message.match(/(\d+)\s*h/)
        const hours = hoursMatch ? hoursMatch[1] : "some time"
        setError(`Secret rotated recently. Try again after ${hours}h.`)
      } else {
        setError(apiErr.message)
      }
    } finally {
      setPending(false)
    }
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await copyToClipboard(newSecret)
      setCopied(true)
      toast.success(i18n.t("workspace:deliveries.copiedClipboard"))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(i18n.t("workspace:deliveries.copyFailed"))
    }
  }

  const handleClose = (): void => {
    if (step === "reveal") onRotated()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-xl"
        showCloseButton={step !== "reveal"}
      >
        <DialogHeader className="gap-3">
          <Badge variant="outline" className="w-fit">
            Secret Rotation
          </Badge>
          <DialogTitle>
            {step === "reveal"
              ? "Store the new secret now"
              : totpMissing
                ? "Set up two-factor authentication first"
                : "Confirm the rotation"}
          </DialogTitle>
          <DialogDescription className="leading-6">
            {step === "reveal"
              ? "This value is shown once. Copy it immediately and update the provider configuration before the grace window ends."
              : totpMissing
                ? "Rotating a signing secret needs a second factor. Add an authenticator app to your account, then come back here."
                : "Use your authenticator to unlock a new webhook signing secret."}
          </DialogDescription>
        </DialogHeader>

        {step === "totp" && totpMissing ? (
          <Alert>
            <RiShieldKeyholeLine />
            <AlertTitle>No authenticator app on your account</AlertTitle>
            <AlertDescription>
              Two-factor authentication protects every secret rotation. Once it
              is set up, this dialog will ask for a 6-digit code instead.
            </AlertDescription>
          </Alert>
        ) : step === "totp" ? (
          <div className="flex flex-col gap-4">
            <Alert>
              <RiShieldCheckLine />
              <AlertTitle>24-hour overlap window</AlertTitle>
              <AlertDescription>
                The previous secret stays valid for 24 hours so you can update
                GitHub or GitLab without interrupting incoming events.
              </AlertDescription>
            </Alert>

            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldContent className="gap-1">
                  <FieldLabel htmlFor="totp-code">
                    TOTP confirmation code
                  </FieldLabel>
                  <FieldDescription>
                    Enter the 6-digit code from your authenticator app.
                  </FieldDescription>
                </FieldContent>
                <Input
                  id="totp-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={totpCode}
                  aria-invalid={Boolean(error)}
                  className="font-mono tracking-[0.35em]"
                  placeholder="000000"
                  onChange={(event) =>
                    setTotpCode(
                      event.target.value.replace(/\D/g, "").slice(0, 6)
                    )
                  }
                />
                <FieldError>{error}</FieldError>
              </Field>
            </FieldGroup>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Alert>
              <RiLockPasswordLine />
              <AlertTitle>Shown once</AlertTitle>
              <AlertDescription>
                Keep this secret in your webhook provider configuration and your
                secure notes. It cannot be retrieved later from the UI.
              </AlertDescription>
            </Alert>

            <FieldGroup>
              <Field>
                <FieldContent className="gap-1">
                  <FieldLabel htmlFor="new-secret">
                    New webhook secret
                  </FieldLabel>
                  <FieldDescription>
                    Copy the secret before closing this dialog.
                  </FieldDescription>
                </FieldContent>
                <InputGroup>
                  <InputGroupInput
                    ref={secretInputRef}
                    id="new-secret"
                    readOnly
                    value={newSecret}
                    aria-label="New webhook secret"
                    className="font-mono text-xs"
                  />
                  <InputGroupAddon align="inline-end">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void handleCopy()}
                      aria-label="Copy webhook secret to clipboard"
                    >
                      <RiFileCopyLine data-icon="inline-start" />
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </InputGroupAddon>
                </InputGroup>
              </Field>
            </FieldGroup>
          </div>
        )}

        <DialogFooter>
          {step === "totp" && totpMissing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button size="sm" asChild>
                <Link
                  to="/settings/security/totp"
                  onClick={() => onOpenChange(false)}
                >
                  Set up two-factor authentication
                </Link>
              </Button>
            </>
          ) : step === "totp" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void handleRotate()}
                loading={pending}
                disabled={totpCode.length !== 6 || totpPending}
              >
                {pending ? "Verifying..." : "Rotate secret"}
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={handleClose}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
