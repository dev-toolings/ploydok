// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { lineLevel, parseStructuredLine } from "../../lib/hooks/use-log-stream"
import type {
  LogLine as LogLineData,
  LogSeverity,
  StructuredLogLine,
} from "../../lib/hooks/use-log-stream"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HighlightSegment {
  text: string
  isMatch: boolean
}

// ---------------------------------------------------------------------------
// Helpers — exported for tests
// ---------------------------------------------------------------------------

/**
 * Splits `text` around case-insensitive matches of `query`.
 * Returns segments tagged with `isMatch: true` for matches.
 * Returns `[{ text, isMatch: false }]` when query is empty or blank.
 */
export function highlightMatches(
  text: string,
  query: string
): Array<HighlightSegment> {
  const q = query.trim()
  if (!q) return [{ text, isMatch: false }]

  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(escaped, "gi")

  const segments: Array<HighlightSegment> = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        text: text.slice(lastIndex, match.index),
        isMatch: false,
      })
    }
    segments.push({ text: match[0], isMatch: true })
    lastIndex = re.lastIndex
    if (match[0].length === 0) re.lastIndex++
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isMatch: false })
  }

  return segments
}

const TIMESTAMP_PREFIX_RE = /^(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+/
const STACK_TRACE_RE = /^\s+at\s/

function formatTimestamp(t: number): string {
  const d = new Date(t)
  const hh = d.getHours().toString().padStart(2, "0")
  const mm = d.getMinutes().toString().padStart(2, "0")
  const ss = d.getSeconds().toString().padStart(2, "0")
  const ms = d.getMilliseconds().toString().padStart(3, "0")
  return `${hh}:${mm}:${ss}.${ms}`
}

function levelColorClass(level: LogSeverity): string {
  switch (level) {
    case "error":
      return "text-red-400"
    case "warn":
      return "text-amber-400"
    case "debug":
      return "text-sky-400"
    default:
      return "text-[#e5e7eb]"
  }
}

function levelLabel(level: LogSeverity): string {
  switch (level) {
    case "error":
      return "ERR"
    case "warn":
      return "WARN"
    case "debug":
      return "DBG"
    default:
      return "INFO"
  }
}

// ---------------------------------------------------------------------------
// HighlightedText
// ---------------------------------------------------------------------------

function HighlightedText({
  text,
  query,
}: {
  text: string
  query: string
}): React.JSX.Element {
  const segments = highlightMatches(text, query)
  if (segments.length === 1 && !segments[0].isMatch) {
    return <>{text}</>
  }
  return (
    <>
      {segments.map((seg, i) =>
        seg.isMatch ? (
          <mark
            key={i}
            className="rounded bg-yellow-500/30 px-0.5 text-yellow-100"
          >
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{seg.text}</React.Fragment>
        )
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// StructuredBody — renders a parsed JSON/logfmt line as message + field chips
// ---------------------------------------------------------------------------

function StructuredBody({
  structured,
  search,
}: {
  structured: StructuredLogLine
  search: string
}): React.JSX.Element {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 align-baseline whitespace-normal">
      {structured.message !== null && (
        <span className="break-all">
          <HighlightedText text={structured.message} query={search} />
        </span>
      )}
      {structured.fields.map((field, i) => (
        <span
          key={i}
          className="inline-flex items-baseline gap-0.5 rounded bg-white/8 px-1 font-mono text-[11px] leading-5"
          data-log-field={field.key}
        >
          <span className="text-white/50">{field.key}</span>
          <span className="text-white/35">=</span>
          <span className="break-all text-[#e5e7eb]">
            <HighlightedText text={field.value} query={search} />
          </span>
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// LogLine — memoized log line renderer
// ---------------------------------------------------------------------------

export interface LogLineProps {
  onRequestId?: (requestId: string) => void
  line: LogLineData
  search: string
  /** Word-wrap long lines. When false, lines truncate horizontally with scroll. */
  wrap?: boolean
  /** Show the timestamp column. */
  showTimestamps?: boolean
  /** Optional 1-based line number for the gutter. */
  lineNumber?: number
}

export const LogLine = React.memo(function LogLineRow({
  line,
  search,
  onRequestId,
  wrap = true,
  showTimestamps = true,
  lineNumber,
}: LogLineProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const level = lineLevel(line)
  const isError = level === "error"
  const isWarn = level === "warn"
  const isDebug = level === "debug"
  const isStackTrace = STACK_TRACE_RE.test(line.text)

  const inlineMatch = TIMESTAMP_PREFIX_RE.exec(line.text)
  const bodyText = inlineMatch
    ? line.text.slice(inlineMatch[0].length)
    : line.text
  const structured = isStackTrace ? null : parseStructuredLine(bodyText)

  const textColor = isStackTrace ? "text-white/55" : levelColorClass(level)
  const rowBg = isError
    ? "bg-red-500/5 hover:bg-red-500/10"
    : isWarn
      ? "hover:bg-amber-500/5"
      : isDebug
        ? "hover:bg-sky-500/5"
        : "hover:bg-white/5"
  const wrapCls = wrap
    ? "whitespace-pre-wrap break-all"
    : "whitespace-pre overflow-hidden"

  return (
    <div
      className={`group/line flex items-start gap-2 px-4 py-px leading-6 ${wrapCls} ${rowBg} transition-colors`}
      data-level={level}
      data-line-id={line.id}
    >
      {lineNumber !== undefined && (
        <span
          className="w-10 shrink-0 text-right text-white/25 tabular-nums select-none group-hover/line:text-white/50"
          aria-hidden="true"
        >
          {lineNumber}
        </span>
      )}

      {showTimestamps && (
        <span
          className="w-[7.5rem] shrink-0 text-right text-white/45 tabular-nums select-none"
          aria-hidden="true"
        >
          {line.t !== undefined
            ? formatTimestamp(line.t)
            : inlineMatch
              ? inlineMatch[1]
              : null}
        </span>
      )}

      {/* Level badge */}
      <span
        className={`w-12 shrink-0 text-right font-semibold select-none ${levelColorClass(level)}`}
        aria-hidden="true"
      >
        <span className={level === "info" ? "text-white/50" : undefined}>
          {levelLabel(level)}
        </span>
      </span>

      <span
        className={`min-w-0 flex-1 ${textColor} ${isStackTrace ? "pl-4 text-xs" : ""}`}
      >
        {line.request ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span>
              <HighlightedText
                text={`${line.request.method} ${line.request.path}`}
                query={search}
              />
            </span>
            <span
              className={
                line.request.status >= 500
                  ? "text-red-400"
                  : line.request.status >= 400
                    ? "text-amber-400"
                    : "text-emerald-400"
              }
            >
              {line.request.status}
            </span>
            <span>{line.request.durationMs} ms</span>
            <span className="text-white/50">
              <HighlightedText text={line.request.host} query={search} />
            </span>
            <span className="text-white/50">{line.request.size} B</span>
            {line.request.requestId && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto min-w-0 p-0 font-mono text-xs break-all text-sky-400"
                onClick={() => onRequestId?.(line.request!.requestId)}
                aria-label={t("logs.filterRequestId", {
                  id: line.request.requestId,
                })}
              >
                <HighlightedText text={line.request.requestId} query={search} />
              </Button>
            )}
          </span>
        ) : structured ? (
          <StructuredBody structured={structured} search={search} />
        ) : (
          <HighlightedText text={bodyText} query={search} />
        )}
      </span>
    </div>
  )
})
