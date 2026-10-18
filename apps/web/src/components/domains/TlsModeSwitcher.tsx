// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import type { Dns01Provider, TlsMode } from "../../lib/domains"

const DNS01_PROVIDERS: Array<{ value: Dns01Provider; label: string }> = [
  { value: "cloudflare", label: "Cloudflare" },
  { value: "route53", label: "AWS Route 53" },
  { value: "ovh", label: "OVH" },
  { value: "digitalocean", label: "DigitalOcean" },
]

export interface TlsModeSwitcherProps {
  domainId: string
  currentMode: TlsMode
  currentProvider?: Dns01Provider | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSwitch: (params: { domainId: string; tls_mode: TlsMode; dns01_provider?: Dns01Provider }) => void
  isSwitching?: boolean
}

export function TlsModeSwitcher({
  domainId,
  currentMode,
  currentProvider,
  open,
  onOpenChange,
  onSwitch,
  isSwitching,
}: TlsModeSwitcherProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [tlsMode, setTlsMode] = React.useState<TlsMode>(currentMode)
  const [dns01Provider, setDns01Provider] = React.useState<Dns01Provider>(
    currentProvider ?? "cloudflare"
  )

  React.useEffect(() => {
    if (!open) return
    setTlsMode(currentMode)
    setDns01Provider(currentProvider ?? "cloudflare")
  }, [currentMode, currentProvider, open])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSwitch({
      domainId,
      tls_mode: tlsMode,
      dns01_provider: tlsMode === "dns01" ? dns01Provider : undefined,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("domains.switchTitle")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t("domains.challengeMode")}</Label>
            <div className="flex gap-2">
              {(["http01", "dns01"] as Array<TlsMode>).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={[
                    "flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors",
                    tlsMode === mode
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-muted",
                  ].join(" ")}
                  onClick={() => setTlsMode(mode)}
                >
                  {mode === "http01" ? t("domains.http01Short") : t("domains.dns01Short")}
                </button>
              ))}
            </div>
          </div>

          {tlsMode === "dns01" && (
            <div className="space-y-1.5">
              <Label htmlFor="switch-provider">{t("domains.dnsProvider")}</Label>
              <Select
                value={dns01Provider}
                onValueChange={(value) => setDns01Provider(value as Dns01Provider)}
              >
                <SelectTrigger id="switch-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DNS01_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isSwitching}>
              {isSwitching ? t("domains.switching") : t("domains.apply")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
