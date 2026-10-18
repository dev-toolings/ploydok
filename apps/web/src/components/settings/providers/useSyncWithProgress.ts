// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useEventsSubscription } from "../../../lib/events-provider"
import i18n from "../../../lib/i18n"
import { apiFetch } from "../../../lib/api"
import type { SyncStatus } from "./SyncProgressDialog"

// ---------------------------------------------------------------------------
// Correlated SSE progress with persisted, per-user sync reconciliation.
//
// The Sync mutation only confirms enqueue; the worker reports actual progress
// via the existing /events SSE stream. We filter events by syncId (returned by
// POST /…/installations/sync) so concurrent syncs don't cross-contaminate.
//
// Event types (declared in apps/api/src/worker/event-bus.ts):
//   provider.sync.started    { provider, scope, syncId, installationCount? }
//   provider.sync.progress   { syncId, page, reposFetched, hasMore, ... }
//   provider.sync.completed  { syncId, totalRepos, durationMs }
//   provider.sync.failed     { syncId, error }
// ---------------------------------------------------------------------------

// The /events SSE dispatcher delivers the full NotificationEvent envelope.
// Worker-side payloads land under `data` (see emit() in
// apps/api/src/worker/handlers/sync-provider-repos.ts).
interface ProviderSyncEnvelope {
  id: string
  type: string
  t: number
  message: string
  data?: ProviderSyncData
}

interface ProviderSyncData {
  syncId?: string | null
  page?: number
  reposFetched?: number
  totalRepos?: number
  installationCount?: number
  installationId?: string
  error?: string
  durationMs?: number
}

export interface SyncProgressState {
  open: boolean
  status: SyncStatus
  startedAt: number | null
  importedCount: number
  totalCount: number
  errorMessage?: string
  begin: (syncId: string) => void
  fail: (message: string) => void
  close: () => void
}

export function useSyncWithProgress(): SyncProgressState {
  const [open, setOpen] = React.useState(false)
  const [syncId, setSyncId] = React.useState<string | null>(null)
  const [startedAt, setStartedAt] = React.useState<number | null>(null)
  const [status, setStatus] = React.useState<SyncStatus>("idle")
  const [errorMessage, setErrorMessage] = React.useState<string | undefined>(
    undefined
  )
  const [importedCount, setImportedCount] = React.useState(0)
  const [totalCount, setTotalCount] = React.useState(0)
  const [reconcile, setReconcile] = React.useState(0)

  // Stable refs so useEventsSubscription doesn't re-attach on every render.
  const syncIdRef = React.useRef<string | null>(null)
  const runningRef = React.useRef(false)
  React.useEffect(() => {
    syncIdRef.current = syncId
  }, [syncId])

  function isMine(envelope: ProviderSyncEnvelope): boolean {
    return (
      runningRef.current &&
      syncIdRef.current != null &&
      envelope.data?.syncId === syncIdRef.current
    )
  }

  const onStarted = React.useCallback((envelope: ProviderSyncEnvelope) => {
    if (!isMine(envelope)) return
    setStatus("running")
  }, [])

  const onProgress = React.useCallback((envelope: ProviderSyncEnvelope) => {
    if (!isMine(envelope)) return
    const fetched = envelope.data?.reposFetched
    if (typeof fetched === "number") {
      setImportedCount(fetched)
      setTotalCount((prev) => Math.max(prev, fetched))
    }
  }, [])

  const onCompleted = React.useCallback((envelope: ProviderSyncEnvelope) => {
    if (!isMine(envelope)) return
    // One sync can include several installations. Confirm all targets have
    // finished instead of ending the dialog on the first completed event.
    setReconcile((value) => value + 1)
  }, [])

  const onFailed = React.useCallback((envelope: ProviderSyncEnvelope) => {
    if (!isMine(envelope)) return
    runningRef.current = false
    setStatus("error")
    setErrorMessage(envelope.data?.error ?? i18n.t("settings:sync.failed"))
  }, [])

  useEventsSubscription<ProviderSyncEnvelope>(
    "provider.sync.started",
    onStarted,
    true,
    { replay: true }
  )
  useEventsSubscription<ProviderSyncEnvelope>(
    "provider.sync.progress",
    onProgress,
    true,
    { replay: true }
  )
  useEventsSubscription<ProviderSyncEnvelope>(
    "provider.sync.completed",
    onCompleted,
    true,
    { replay: true }
  )
  useEventsSubscription<ProviderSyncEnvelope>(
    "provider.sync.failed",
    onFailed,
    true,
    { replay: true }
  )

  React.useEffect(() => {
    if (syncId == null || status !== "running" || startedAt == null) return
    const controller = new AbortController()
    let timer: number | undefined
    const timeout = window.setTimeout(
      () => {
        runningRef.current = false
        setStatus("error")
        setErrorMessage(i18n.t("settings:sync.timedOut"))
        controller.abort()
      },
      Math.max(0, startedAt + 5 * 60_000 - Date.now())
    )

    async function poll(): Promise<void> {
      try {
        const result = await apiFetch<{
          status: "running" | "done" | "error"
          totalRepos?: number
          error?: string
        }>(`/events/provider-sync/${encodeURIComponent(syncId!)}`)
        if (controller.signal.aborted || !runningRef.current) return
        if (result.status !== "running") {
          runningRef.current = false
          setStatus(result.status)
          setImportedCount(result.totalRepos ?? 0)
          setTotalCount(result.totalRepos ?? 0)
          setErrorMessage(
            result.error ??
              (result.status === "error"
                ? i18n.t("settings:sync.failed")
                : undefined)
          )
          return
        }
      } catch {
        // Retry transient errors and expired/missing receipts until the bounded
        // deadline. Never infer success from an unrelated fresh cache entry.
      }
      if (!controller.signal.aborted && runningRef.current)
        timer = window.setTimeout(poll, 2000)
    }
    void poll()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
      window.clearTimeout(timeout)
    }
  }, [syncId, status, startedAt, reconcile])

  function begin(newSyncId: string): void {
    syncIdRef.current = newSyncId
    runningRef.current = true
    setSyncId(newSyncId)
    setStartedAt(Date.now())
    setStatus("running")
    setErrorMessage(undefined)
    setImportedCount(0)
    setTotalCount(0)
    setOpen(true)
  }

  function fail(message: string): void {
    runningRef.current = false
    setStatus("error")
    setErrorMessage(message)
    setOpen(true)
  }

  function close(): void {
    runningRef.current = false
    setOpen(false)
    // Reset on next tick so the dialog fades out cleanly.
    window.setTimeout(() => {
      syncIdRef.current = null
      setSyncId(null)
      setStartedAt(null)
      setStatus("idle")
      setErrorMessage(undefined)
      setImportedCount(0)
      setTotalCount(0)
    }, 250)
  }

  return {
    open,
    status,
    startedAt,
    importedCount,
    totalCount,
    errorMessage,
    begin,
    fail,
    close,
  }
}
