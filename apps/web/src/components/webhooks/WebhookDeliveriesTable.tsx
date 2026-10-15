// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Button } from "@workspace/ui/components/button"
import { DECISION_LABELS, listDeliveries } from "../../lib/webhooks"
import { DeliveryDetailsDialog } from "./DeliveryDetailsDialog"
import type { DeliveryDecision, WebhookDelivery } from "../../lib/webhooks"

// ---------------------------------------------------------------------------
// Decision badge
// ---------------------------------------------------------------------------

const SKIPPED_CLASS = "bg-muted text-muted-foreground"
const FAILED_CLASS = "bg-neg-100 dark:bg-[#4d0218]/60 text-neg-700 dark:text-[#ff637e]"

const DECISION_CLASS: Record<DeliveryDecision, string> = {
  enqueued: "bg-pos-100 dark:bg-[#192e03]/60 text-pos-700 dark:text-[#9ae600]",
  coalesced: "bg-warn-100 dark:bg-[#432004]/60 text-warn-700 dark:text-[#fdc700]",
  retried: "bg-brand-100 dark:bg-[#162456]/60 text-brand-700 dark:text-[#51a2ff]",
  skipped_disabled: SKIPPED_CLASS,
  skipped_branch: SKIPPED_CLASS,
  skipped_path: SKIPPED_CLASS,
  skipped_directive: SKIPPED_CLASS,
  skipped_unknown_app: SKIPPED_CLASS,
  skipped_tag_disabled: SKIPPED_CLASS,
  skipped_tag_pattern: SKIPPED_CLASS,
  invalid_signature: FAILED_CLASS,
  error: FAILED_CLASS,
}

function DecisionBadge({
  decision,
  reason,
}: {
  decision: DeliveryDecision
  reason?: string | null
}): React.JSX.Element {
  const className = DECISION_CLASS[decision]
  const label = DECISION_LABELS[decision]

  return (
    <span
      title={reason ?? label}
      className={[
        "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium",
        className,
      ].join(" ")}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(isoDate: string | null | undefined): string {
  if (!isoDate) return "—"
  const ts = new Date(isoDate).getTime()
  if (Number.isNaN(ts)) return "—"
  const diff = Date.now() - ts
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function safeIso(isoDate: string | null | undefined): string {
  if (!isoDate) return ""
  const d = new Date(isoDate)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString()
}

// ---------------------------------------------------------------------------
// Branch extraction
// ---------------------------------------------------------------------------

function refToBranch(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length)
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length)
  return ref
}

// ---------------------------------------------------------------------------
// WebhookDeliveriesTable
// ---------------------------------------------------------------------------

interface WebhookDeliveriesTableProps {
  appId: string
}

export function WebhookDeliveriesTable({
  appId,
}: WebhookDeliveriesTableProps): React.JSX.Element {
  const [deliveries, setDeliveries] = React.useState<Array<WebhookDelivery>>([])
  const [nextCursor, setNextCursor] = React.useState<string | undefined>(
    undefined
  )
  const [loading, setLoading] = React.useState(true)
  const [loadingMore, setLoadingMore] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<WebhookDelivery | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    listDeliveries(appId)
      .then((page) => {
        if (cancelled) return
        setDeliveries(page.deliveries)
        setNextCursor(page.nextCursor)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof Error ? err.message : "Failed to load deliveries"
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [appId])

  const handleLoadMore = async (): Promise<void> => {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const page = await listDeliveries(appId, nextCursor)
      setDeliveries((prev) => [...prev, ...page.deliveries])
      setNextCursor(page.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more")
    } finally {
      setLoadingMore(false)
    }
  }

  const handleOpenDelivery = (delivery: WebhookDelivery): void => {
    setSelected(delivery)
    setDialogOpen(true)
  }

  const handleDeliveryReplayed = (_newDeliveryId: string): void => {
    // Refresh deliveries list to show the new replay entry
    setLoading(true)
    setError(null)
    listDeliveries(appId)
      .then((page) => {
        setDeliveries(page.deliveries)
        setNextCursor(page.nextCursor)
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : "Failed to reload deliveries"
        )
      })
      .finally(() => setLoading(false))
  }

  if (loading) {
    return (
      <div
        className="space-y-2"
        aria-busy="true"
        aria-label="Loading webhook deliveries"
      >
        {[...Array<null>(5)].map((_, i) => (
          <div key={i} className="h-10 skeleton-surface rounded-md" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    )
  }

  if (deliveries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <svg
            aria-hidden="true"
            className="h-5 w-5 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
            />
          </svg>
        </div>
        <p className="text-sm font-medium">No deliveries yet</p>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Nothing has reached this app yet. Check the signing secret below, then
          the webhook URL on your provider, then the tracked branch.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium text-muted-foreground"
              >
                Time
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium text-muted-foreground"
              >
                Event
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium text-muted-foreground"
              >
                Branch / Ref
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium text-muted-foreground"
              >
                Commit
              </th>
              <th
                scope="col"
                className="px-3 py-2 text-left font-medium text-muted-foreground"
              >
                Decision
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr
                key={d.id}
                className="border-b border-border transition-colors last:border-0 hover:bg-muted/50"
              >
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  <time dateTime={d.receivedAt} title={safeIso(d.receivedAt)}>
                    {relativeTime(d.receivedAt)}
                  </time>
                </td>
                <td className="px-3 py-2 font-mono whitespace-nowrap">
                  {d.event}
                </td>
                <td className="max-w-[120px] truncate px-3 py-2">
                  {d.ref ? (
                    refToBranch(d.ref)
                  ) : (
                    <span className="text-muted-foreground italic">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {d.commitSha ? (
                    <span className="font-mono">{d.commitSha.slice(0, 7)}</span>
                  ) : null}
                  {d.commitMessage && (
                    <span className="ml-1.5 inline-block max-w-[120px] truncate align-bottom text-muted-foreground">
                      {d.commitMessage.slice(0, 40)}
                      {d.commitMessage.length > 40 ? "…" : ""}
                    </span>
                  )}
                  {!d.commitSha && !d.commitMessage && (
                    <span className="text-muted-foreground italic">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <DecisionBadge
                    decision={d.decision}
                    reason={d.decisionReason}
                  />
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Show delivery details"
                    onClick={() => handleOpenDelivery(d)}
                    className="text-muted-foreground"
                  >
                    •••
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <div className="mt-3 flex justify-center">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleLoadMore()}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <DeliveryDetailsDialog
        delivery={selected}
        appId={appId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onDeliveryReplayed={handleDeliveryReplayed}
      />
    </>
  )
}
