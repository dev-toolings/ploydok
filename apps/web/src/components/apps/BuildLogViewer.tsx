// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiArrowDownLine } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { NativeSelect } from "@workspace/ui/components/native-select"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import {
  detectLevel,
  filterByLevel,
  filterBySearch,
  useLogStream,
} from "../../lib/hooks/use-log-stream"
import { LogFilters, useLogFilters } from "./LogFilters"
import { LogLine } from "./LogLine"
import type {
  LogLine as LogLineData,
  LogProvenance,
  LogSource,
  LogStreamStatus,
} from "../../lib/hooks/use-log-stream"
import type { LogFiltersState } from "./LogFilters"

export interface LogViewerProps {
  source: LogSource
  /** Optional resource name for the download filename and title bar */
  resourceName?: string
  className?: string
  /** Fill the parent height only for the full-page runtime tab. */
  fillHeight?: boolean
}

interface BuildLogViewerProps {
  appId: string
  /** Build ID: if undefined or "latest", streams runtime logs */
  buildId?: string
  /** For completed builds, read the persisted log archive instead of live WS. */
  archiveOnly?: boolean
  /** Optional app name for the download filename and title bar */
  appName?: string
  className?: string
  /** Fill the parent height only for the full-page runtime tab. */
  fillHeight?: boolean
}

function TitleBar({
  title,
  status,
  snapshotLoadedAt,
  lastLineAt,
  retry,
  lineCount,
  errorCount,
  warnCount,
  error,
  provenance,
  onContainerChange,
}: {
  provenance: LogProvenance | null
  onContainerChange?: (index: number, id: string) => void
  title: string
  status: LogStreamStatus
  snapshotLoadedAt: number | null
  lastLineAt: number | null
  retry: () => void
  lineCount: number
  errorCount: number
  warnCount: number
  error: string | null
}): React.JSX.Element {
  const { t, i18n } = useTranslation("apps")
  const [now, setNow] = React.useState(Date.now)
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - (lastLineAt ?? now)) / 1000))
  const unit =
    seconds < 60
      ? "second"
      : seconds < 3600
        ? "minute"
        : seconds < 86400
          ? "hour"
          : "day"
  const divisor =
    unit === "second"
      ? 1
      : unit === "minute"
        ? 60
        : unit === "hour"
          ? 3600
          : 86400
  const relative = new Intl.RelativeTimeFormat(i18n.language, {
    numeric: "auto",
  }).format(-Math.floor(seconds / divisor), unit)
  const snapshotTime =
    snapshotLoadedAt === null
      ? ""
      : new Intl.DateTimeFormat(i18n.language, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(snapshotLoadedAt)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-panel-border bg-panel px-4 py-3 font-sans text-xs">
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-muted-foreground">
          <span className={cn(status === "error" && "text-destructive")}>
            {status === "snapshot"
              ? t("logs.snapshot", { time: snapshotTime })
              : t(status === "error" ? "logs.statusError" : `logs.${status}`)}
          </span>
          {" · "}
          {lastLineAt === null
            ? t("logs.noLineYet")
            : t("logs.lastLine", { relative })}
        </p>
        <p className="text-muted-foreground tabular-nums">
          {t("logs.viewCounts", {
            lines: t("logs.linesCount", { count: lineCount }),
            errors: t("logs.errorsCount", { count: errorCount }),
            warnings: t("logs.warningsCount", { count: warnCount }),
          })}
        </p>
        {provenance &&
          provenance.containers.some(
            (container) => container.index === provenance.index
          ) && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">
              <span>{t("logs.container")}</span>
              {onContainerChange && provenance.containers.length > 1 ? (
                <NativeSelect
                  aria-label={t("logs.container")}
                  value={provenance.index}
                  onChange={(event) => {
                    const container = provenance.containers.find(
                      (item) => item.index === Number(event.target.value)
                    )
                    if (container)
                      onContainerChange(container.index, container.id)
                  }}
                  className="w-full min-w-0 sm:w-auto sm:max-w-sm"
                >
                  {provenance.containers.map((container) => (
                    <option key={container.index} value={container.index}>
                      {container.name}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <span className="font-mono break-all">
                  {
                    provenance.containers.find(
                      (container) => container.index === provenance.index
                    )?.name
                  }
                </span>
              )}
            </div>
          )}
        {error && (
          <p className="break-words text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      {status !== "live" && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={status === "connecting"}
          onClick={retry}
        >
          {t("logs.retry")}
        </Button>
      )}
    </div>
  )
}

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
    <Button
      type="button"
      variant="default"
      size="lg"
      onClick={onClick}
      className="absolute right-4 bottom-4 left-4 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-full text-xs whitespace-normal shadow-lg"
      title={t("logs.returnToLive", { count: newCount })}
    >
      <RiArrowDownLine aria-hidden="true" />
      {t("logs.returnToLive", { count: newCount })}
    </Button>
  )
}

