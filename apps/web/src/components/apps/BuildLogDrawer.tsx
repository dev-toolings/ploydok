// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  RiCheckLine,
  RiCloseLine,
  RiCornerDownRightLine,
  RiDownloadLine,
  RiErrorWarningLine,
  RiExpandDiagonalLine,
  RiFileCopyLine,
  RiGitCommitLine,
  RiLoader4Line,
  RiSubtractLine,
  RiTimeLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../i18n/sheet"
import { BuildLogViewer } from "./BuildLogViewer"
import type { Build, BuildStatus } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

const STATUS_BADGE: Record<
  BuildStatus,
  { label: string; cls: string; Icon: typeof RiCheckLine; pulse?: boolean }
> = {
  pending: {
    label: "Pending",
    cls: "bg-muted text-muted-foreground ring-border",
    Icon: RiTimeLine,
  },
  running: {
    label: "Running",
    cls: "bg-blue-500/15 text-blue-300 ring-blue-500/30",
    Icon: RiLoader4Line,
    pulse: true,
  },
  succeeded: {
    label: "Succeeded",
    cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    Icon: RiCheckLine,
  },
  succeeded_with_warning: {
    label: "Warning",
    cls: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
    Icon: RiErrorWarningLine,
  },
  failed: {
    label: "Failed",
    cls: "bg-red-500/15 text-red-300 ring-red-500/30",
    Icon: RiErrorWarningLine,
  },
  cancelled: {
    label: "Cancelled",
    cls: "bg-muted text-muted-foreground ring-border",
    Icon: RiSubtractLine,
  },
}

function formatDuration(startMs?: number, endMs?: number): string | null {
  if (!startMs) return null
  const diff = Math.max(0, ((endMs ?? Date.now()) - startMs) / 1000)
  if (diff < 1) return "<1s"
  if (diff < 60) return `${Math.round(diff)}s`
  const m = Math.floor(diff / 60)
  const s = Math.round(diff % 60)
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

function formatRelative(ms?: number): string | null {
  if (!ms) return null
  const diff = (Date.now() - ms) / 1000
  if (diff < 5) return "just now"
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: BuildStatus }): React.JSX.Element {
  const { label, cls, Icon, pulse } = STATUS_BADGE[status]
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        cls
      )}
    >
      <Icon
        className={cn("size-3", pulse && "animate-spin")}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// CommitChip — SHA + copy + truncated message
// ---------------------------------------------------------------------------

