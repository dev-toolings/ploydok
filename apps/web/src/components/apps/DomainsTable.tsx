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
import type { Domain } from "../../lib/apps-domains"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hostname validation regex — matches the server-side rule in apps-domains.ts.
 * Accepts: letters, digits, hyphens, dots; TLD ≥ 2 letters; length ≤ 255.
 */
const HOSTNAME_REGEX = /^[a-z0-9][a-z0-9.-]{1,253}\.[a-z]{2,}$/i

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainsTableProps {
  domains: Array<Domain>
  isLoading?: boolean
  isAdding?: boolean
  isDeleting?: boolean
  isRechecking?: boolean
  onAdd: (hostname: string) => void
  onDelete: (domainId: string) => void
  onRecheck: (domainId: string) => void
  /** When set, add/delete are disabled with this tooltip (e.g. 2FA required). */
  lockReason?: string
}

// ---------------------------------------------------------------------------
// TLS status badge
// ---------------------------------------------------------------------------

function TlsBadge({ status }: { status: Domain["tlsStatus"] }): React.JSX.Element {
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
// Add-domain row (input + button at the bottom of the table)
// ---------------------------------------------------------------------------

interface AddDomainRowProps {
  isAdding: boolean
  onAdd: (hostname: string) => void
  lockReason?: string
}

function AddDomainRow({ isAdding, onAdd, lockReason }: AddDomainRowProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [value, setValue] = React.useState("")
  const [error, setError] = React.useState<string | undefined>()

  function validate(h: string): string | undefined {
    if (!h) return t("domains.hostnameRequired")
    if (!HOSTNAME_REGEX.test(h)) return t("domains.invalidHostname")
    return undefined
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const err = validate(value.trim())
    if (err) {
      setError(err)
      return
    }
    setError(undefined)
    onAdd(value.trim())
    setValue("")
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value)
    if (error) setError(validate(e.target.value.trim()))
  }

  return (
    <tr className="border-t border-border bg-muted/10">
      <td colSpan={3} className="px-4 py-3">
        <form onSubmit={handleSubmit} className="flex flex-col gap-1.5 sm:flex-row sm:items-start">
          <div className="flex flex-1 flex-col gap-1">
            <input
              type="text"
              value={value}
              onChange={handleChange}
              placeholder={t("domains.placeholder")}
              aria-label={t("domains.newHostname")}
              className="h-8 w-full rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              disabled={isAdding || Boolean(lockReason)}
              title={lockReason}
            />
            {error && <p className="text-[11px] text-destructive">{error}</p>}
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            loading={isAdding}
            disabled={!value.trim() || Boolean(lockReason)}
            className="shrink-0"
            title={lockReason}
          >
            {isAdding ? t("domains.adding") : t("domains.addDomain")}
          </Button>
        </form>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// DomainsTable
// ---------------------------------------------------------------------------

export function DomainsTable({
  domains,
  isLoading = false,
  isAdding = false,
  isDeleting = false,
  isRechecking = false,
  onAdd,
  onDelete,
  onRecheck,
  lockReason,
}: DomainsTableProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  return (
    <div className="w-full overflow-hidden rounded-lg border border-border">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-[55%]" />
          <col className="w-[20%]" />
          <col className="w-[25%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs font-medium text-muted-foreground">
            <th className="px-4 py-2.5">{t("domains.hostname")}</th>
            <th className="px-4 py-2.5">{t("domains.tlsStatus")}</th>
            <th className="px-4 py-2.5 text-right">{t("common:actions")}</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <DomainsSkeletonRows />
          ) : domains.length === 0 ? (
            <tr>
              <td
                colSpan={3}
                className="px-4 py-8 text-center text-sm text-muted-foreground"
              >
                {t("domains.emptyCustom")}
              </td>
            </tr>
          ) : (
            domains.map((domain) => (
              <tr
                key={domain.id}
                className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
              >
                <td className="px-4 py-3 font-mono text-sm break-all">
                  {domain.hostname}
                </td>
                <td className="px-4 py-3">
                  <TlsBadge status={domain.tlsStatus} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      loading={isRechecking}
                      onClick={() => onRecheck(domain.id)}
                      title={t("domains.recheckTls")}
                    >
                      <RecheckIcon className="size-3.5" />
                      <span className="sr-only">{t("domains.recheck")}</span>
                    </Button>

                    <DeleteDomainButton
                      hostname={domain.hostname}
                      domainId={domain.id}
                      isDeleting={isDeleting}
                      onDelete={onDelete}
                      lockReason={lockReason}
                    />
                  </div>
                </td>
              </tr>
            ))
          )}
          <AddDomainRow isAdding={isAdding} onAdd={onAdd} lockReason={lockReason} />
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// DomainsSkeletonRows — placeholder rows mirroring the table's shape
// ---------------------------------------------------------------------------

function DomainsSkeletonRows(): React.JSX.Element {
  return (
    <>
      {Array.from({ length: 3 }).map((_, i) => (
        <tr key={i} className="border-b border-border last:border-0">
          <td className="px-4 py-3">
            <div className="h-4 w-3/4 rounded skeleton-surface" />
          </td>
          <td className="px-4 py-3">
            <div className="h-5 w-20 rounded-full skeleton-surface" />
          </td>
          <td className="px-4 py-3">
            <div className="flex items-center justify-end gap-2">
              <div className="size-7 rounded skeleton-surface" />
              <div className="size-7 rounded skeleton-surface" />
            </div>
          </td>
        </tr>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// DeleteDomainButton — wraps an AlertDialog confirm
// ---------------------------------------------------------------------------

interface DeleteDomainButtonProps {
  hostname: string
  domainId: string
  isDeleting: boolean
  onDelete: (domainId: string) => void
  lockReason?: string
}

function DeleteDomainButton({
  hostname,
  domainId,
  isDeleting,
  onDelete,
  lockReason,
}: DeleteDomainButtonProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          loading={isDeleting} disabled={Boolean(lockReason)}
          title={lockReason ?? t("domains.removeHostname", { hostname })}
        >
          <TrashIcon className="size-3.5" />
          <span className="sr-only">{t("common:delete")}</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("domains.removeConfirm")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("domains.removeHint", { hostname })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-none bg-destructive text-white hover:bg-destructive/90"
            onClick={() => onDelete(domainId)}
          >
            {t("domains.remove")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function RecheckIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

function TrashIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M8 6V4h8v2" />
    </svg>
  )
}