function EmptyState({
  filtered,
  total,
  filters,
  status,
  hasError,
  waitingHint,
}: {
  filtered: number
  total: number
  filters: LogFiltersState
  status: LogStreamStatus
  hasError: boolean
  waitingHint: string
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const hasFilter = filters.search.length > 0 || filters.level !== "all"
  if (filtered === 0 && total > 0 && hasFilter) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
        <span>{t("logs.noMatch")}</span>
        <span className="text-xs text-muted-foreground">
          {t("logs.noMatchHint", { total: total.toLocaleString() })}
        </span>
      </div>
    )
  }
  if (filtered === 0 && total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-12 text-center text-sm text-muted-foreground">
        {hasError ? (
          <span className="text-red-400">{t("logs.streamError")}</span>
        ) : status === "live" ? (
          <>
            <span className="inline-flex items-center gap-2">
              <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
              {t("logs.connectedWaiting")}
            </span>
            <span className="text-xs text-muted-foreground">{waitingHint}</span>
          </>
        ) : (
          <span>
            {status === "snapshot"
              ? t("logs.snapshotEmpty")
              : t("logs.connecting")}
          </span>
        )}
      </div>
    )
  }
  return <></>
}

function LogViewerContent({
  source,
  resourceName,
  className,
  fillHeight = false,
  onContainerChange,
}: LogViewerProps & {
  onContainerChange?: (index: number, id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [filters, setFilters] = useLogFilters()

  const {
    lines,
    status,
    snapshotLoadedAt,
    lastLineAt,
    retry,
    error,
    provenance,
  } = useLogStream({
    source,
    maxLines: filters.volume,
  })

  // ---------------------------------------------------------------------------
  // Pause / resume buffer
  // ---------------------------------------------------------------------------
  const [displayLines, setDisplayLines] =
    React.useState<Array<LogLineData>>(lines)
  const [selecting, setSelecting] = React.useState(false)
  const selectingRef = React.useRef(false)
  const updateSelecting = React.useCallback((next: boolean) => {
    if (selectingRef.current === next) return
    selectingRef.current = next
    setSelecting(next)
  }, [])
  const latestLineId = lines.at(-1)?.id ?? 0

  React.useEffect(() => {
    if (!filters.paused && !selecting && displayLines !== lines) {
      setDisplayLines(lines)
    }
  }, [lines, displayLines, filters.paused, selecting])

  const handleFiltersChange = React.useCallback(
    (next: Partial<LogFiltersState>) => {
      if (next.paused && followRef.current) {
        followRef.current = false
        detachLineCountRef.current = displayLines.at(-1)?.id ?? 0
      }
      setFilters(next)
    },
    [displayLines, setFilters]
  )

  // ---------------------------------------------------------------------------
  // Filter pipeline
  // ---------------------------------------------------------------------------
  const filtered = React.useMemo(
    () =>
      filterBySearch(
        filterByLevel(displayLines, filters.level),
        filters.search
      ),
    [displayLines, filters.level, filters.search]
  )

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
  const [scrollState, setScrollState] = React.useState({
    awayFromBottom: false,
    hasOverflow: false,
  })
  const { awayFromBottom, hasOverflow } = scrollState
  const scrollStateRef = React.useRef(scrollState)
  const detachLineCountRef = React.useRef(0)
  const followInputsRef = React.useRef({
    paused: filters.paused,
    displayedLineId: displayLines.at(-1)?.id ?? 0,
  })
  // Observers read committed inputs without being reinstalled for each line.
  React.useLayoutEffect(() => {
    followInputsRef.current = {
      paused: filters.paused,
      displayedLineId: displayLines.at(-1)?.id ?? 0,
    }
  }, [displayLines, filters.paused])

  const hasSelection = React.useCallback(() => {
    const selection = window.getSelection()
    return Boolean(
      selection &&
      !selection.isCollapsed &&
      scrollRef.current &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(scrollRef.current)
    )
  }, [])
  const pointerSelectingRef = React.useRef(false)
  const selectionActive = React.useCallback(
    () => pointerSelectingRef.current || hasSelection(),
    [hasSelection]
  )

  // Selection freezes rendering and scrolling, but does not detach live follow.
  const syncFollowState = React.useCallback(
    (catchUp = false) => {
      const el = scrollRef.current
      if (!el) return
      const { paused, displayedLineId } = followInputsRef.current
      if (
        catchUp &&
        followRef.current &&
        !paused &&
        !selectionActive()
      ) {
        const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
        if (el.scrollTop !== bottom) el.scrollTop = bottom
      }
      const overflow = el.scrollHeight > el.clientHeight
      const away =
        overflow && el.scrollHeight - el.scrollTop - el.clientHeight > 50
      const previous = scrollStateRef.current
      if (previous.hasOverflow !== overflow || previous.awayFromBottom !== away) {
        const next = { hasOverflow: overflow, awayFromBottom: away }
        scrollStateRef.current = next
        setScrollState(next)
      }
      if (away || paused) {
        if (followRef.current) {
          detachLineCountRef.current = displayedLineId
        }
        followRef.current = false
      } else {
        followRef.current = true
      }
    },
    [selectionActive]
  )

  React.useEffect(() => {
    const updateSelection = () => {
      updateSelecting(selectionActive())
      syncFollowState()
    }
    const endPointer = () => {
      // Global pointerup also fires for clicks outside the log view.
      if (!pointerSelectingRef.current) return
      pointerSelectingRef.current = false
      updateSelection()
    }
    document.addEventListener("selectionchange", updateSelection)
    window.addEventListener("pointerup", endPointer)
    window.addEventListener("pointercancel", endPointer)
    return () => {
      document.removeEventListener("selectionchange", updateSelection)
      window.removeEventListener("pointerup", endPointer)
      window.removeEventListener("pointercancel", endPointer)
    }
  }, [selectionActive, syncFollowState, updateSelecting])

  const scrollToBottom = React.useCallback(() => {
    if (selectionActive()) return
    const el = scrollRef.current
    if (el) {
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight)
      if (el.scrollTop !== bottom) el.scrollTop = bottom
    }
  }, [selectionActive])

  const scrollToTop = React.useCallback(() => {
    if (selectionActive()) return
    const el = scrollRef.current
    if (el) {
      el.scrollTop = 0
      syncFollowState()
    }
  }, [selectionActive, syncFollowState])

  const handleScroll = React.useCallback(() => {
    syncFollowState()
  }, [syncFollowState])

  React.useLayoutEffect(() => {
    syncFollowState(true)
  }, [filtered, filters.paused, selecting, syncFollowState])

  const handleFollowLatest = React.useCallback(() => {
    if (selectionActive()) return
    setFilters({ paused: false })
    if (displayLines !== lines) setDisplayLines(lines)
    followRef.current = true
    scrollToBottom()
    // Measure after the resumed buffer and paused flag have committed.
  }, [displayLines, scrollToBottom, selectionActive, lines, setFilters])

  React.useEffect(() => {
    const logBody = logBodyRef.current
    const viewport = scrollRef.current
    if (!logBody || !viewport) return
    const update = () => syncFollowState(true)
    const observer = new MutationObserver(update)
    observer.observe(logBody, { childList: true, subtree: false })
    const resizeObserver = new ResizeObserver(update)
    resizeObserver.observe(logBody)
    resizeObserver.observe(viewport)
    return () => {
      observer.disconnect()
      resizeObserver.disconnect()
    }
  }, [syncFollowState])

  const newLineCount = Math.max(
    0,
    latestLineId -
      (awayFromBottom || filters.paused
        ? detachLineCountRef.current
        : (displayLines.at(-1)?.id ?? 0))
  )
  const showFollowBtn =
    filters.paused ||
    awayFromBottom ||
    (hasOverflow && selecting && newLineCount > 0)

  // ---------------------------------------------------------------------------
  // Jump to error (n / Shift+N)
  // ---------------------------------------------------------------------------
  const jumpCursorRef = React.useRef<number>(-1)

  const jumpToError = React.useCallback(
    (direction: "next" | "prev") => {
      if (selectionActive()) return
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

      const targetLine = filtered[target]
      requestAnimationFrame(() => {
        const body = logBodyRef.current
        if (!body || selectionActive()) return
        const node = body.querySelector<HTMLDivElement>(
          `[data-line-id="${targetLine.id}"]`
        )
        if (node) {
          node.scrollIntoView({ block: "center", behavior: "instant" })
          syncFollowState()
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
    [filtered, selectionActive, syncFollowState]
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
      if (
        !target ||
        !containerRef.current?.contains(target) ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return
      const tag = target.tagName
      const isInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable

      // "/": focus search even when not in an input
      if (e.key === "/" && !isInput) {
        e.preventDefault()
        searchInputRef.current?.focus()
        searchInputRef.current?.select()
        return
      }

      // Allow Escape to blur a focused search input
      if (
        e.key === "Escape" &&
        tag === "INPUT" &&
        target === searchInputRef.current
      ) {
        containerRef.current.focus()
        return
      }

      if (isInput) return

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
    : t("logs.runtimeLogs")
  const waitingHint = isBuild
    ? t("logs.waitingHint")
    : t("logs.waitingHintRuntime")

  const [maxBodyHeight, setMaxBodyHeight] = React.useState<number | undefined>()
  React.useEffect(() => {
    const update = () => {
      const top = scrollRef.current?.getBoundingClientRect().top
      if (top !== undefined)
        setMaxBodyHeight(Math.max(0, window.innerHeight - top - 24))
    }
    update()
    const observer = new ResizeObserver(update)
    if (containerRef.current) observer.observe(containerRef.current)
    window.addEventListener("resize", update)
    window.addEventListener("scroll", update, true)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
      window.removeEventListener("scroll", update, true)
    }
  }, [])

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden rounded-lg border border-panel-border bg-panel font-sans outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      <TitleBar
        title={title}
        status={status}
        snapshotLoadedAt={snapshotLoadedAt}
        lastLineAt={lastLineAt}
        retry={retry}
        error={error}
        lineCount={filtered.length}
        errorCount={errorCount}
        warnCount={warnCount}
        provenance={provenance}
        onContainerChange={onContainerChange}
      />

      <LogFilters
        className={fillHeight ? "shrink-0" : undefined}
        state={filters}
        onChange={handleFiltersChange}
        onDownload={handleDownload}
        onCopy={handleCopy}
        onJumpError={jumpToError}
        bufferedCount={newLineCount}
        errorCount={errorCount}
        searchInputRef={searchInputRef}
      />

      <div
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden",
          fillHeight && "flex-1"
        )}
      >
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            pointerSelectingRef.current = true
            updateSelecting(true)
          }}
          className={cn(
            "min-h-0 overflow-auto text-xs",
            fillHeight && "flex-1 overscroll-contain",
            filtered.length > 0
              ? "bg-[#0d0d0d] font-mono"
              : "bg-panel font-sans"
          )}
          style={{
            maxHeight: fillHeight ? undefined : maxBodyHeight,
            overflowAnchor: "none",
          }}
          role="log"
          aria-live="polite"
          aria-label={t("logs.output", { title })}
        >
          <div
            ref={logBodyRef}
            className="py-2"
            style={{ minHeight: Math.min(192, maxBodyHeight ?? 192) }}
          >
            {filtered.length === 0 ? (
              <EmptyState
                filtered={filtered.length}
                total={displayLines.length}
                filters={filters}
                status={status}
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

export function LogViewer(props: LogViewerProps): React.JSX.Element {
  const { source } = props
  const sourceKey = `${source.kind}:${source.resourceId}:${source.kind === "app" ? `${source.buildId ?? ""}:${source.archiveOnly ?? false}:${source.containerId ?? ""}` : source.kind === "service" ? (source.containerIndex ?? 0) : ""}`
  return <LogViewerSession key={sourceKey} {...props} />
}

function LogViewerSession(props: LogViewerProps): React.JSX.Element {
  const [containerIndex, setContainerIndex] = React.useState(
    props.source.kind === "service" ? (props.source.containerIndex ?? 0) : 0
  )
  const [containerId, setContainerId] = React.useState(
    props.source.kind === "app" ? props.source.containerId : undefined
  )
  const source =
    props.source.kind === "service"
      ? { ...props.source, containerIndex }
      : props.source.kind === "app"
        ? { ...props.source, containerId }
        : props.source
  const isRuntime =
    source.kind === "service" ||
    (source.kind === "app" && (!source.buildId || source.buildId === "latest"))
  return (
    <LogViewerContent
      key={containerId ?? containerIndex}
      {...props}
      source={source}
      onContainerChange={
        isRuntime
          ? (index, id) => {
              if (source.kind === "service") setContainerIndex(index)
              else setContainerId(id)
            }
          : undefined
      }
    />
  )
}

export function BuildLogViewer({
  appId,
  buildId,
  archiveOnly,
  appName,
  className,
  fillHeight,
}: BuildLogViewerProps): React.JSX.Element {
  return (
    <LogViewer
      source={{ kind: "app", resourceId: appId, buildId, archiveOnly }}
      resourceName={appName}
      fillHeight={fillHeight}
      className={className}
    />
  )
}