function CommitChip({
  sha,
  message,
}: {
  sha: string
  message?: string | null
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(sha)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard unavailable */
    }
  }, [sha])

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => void handleCopy()}
        title={copied ? "Copied" : `Copy commit SHA (${sha})`}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-foreground transition-colors hover:bg-muted"
      >
        <RiGitCommitLine className="size-3" aria-hidden="true" />
        {sha.slice(0, 7)}
        {copied ? (
          <RiCheckLine className="size-3 text-emerald-400" aria-hidden="true" />
        ) : (
          <RiFileCopyLine
            className="size-3 opacity-0 group-hover:opacity-60"
            aria-hidden="true"
          />
        )}
      </button>
      {message && (
        <span className="hidden max-w-[28rem] truncate text-muted-foreground md:inline">
          {message}
        </span>
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// LiveDuration — ticks every second when build is in progress
// ---------------------------------------------------------------------------

function LiveDuration({ build }: { build: Build }): React.JSX.Element | null {
  const inProgress = build.status === "running" || build.status === "pending"
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    if (!inProgress) return
    const id = setInterval(forceTick, 1000)
    return () => clearInterval(id)
  }, [inProgress])

  const dur = formatDuration(build.startedAt, build.finishedAt)
  if (!dur) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
      <RiTimeLine className="size-3" aria-hidden="true" />
      {dur}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BuildLogDrawerProps {
  appId: string
  /** The build ID to display logs for. `undefined` means the drawer is closed. */
  buildId: string | undefined
  /** Optional rich build object — enables status badge, commit, duration in header. */
  build?: Build
  /** Optional app name shown in header for context. */
  appName?: string
  /** Called when the drawer is closed. */
  onClose: () => void
}

const FULLSCREEN_KEY = "ploydok:logs:fullscreen"

// ---------------------------------------------------------------------------
// BuildLogDrawer
// ---------------------------------------------------------------------------

export function BuildLogDrawer({
  appId,
  buildId,
  build,
  appName,
  onClose,
}: BuildLogDrawerProps): React.JSX.Element {
  const isOpen = Boolean(buildId)
  const isTerminalBuild = build
    ? build.status !== "pending" && build.status !== "running"
    : false

  // Persisted fullscreen preference
  const [fullscreen, setFullscreen] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return false
    return window.localStorage.getItem(FULLSCREEN_KEY) === "1"
  })
  const toggleFullscreen = React.useCallback(() => {
    setFullscreen((v) => {
      const next = !v
      try {
        window.localStorage.setItem(FULLSCREEN_KEY, next ? "1" : "0")
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }, [])

  // Keyboard: F toggles fullscreen (Esc is handled by Sheet)
  React.useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const isInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      if (isInput) return
      if (e.key === "F" || (e.key === "f" && !e.ctrlKey && !e.metaKey)) {
        e.preventDefault()
        toggleFullscreen()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [isOpen, toggleFullscreen])

  const handleDownload = React.useCallback(async () => {
    if (!buildId) return
    try {
      const url = `/api/apps/${appId}/logs?buildId=${encodeURIComponent(buildId)}`
      const resp = await fetch(url)
      if (!resp.ok) {
        console.error("Failed to download logs:", resp.statusText)
        return
      }
      const blob = await resp.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = objectUrl
      a.download = `build-${buildId.slice(0, 8)}.log`
      a.click()
      URL.revokeObjectURL(objectUrl)
    } catch (err) {
      console.error("Download error:", err)
    }
  }, [appId, buildId])

  const shortId = buildId ? buildId.slice(0, 8) : ""
  const failureDetails =
    build?.status === "failed" && build.errorMessage
      ? {
          title: "Build failed",
          tone: "red" as const,
          message: build.errorMessage,
        }
      : build?.status === "succeeded_with_warning" && build.postDeployError
        ? {
            title: "Post-deploy hook failed",
            tone: "amber" as const,
            message: build.postDeployError,
          }
        : null

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className={cn(
          "flex flex-col gap-0 border-border bg-background p-0 transition-[width,max-width] duration-200",
          fullscreen
            ? "!w-screen !max-w-none sm:!max-w-none"
            : "!w-[95vw] !max-w-[95vw] sm:!max-w-[95vw]"
        )}
      >
        {/* ───────── Header ───────── */}
        <SheetHeader className="flex flex-row items-center gap-3 space-y-0 border-b border-border bg-muted/40 px-4 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* Top row: status + title + commit */}
            <div className="flex min-w-0 items-center gap-2">
              {build && <StatusBadge status={build.status} />}
              <SheetTitle className="truncate text-sm font-medium text-foreground">
                {appName ? (
                  <span className="text-muted-foreground">{appName}</span>
                ) : null}
                {appName && (
                  <RiCornerDownRightLine
                    className="mx-1 inline-block size-3 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                )}
                <span className="font-mono text-foreground">Build {shortId}</span>
              </SheetTitle>
              {build?.commitSha && (
                <CommitChip
                  sha={build.commitSha}
                  message={build.commitMessage ?? null}
                />
              )}
            </div>
            {/* Bottom row: meta */}
            {build && (
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <LiveDuration build={build} />
                {build.startedAt && (
                  <span className="inline-flex items-center gap-1">
                    started {formatRelative(build.startedAt)}
                  </span>
                )}
                {build.buildMethod && (
                  <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                    {build.buildMethod}
                  </span>
                )}
                {build.postDeployError && (
                  <span className="inline-flex items-center gap-1 text-amber-400">
                    <RiErrorWarningLine className="size-3" aria-hidden="true" />
                    post-deploy hook failed
                  </span>
                )}
                {build.errorMessage && (
                  <span
                    className="inline-flex min-w-0 items-center gap-1 text-red-400"
                    title={build.errorMessage}
                  >
                    <RiErrorWarningLine className="size-3" aria-hidden="true" />
                    <span className="max-w-[420px] truncate">
                      {build.errorMessage}
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ───────── Actions ───────── */}
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleDownload()}
              disabled={!buildId}
              title="Download raw .log file"
              className="h-8 gap-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RiDownloadLine className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">Download</span>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={toggleFullscreen}
              title={
                fullscreen ? "Exit fullscreen (F)" : "Toggle fullscreen (F)"
              }
              aria-label="Toggle fullscreen"
              className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RiExpandDiagonalLine className="size-4" aria-hidden="true" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={onClose}
              title="Close (Esc)"
              aria-label="Close"
              className="h-8 w-8 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RiCloseLine className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </SheetHeader>

        {failureDetails ? (
          <div
            className={cn(
              "shrink-0 border-b px-4 py-3",
              failureDetails.tone === "red"
                ? "border-red-500/25 bg-red-500/10"
                : "border-amber-500/25 bg-amber-500/10"
            )}
          >
            <div className="flex items-start gap-2">
              <RiErrorWarningLine
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  failureDetails.tone === "red"
                    ? "text-red-300"
                    : "text-amber-300"
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-xs font-semibold",
                    failureDetails.tone === "red"
                      ? "text-red-200"
                      : "text-amber-200"
                  )}
                >
                  {failureDetails.title}
                </p>
                <pre
                  className={cn(
                    "mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed",
                    failureDetails.tone === "red"
                      ? "text-red-100/90"
                      : "text-amber-100/90"
                  )}
                >
                  {failureDetails.message}
                </pre>
              </div>
            </div>
          </div>
        ) : null}

        {/* ───────── Body ───────── */}
        <div className="flex-1 overflow-hidden p-3">
          {buildId && (
            <BuildLogViewer
              appId={appId}
              buildId={buildId}
              archiveOnly={isTerminalBuild}
              appName={appName}
              className="h-full min-h-[500px]"
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
