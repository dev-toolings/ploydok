// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
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
import { DECISION_LABELS, replayDelivery } from "../../lib/webhooks"
import type { WebhookDelivery } from "../../lib/webhooks"
import type { ApiError } from "../../lib/api"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeIsoString(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString()
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}

function TabButton({
  active,
  onClick,
  children,
}: TabButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "-mb-px inline-flex items-center border-b-2 px-3 py-2 text-xs font-medium transition-colors",
        active
          ? "border-primary text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// DeliveryDetailsDialog
// ---------------------------------------------------------------------------

interface DeliveryDetailsDialogProps {
  delivery: WebhookDelivery | null
  appId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeliveryReplayed?: (newDeliveryId: string) => void
}

function ReplayTotpDialog({
  open,
  onOpenChange,
  appId,
  deliveryId,
  onReplayed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  appId: string
  deliveryId: string
  onReplayed: (newDeliveryId: string) => void
}): React.JSX.Element {
  const [totpCode, setTotpCode] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setTotpCode("")
    setPending(false)
    setError(null)
  }, [open])

  const handleReplay = async (): Promise<void> => {
    if (totpCode.length !== 6) {
      setError("Please enter a 6-digit TOTP code.")
      return
    }
    setError(null)
    setPending(true)
    try {
      const result = await replayDelivery(appId, deliveryId, totpCode)
      onOpenChange(false)
      onReplayed(result.delivery_id)
      toast.success("Delivery replayed successfully")
    } catch (err) {
      const apiErr = err as ApiError
      if (apiErr.code === "replay_limit_reached") {
        setError("Replay limit reached (max 10 per delivery).")
      } else if (apiErr.code === "replay_payload_missing") {
        setError("Original payload has expired and cannot be replayed.")
      } else {
        setError(apiErr.message ?? "Replay failed. Check your TOTP code.")
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Confirm redeliver</DialogTitle>
          <DialogDescription className="leading-6">
            Re-run this delivery through the push handler. Filters and
            auto-deploy rules still apply.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field data-invalid={Boolean(error)}>
            <FieldContent className="gap-1">
              <FieldLabel htmlFor="replay-totp-code">
                TOTP confirmation code
              </FieldLabel>
              <FieldDescription>
                Enter the 6-digit code from your authenticator app.
              </FieldDescription>
            </FieldContent>
            <Input
              id="replay-totp-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={totpCode}
              aria-invalid={Boolean(error)}
              className="font-mono tracking-[0.35em]"
              placeholder="000000"
              onChange={(event) =>
                setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
            />
            <FieldError>{error}</FieldError>
          </Field>
        </FieldGroup>

        <DialogFooter>
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
            onClick={() => void handleReplay()}
            loading={pending}
            disabled={totpCode.length !== 6}
          >
            {pending ? "Replaying…" : "Redeliver"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DeliveryDetailsDialog({
  delivery,
  appId,
  open,
  onOpenChange,
  onDeliveryReplayed,
}: DeliveryDetailsDialogProps): React.JSX.Element {
  const [activeTab, setActiveTab] = React.useState<
    "payload" | "decision" | "build"
  >("payload")
  const [replayDialogOpen, setReplayDialogOpen] = React.useState(false)

  React.useEffect(() => {
    if (open) setActiveTab("payload")
  }, [open])

  if (!delivery) return <></>

  const hasPayload = delivery.payloadSample != null
  const hasBuild = Boolean(delivery.buildId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">
            Delivery details
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <nav
          aria-label="Delivery sections"
          className="flex border-b border-border"
        >
          <TabButton
            active={activeTab === "payload"}
            onClick={() => setActiveTab("payload")}
          >
            Payload
          </TabButton>
          <TabButton
            active={activeTab === "decision"}
            onClick={() => setActiveTab("decision")}
          >
            Decision
          </TabButton>
          <TabButton
            active={activeTab === "build"}
            onClick={() => setActiveTab("build")}
          >
            Build
          </TabButton>
        </nav>

        {/* Tab content */}
        <div className="min-h-[200px]">
          {activeTab === "payload" && (
            <div className="max-h-80 overflow-auto rounded-md bg-muted/50 p-3">
              {hasPayload ? (
                <pre className="font-mono text-xs break-words whitespace-pre-wrap">
                  {JSON.stringify(delivery.payloadSample, null, 2)}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  Payload not available (expired or not stored).
                </p>
              )}
            </div>
          )}

          {activeTab === "decision" && (
            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-[1fr_2fr] gap-2">
                <span className="text-muted-foreground">Decision</span>
                <span className="font-medium">
                  {DECISION_LABELS[delivery.decision]}
                </span>
              </div>
              {delivery.decisionReason && (
                <div className="grid grid-cols-[1fr_2fr] gap-2">
                  <span className="text-muted-foreground">Reason</span>
                  <span>{delivery.decisionReason}</span>
                </div>
              )}
              <div className="grid grid-cols-[1fr_2fr] gap-2">
                <span className="text-muted-foreground">Signature valid</span>
                <span>{delivery.signatureValid ? "Yes" : "No"}</span>
              </div>
              <div className="grid grid-cols-[1fr_2fr] gap-2">
                <span className="text-muted-foreground">Received at</span>
                <span className="font-mono">
                  {safeIsoString(delivery.receivedAt)}
                </span>
              </div>
              {delivery.processedAt && (
                <div className="grid grid-cols-[1fr_2fr] gap-2">
                  <span className="text-muted-foreground">Processed at</span>
                  <span className="font-mono">
                    {safeIsoString(delivery.processedAt)}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-[1fr_2fr] gap-2">
                <span className="text-muted-foreground">Source</span>
                <span>{delivery.source}</span>
              </div>
              {delivery.retryCount > 0 && (
                <div className="grid grid-cols-[1fr_2fr] gap-2">
                  <span className="text-muted-foreground">Retry count</span>
                  <span>{delivery.retryCount}</span>
                </div>
              )}
            </div>
          )}

          {activeTab === "build" && (
            <div className="text-xs">
              {hasBuild ? (
                <div className="space-y-2">
                  <p className="text-muted-foreground">
                    This delivery triggered a build.
                  </p>
                  <a
                    href={`/apps/${appId}/builds/${delivery.buildId}/logs`}
                    className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                  >
                    View build logs →
                  </a>
                </div>
              ) : (
                <p className="text-muted-foreground italic">
                  No build was triggered by this delivery.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer — Redeliver */}
        <div className="flex justify-end border-t border-border pt-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setReplayDialogOpen(true)}
            aria-label="Redeliver this webhook"
          >
            ⟲ Redeliver
          </Button>
        </div>
      </DialogContent>

      {delivery && (
        <ReplayTotpDialog
          open={replayDialogOpen}
          onOpenChange={setReplayDialogOpen}
          appId={appId}
          deliveryId={delivery.id}
          onReplayed={(newId) => {
            onDeliveryReplayed?.(newId)
          }}
        />
      )}
    </Dialog>
  )
}
