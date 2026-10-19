// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import {
  RiDeleteBinLine,
  RiFileCopyLine,
  RiLoopRightLine,
  RiShieldKeyholeLine,
  RiShuffleLine,
} from "@remixicon/react"
import { toast } from "sonner"
import { copyToClipboard } from "../../lib/clipboard"
import type { Domain, TlsStatus } from "../../lib/domains"

// ---------------------------------------------------------------------------
// TLS status badge
// ---------------------------------------------------------------------------

function TlsBadge({ status }: { status: TlsStatus }): React.JSX.Element {
  const { t } = useTranslation("apps")
  if (status === "not_required") {
    return <span className="text-xs text-muted-foreground">{t("routing.tlsStatus.not_required")}</span>
  }
  if (status === "issued") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        {t("domains.issued")}
      </span>
    )
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-400">
        <span className="size-1.5 rounded-full bg-red-500" />
        {t("domains.failed")}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
      <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
      {t("domains.pending")}
    </span>
  )
}

// ---------------------------------------------------------------------------
// TLS mode badge
// ---------------------------------------------------------------------------

function TlsModeBadge({ mode }: { mode: Domain["tlsMode"] }): React.JSX.Element {
  if (mode === "dns01") {
    return (
      <span className="inline-flex rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-mono text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
        DNS-01
      </span>
    )
  }
  return (
    <span className="inline-flex rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-400">
      HTTP-01
    </span>
  )
}

// ---------------------------------------------------------------------------
// DomainCard
// ---------------------------------------------------------------------------

export interface DomainCardProps {
  domain: Domain
  onDelete: (domainId: string) => void
  onRetry: (domainId: string) => void
  onSwitchMode: (domainId: string) => void
  isDeleting?: boolean
  isRetrying?: boolean
  lockReason?: string
}

export function DomainCard({
  domain,
  onDelete,
  onRetry,
  onSwitchMode,
  isDeleting,
  isRetrying,
  lockReason,
}: DomainCardProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const verificationHost = domain.hostname.replace(/^\*\./, "")
  const verificationName = `_ploydok-verify.${verificationHost}`
  const actionLocked = Boolean(lockReason)

  async function copyTxtValue(value: string, label: string) {
    await copyToClipboard(value)
    toast.success(t("domains.copied", { label }))
  }

  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-panel px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono text-sm font-medium">{domain.hostname}</span>
          <TlsModeBadge mode={domain.tlsMode} />
          {domain.dns01Provider && (
            <span className="text-[10px] text-muted-foreground">{domain.dns01Provider}</span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1 self-start">
          <TlsBadge status={domain.tlsStatus} />

          {(domain.tlsStatus !== "issued" && domain.tlsStatus !== "not_required") && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 px-0"
              disabled={isRetrying || actionLocked}
              onClick={() => onRetry(domain.id)}
              title={lockReason ?? t("domains.recheckVerification")}
            >
              <RiLoopRightLine className="size-4" aria-hidden="true" />
              <span className="sr-only">{t("domains.recheckVerificationSr")}</span>
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 px-0"
            disabled={actionLocked}
            onClick={() => onSwitchMode(domain.id)}
            title={lockReason ?? t("domains.switchTls")}
          >
            <RiShuffleLine className="size-4" aria-hidden="true" />
            <span className="sr-only">{t("domains.switchTls")}</span>
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 px-0 text-destructive hover:text-destructive"
                loading={isDeleting} disabled={actionLocked}
                title={lockReason ?? t("domains.removeHostname", { hostname: domain.hostname })}
              >
                <RiDeleteBinLine className="size-4" aria-hidden="true" />
                <span className="sr-only">{t("domains.removeDomain")}</span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("domains.removeConfirm")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("domains.removeHint", { hostname: domain.hostname })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-none bg-destructive text-white hover:bg-none hover:bg-destructive/90 active:bg-none"
                  onClick={() => onDelete(domain.id)}
                >
                  {t("domains.remove")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {domain.tlsStatus === "pending" && domain.verifyToken && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs dark:border-amber-800/50 dark:bg-amber-900/10">
          <div className="mb-2 flex items-center gap-1.5 font-medium text-amber-800 dark:text-amber-400">
            <RiShieldKeyholeLine className="size-3.5" aria-hidden="true" />
            {t("domains.ownershipRequired")}
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <TxtRecordField
              label={t("domains.txtName")}
              value={verificationName}
              onCopy={() => copyTxtValue(verificationName, t("domains.txtName"))}
            />
            <TxtRecordField
              label={t("domains.txtValue")}
              value={domain.verifyToken}
              onCopy={() =>
                copyTxtValue(domain.verifyToken ?? "", t("domains.txtValue"))
              }
            />
          </div>
        </div>
      )}

      {domain.verifyError && (domain.tlsStatus !== "issued" && domain.tlsStatus !== "not_required") && (
        <p className="text-xs text-destructive">{domain.verifyError}</p>
      )}
    </div>
  )
}

function TxtRecordField({
  label,
  value,
  onCopy,
}: {
  label: string
  value: string
  onCopy: () => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div className="min-w-0 rounded border border-amber-200/80 bg-background/70 p-2 dark:border-amber-800/50 dark:bg-background/40">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-amber-700 dark:text-amber-500">
          {label}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 w-6 px-0"
          onClick={() => void onCopy()}
          title={t("domains.copyLabel", { label })}
        >
          <RiFileCopyLine className="size-3.5" aria-hidden="true" />
          <span className="sr-only">{t("domains.copyLabel", { label })}</span>
        </Button>
      </div>
      <code className="block break-all font-mono text-amber-950 dark:text-amber-300">
        {value}
      </code>
    </div>
  )
}
