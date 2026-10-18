// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
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
  DialogTrigger,
} from "../i18n/dialog"
import type { CreateDomainParams, Dns01Provider, TlsMode } from "../../lib/domains"

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const HOSTNAME_REGEX = new RegExp(`^(?:${DNS_LABEL}\\.)+[a-z]{2,63}$`, "i")
const WILDCARD_HOSTNAME_REGEX = new RegExp(
  `^\\*\\.(?:${DNS_LABEL}\\.)+[a-z]{2,63}$`,
  "i"
)

const DNS01_PROVIDERS: Array<{ value: Dns01Provider; label: string }> = [
  { value: "cloudflare", label: "Cloudflare" },
  { value: "route53", label: "AWS Route 53" },
  { value: "ovh", label: "OVH" },
  { value: "digitalocean", label: "DigitalOcean" },
]

export interface AddDomainDialogProps {
  onAdd: (params: CreateDomainParams) => void
  isAdding?: boolean
  lockReason?: string
}

function normalizeHostname(rawHostname: string, wildcard: boolean) {
  const lower = rawHostname.trim().toLowerCase()
  return wildcard && !lower.startsWith("*.") ? `*.${lower}` : lower
}

function validateHostname(
  hostname: string,
  tlsMode: TlsMode,
  t: (key: string) => string
): string | null {
  if (hostname.length > 253) return t("domains.tooLong")
  if (hostname.startsWith("*.")) {
    if (tlsMode !== "dns01") {
      return t("domains.wildcardRequiresDns")
    }
    return WILDCARD_HOSTNAME_REGEX.test(hostname)
      ? null
      : t("domains.invalidWildcard")
  }
  return HOSTNAME_REGEX.test(hostname)
    ? null
    : t("domains.invalidHostname")
}

export function AddDomainDialog({ onAdd, isAdding, lockReason }: AddDomainDialogProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [open, setOpen] = React.useState(false)
  const [hostname, setHostname] = React.useState("")
  const [tlsMode, setTlsMode] = React.useState<TlsMode>("http01")
  const [dns01Provider, setDns01Provider] = React.useState<Dns01Provider>("cloudflare")
  const [wildcard, setWildcard] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const normalized = normalizeHostname(hostname, wildcard)
    const validationError = validateHostname(normalized, tlsMode, t)
    if (validationError) {
      setError(validationError)
      return
    }
    if (tlsMode === "dns01" && !dns01Provider) {
      setError(t("domains.selectDnsProvider"))
      return
    }
    setError(null)
    onAdd({
      hostname: normalized,
      tls_mode: tlsMode,
      dns01_provider: tlsMode === "dns01" ? dns01Provider : undefined,
      wildcard,
    })
    setOpen(false)
    setHostname("")
    setTlsMode("http01")
    setWildcard(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={Boolean(lockReason)}>
          {t("domains.addDomain")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("domains.addCustom")}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="hostname">{t("domains.hostname")}</Label>
            <Input
              id="hostname"
              placeholder={t("domains.placeholder")}
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("domains.tlsMode")}</Label>
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
                  onClick={() => {
                    setTlsMode(mode)
                    if (mode === "http01") setWildcard(false)
                    if (error) setError(null)
                  }}
                >
                  {mode === "http01" ? t("domains.http01") : t("domains.dns01")}
                </button>
              ))}
            </div>
          </div>

          {tlsMode === "dns01" && (
            <div className="space-y-1.5">
              <Label htmlFor="provider">{t("domains.dnsProvider")}</Label>
              <Select
                value={dns01Provider}
                onValueChange={(value) => setDns01Provider(value as Dns01Provider)}
              >
                <SelectTrigger id="provider">
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

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={wildcard}
                  onChange={(e) => setWildcard(e.target.checked)}
                  className="rounded"
                />
                {t("domains.wildcardCert", {
                  hostname: hostname || t("domains.exampleCom"),
                })}
              </label>
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={isAdding || !hostname}>
              {isAdding ? t("domains.adding") : t("domains.addDomain")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
