// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiArrowDownLine } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { cn } from "@workspace/ui/lib/utils"
import {
  detectLevel,
  filterByLevel,
  filterBySearch,
  useLogStream,
} from "../../lib/hooks/use-log-stream"
import { LogFilters, useLogFilters } from "./LogFilters"
import { LogLine } from "./LogLine"
import type { LogLine as LogLineData, LogSource } from "../../lib/hooks/use-log-stream"
import type { LogFiltersState } from "./LogFilters"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LogViewerProps {
  source: LogSource
  /** Optional resource name for the download filename and title bar */
  resourceName?: string
  className?: string
}

interface BuildLogViewerProps {
  appId: string
  /** Build ID — if undefined or "latest", streams runtime logs */
  buildId?: string
  /** For completed builds, read the persisted log archive instead of live WS. */
  archiveOnly?: boolean
  /** Optional app name for the download filename and title bar */
  appName?: string
  className?: string
}

// ---------------------------------------------------------------------------
// TitleBar
// ---------------------------------------------------------------------------

function TitleBar({
  title,
  isLive,
  lineCount,
  errorCount,
  warnCount,
}: {
  title: string
  isLive: boolean
  lineCount: number
  errorCount: number
  warnCount: number
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-white/10 bg-white/5 px-4">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          isLive ? "animate-pulse bg-emerald-500" : "bg-white/30"
        )}
        aria-hidden="true"
      />
      <span className="truncate text-xs font-medium text-[#e5e7eb]">
        {title}
      </span>
      <span className="shrink-0 text-xs text-white/40">
        {isLive ? t("logs.live") : t("logs.disconnected")}
      </span>
      <div className="flex-1" />
      {errorCount > 0 && (
        <span className="shrink-0 text-xs text-red-400 tabular-nums">
          {errorCount.toLocaleString()} {t("logs.err")}
        </span>
      )}
      {warnCount > 0 && (
        <span className="shrink-0 text-xs text-amber-400 tabular-nums">
          {warnCount.toLocaleString()} {t("logs.warnShort")}
        </span>
      )}
      {lineCount > 0 && (
        <span className="shrink-0 text-xs text-white/50 tabular-nums">
          {t("logs.linesCount", { count: lineCount.toLocaleString() })}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// FollowButton
// ---------------------------------------------------------------------------

function FollowButton({
  visible,
  newCount,
  onClick,
}: {
  visible: boolean
  newCount: number
  onClick: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation("apps")
  if (!visible) return null
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-4 bottom-4 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg transition-colors hover:bg-primary/90"
      title={t("logs.resumeTail")}
    >
      <RiArrowDownLine className="size-3.5" aria-hidden="true" />
      {t("logs.followLatest")}
      {newCount > 0 && (
        <span className="rounded-full bg-primary-foreground/20 px-1.5 py-0.5 text-xs">
          {newCount}
        </span>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({
  filtered,
  total,
  filters,
  connected,
  hasError,
  waitingHint,
}: {
  filtered: number
  total: number
  filters: LogFiltersState
  connected: boolean
  hasError: boolean
  waitingHint: string
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const hasFilter = filters.search.length > 0 || filters.level !== "all"
  if (filtered === 0 && total > 0 && hasFilter) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-12 text-center text-sm text-white/50">
        <span>{t("logs.noMatch")}</span>
        <span className="text-xs text-white/40">
          {t("logs.noMatchHint", { total: total.toLocaleString() })}
        </span>
      </div>
    )
  }
  if (filtered === 0 && total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-12 text-center text-sm text-white/50">
        {hasError ? (
          <span className="text-red-400">{t("logs.streamError")}</span>
        ) : connected ? (
          <>
            <span className="inline-flex items-center gap-2">
              <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
              {t("logs.connectedWaiting")}
            </span>
            <span className="text-xs text-white/40">{waitingHint}</span>
          </>
        ) : (
          <span>{t("logs.connecting")}</span>
        )}
      </div>
    )
  }
  return <></>
}

// ---------------------------------------------------------------------------
// LogViewer
// ---------------------------------------------------------------------------

export function LogViewer({
  source,
  resourceName,
  className,
}: LogViewerProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [filters, setFilters] = useLogFilters()

  const { lines, connected, error } = useLogStream({
    source,
    maxLines: filters.volume,
  })

  // ---------------------------------------------------------------------------
  // Pause / resume buffer
  // ---------------------------------------------------------------------------
  const [displayLines, setDisplayLines] =
    React.useState<Array<LogLineData>>(lines)
  const pauseBufferRef = React.useRef<Array<LogLineData>>([])

  React.useEffect(() => {
    if (filters.paused) {
      const incoming = lines.slice(displayLines.length)
      const merged = [...pauseBufferRef.current, ...incoming]
      pauseBufferRef.current =
        merged.length > 1000 ? merged.slice(merged.length - 1000) : merged
    } else {
      setDisplayLines(lines)
      pauseBufferRef.current = []
    }
  }, [lines, filters.paused, displayLines.length])

  const handleFiltersChange = React.useCallback(
    (next: Partial<LogFiltersState>) => {
      if ("paused" in next && next.paused === false) {
        setDisplayLines(lines)
        pauseBufferRef.current = []
      }
      setFilters(next)
    },
    [lines, setFilters]
  )

  // ---------------------------------------------------------------------------
  // Filter pipeline
  // ---------------------------------------------------------------------------
  const levelFiltered = filterByLevel(displayLines, filters.level)
  const filtered = filterBySearch(levelFiltered, filters.search)

  // Counters computed against filtered set so they reflect the view
  const { errorCount, warnCount } = React.useMemo(() => {
    let e = 0
    let w = 0
    for (const l of filtered) {
      const lvl = detectLevel(l.text)
      if (lvl === "error") e++
      else if (lvl === "warn") w++
    }
    return { errorCount: e, warnCount: w }
  }, [filtered])

  // ---------------------------------------------------------------------------
  // Auto-scroll with MutationObserver
  // ---------------------------------------------------------------------------
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const logBodyRef = React.useRef<HTMLDivElement>(null)
  const followRef = React.useRef(true)
  const [showFollowBtn, setShowFollowBtn] = React.useState(false)
  const detachLineCountRef = React.useRef(0)

  const scrollToBottom = React.useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const scrollToTop = React.useCallback(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = 0
      followRef.current = false
      setShowFollowBtn(true)
      detachLineCountRef.current = filtered.length
    }
  }, [filtered.length])

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom > 50) {
      if (followRef.current) {
        detachLineCountRef.current = filtered.length
        followRef.current = false
        setShowFollowBtn(true)
      }
    } else {
      followRef.current = true
      setShowFollowBtn(false)
    }
  }, [filtered.length])

  const handleFollowLatest = React.useCallback(() => {
    followRef.current = true
    setShowFollowBtn(false)
    scrollToBottom()
  }, [scrollToBottom])

  React.useEffect(() => {
    const logBody = logBodyRef.current
    if (!logBody) return
    const observer = new MutationObserver(() => {
      if (followRef.current) {
        scrollToBottom()
      }
    })
    observer.observe(logBody, { childList: true, subtree: false })
    return () => observer.disconnect()
  }, [scrollToBottom])

  const newLineCount = Math.max(0, filtered.length - detachLineCountRef.current)

  // ---------------------------------------------------------------------------
  // Jump to error (n / Shift+N)
  // ---------------------------------------------------------------------------
  const jumpCursorRef = React.useRef<number>(-1)

  const jumpToError = React.useCallback(
    (direction: "next" | "prev") => {
      const errorIndices: Array<number> = []
      for (let i = 0; i < filtered.length; i++) {
        if (detectLevel(filtered[i].text) === "error") errorIndices.push(i)
      }
      if (errorIndices.length === 0) return

      const cursor = jumpCursorRef.current
      let target: number
      if (direction === "next") {
        target = errorIndices.find((i) => i > cursor) ?? errorIndices[0]
      } else {
        const reversed = [...errorIndices].reverse()
        target =
          reversed.find((i) => i < cursor) ??
          errorIndices[errorIndices.length - 1]
      }
      jumpCursorRef.current = target

      // Detach from follow + scroll the target row into view
      followRef.current = false
      setShowFollowBtn(true)
      detachLineCountRef.current = filtered.length

      const targetLine = filtered[target]
      requestAnimationFrame(() => {
        const body = logBodyRef.current
        if (!body) return
        const node = body.querySelector<HTMLDivElement>(
          `[data-line-id="${targetLine.id}"]`
        )
        if (node) {
          node.scrollIntoView({ block: "center", behavior: "smooth" })
          node.animate(
            [
              { backgroundColor: "rgba(239, 68, 68, 0.35)" },
              { backgroundColor: "rgba(239, 68, 68, 0)" },
            ],
            { duration: 800, easing: "ease-out" }
          )
        }
      })
    },
    [filtered]
  )

  // ---------------------------------------------------------------------------
  // Copy / Download
  // ---------------------------------------------------------------------------
  const handleCopy = React.useCallback(async () => {
    const content = filtered.map((l) => l.text).join("\n")
    try {
      await navigator.clipboard.writeText(content)
    } catch (err) {
      console.error("Copy error:", err)
    }
  }, [filtered])

  const handleDownload = React.useCallback(() => {
    const content = filtered.map((l) => l.text).join("\n")
    const blob = new Blob([content], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    const baseName = resourceName ?? source.resourceId
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
    a.download = `${baseName}-${ts}.log`
    a.click()
    URL.revokeObjectURL(url)
  }, [filtered, source.resourceId, resourceName])

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts: /, p, g, G, n, N, w, t
  // ---------------------------------------------------------------------------
  const searchInputRef = React.useRef<HTMLInputElement | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      const isInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable

      // "/" — focus search even when not in an input
      if (e.key === "/" && !isInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }

      // Allow Escape to blur a focused search input
      if (
        e.key === "Escape" &&
        tag === "INPUT" &&
        target &&
        target === searchInputRef.current
      ) {
        target.blur()
        return
      }

      if (isInput) return

      // Only handle shortcuts when our viewer is in the active document
      if (!containerRef.current?.isConnected) return

      switch (e.key) {
        case "p":
        case "P":
          e.preventDefault()
          handleFiltersChange({ paused: !filters.paused })
          break
        case "w":
        case "W":
          e.preventDefault()
          handleFiltersChange({ wrap: !filters.wrap })
          break
        case "t":
        case "T":
          e.preventDefault()
          handleFiltersChange({ timestamps: !filters.timestamps })
          break
        case "g":
          e.preventDefault()
          scrollToTop()
          break
        case "G":
          e.preventDefault()
          handleFollowLatest()
          break
        case "n":
          e.preventDefault()
          jumpToError("next")
          break
        case "N":
          e.preventDefault()
          jumpToError("prev")
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    filters.paused,
    filters.wrap,
    filters.timestamps,
    handleFiltersChange,
    scrollToTop,
    handleFollowLatest,
    jumpToError,
  ])

  // ---------------------------------------------------------------------------
  // Title
  // ---------------------------------------------------------------------------
  const isBuild =
    source.kind === "app" &&
    Boolean(source.buildId) &&
    source.buildId !== "latest"
  const buildIdShort =
    source.kind === "app" && source.buildId ? source.buildId.slice(0, 8) : ""
  const title = isBuild
    ? resourceName
      ? t("logs.buildNamed", { id: buildIdShort, name: resourceName })
      : t("logs.buildOnly", { id: buildIdShort })
    : resourceName
      ? t("logs.runtimeNamed", { name: resourceName })
      : t("logs.runtimeLogs")
  const waitingHint = isBuild
    ? t("logs.waitingHint")
    : t("logs.waitingHintRuntime")

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-white/10 bg-[#0d0d0d]",
        className
      )}
    >
      <TitleBar
        title={title}
        isLive={connected}
        lineCount={filtered.length}
        errorCount={errorCount}
        warnCount={warnCount}
      />

      {error && (
        <div className="shrink-0 border-b border-red-500/20 bg-red-500/10 px-4 py-1.5 text-xs text-red-400">
          {error}
        </div>
      )}

      <LogFilters
        state={filters}
        onChange={handleFiltersChange}
        onDownload={handleDownload}
        onCopy={() => void handleCopy()}
        onJumpError={jumpToError}
        bufferedCount={pauseBufferRef.current.length}
        errorCount={errorCount}
        warnCount={warnCount}
        searchInputRef={searchInputRef}
      />

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-auto font-mono text-xs"
          role="log"
          aria-live="polite"
          aria-label={`${title} output`}
        >
          <div ref={logBodyRef} className="py-2">
            {filtered.length === 0 ? (
              <EmptyState
                filtered={filtered.length}
                total={displayLines.length}
                filters={filters}
                connected={connected}
                hasError={Boolean(error)}
                waitingHint={waitingHint}
              />
            ) : (
              filtered.map((line) => (
                <LogLine
                  key={line.id}
                  line={line}
                  search={filters.search}
                  wrap={filters.wrap}
                  showTimestamps={filters.timestamps}
                />
              ))
            )}
          </div>
        </div>

        <FollowButton
          visible={showFollowBtn}
          newCount={newLineCount}
          onClick={handleFollowLatest}
        />
      </div>
    </div>
  )
}

export function BuildLogViewer({
  appId,
  buildId,
  archiveOnly,
  appName,
  className,
}: BuildLogViewerProps): React.JSX.Element {
  return (
    <LogViewer
      source={{ kind: "app", resourceId: appId, buildId, archiveOnly }}
      resourceName={appName}
      className={className}
    />
  )
}
