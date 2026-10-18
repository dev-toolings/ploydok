// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { apiFetch } from "../api"
import { apiBaseUrl, apiWebSocketBaseUrl } from "../api/base"
import i18n from "../i18n"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ABSOLUTE_MAX_LINES = 10_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RuntimeLogSource = "app" | "requests" | "all"

export interface HttpRequestLog {
  method: string
  host: string
  path: string
  status: number
  durationMs: number
  size: number
  requestId: string
}

export interface LogLine {
  request?: HttpRequestLog
  id: number
  text: string
  t?: number
  stream?: "stdout" | "stderr"
}

export type LogLevel = "all" | "debug" | "info" | "warn" | "error"
export type LogSeverity = Exclude<LogLevel, "all">

// ---------------------------------------------------------------------------
// Level detection — pure helper, exported for tests
// ---------------------------------------------------------------------------

const EXPLICIT_LEVEL_RE =
  /^(?:PHP\s+)?(?:\[(debug|info|notice|warn|warning|error|critical|alert|emergency)\]|(debug|info|notice|warn|warning|error|critical|alert|emergency):\s)/i

const ERROR_PATTERNS = [
  /\[ERROR\]/i,
  /\[CRITICAL\]/i,
  /\[ALERT\]/i,
  /\[EMERGENCY\]/i,
  /ERROR:/i,
  /CRITICAL:/i,
  /\bfatal\b/i,
  /\bpanic\b/i,
  // "err:" as a word (e.g. "read err: connection reset") — no trailing \b since ":" is non-word
  /\berr:/i,
  /\b(error|fatal|critical)\b/i,
]

const WARN_PATTERNS = [/\[WARN\]/i, /WARN:/i, /\bwarn(ing)?\b/i]

const DEBUG_PATTERNS = [/\[DEBUG\]/i, /DEBUG:/i, /\bdebug\b/i]

const INFO_PATTERNS = [/\[INFO\]/i, /INFO:/i, /\binfo\b/i]

function detectExplicitLevel(text: string): LogSeverity | null {
  const match = EXPLICIT_LEVEL_RE.exec(text.trim())
  const marker = (match?.[1] ?? match?.[2])?.toLowerCase()
  switch (marker) {
    case "debug":
      return "debug"
    case "warn":
    case "warning":
      return "warn"
    case "error":
    case "critical":
    case "alert":
    case "emergency":
      return "error"
    case "info":
    case "notice":
      return "info"
    default:
      return null
  }
}

/**
 * Detects the log level of a line based on textual heuristics.
 * Explicit level markers win over message text; unknown lines fall back to info.
 */
export function detectLevel(text: string): LogSeverity {
  const structured = parseStructuredLine(text)
  if (structured) {
    const structuredLevel = levelFromStructured(structured)
    if (structuredLevel) return structuredLevel
  }

  const explicitLevel = detectExplicitLevel(text)
  if (explicitLevel) return explicitLevel

  for (const re of ERROR_PATTERNS) {
    if (re.test(text)) return "error"
  }
  for (const re of WARN_PATTERNS) {
    if (re.test(text)) return "warn"
  }
  for (const re of DEBUG_PATTERNS) {
    if (re.test(text)) return "debug"
  }
  for (const re of INFO_PATTERNS) {
    if (re.test(text)) return "info"
  }
  return "info"
}

// ---------------------------------------------------------------------------
// Structured logs (JSON / logfmt) — pure helpers, exported for tests
// ---------------------------------------------------------------------------

export interface StructuredLogField {
  key: string
  value: string
}

export interface StructuredLogLine {
  format: "json" | "logfmt"
  message: string | null
  fields: Array<StructuredLogField>
}

const MESSAGE_KEYS = ["msg", "message", "@message"]
const LEVEL_KEYS = ["level", "lvl", "severity", "levelname", "loglevel"]

const LOGFMT_PAIR_RE = /([\w.-]+)=("(?:[^"\\]|\\.)*"|[^\s"]*)/g
const LOGFMT_LINE_RE =
  /^\s*[\w.-]+=(?:"(?:[^"\\]|\\.)*"|[^\s"]*)(?:\s+[\w.-]+=(?:"(?:[^"\\]|\\.)*"|[^\s"]*))*\s*$/

function stringifyStructuredValue(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function levelFromStructured(
  structured: StructuredLogLine
): LogSeverity | null {
  for (const field of structured.fields) {
    if (!LEVEL_KEYS.includes(field.key.toLowerCase())) continue
    switch (field.value.trim().toLowerCase()) {
      case "trace":
      case "debug":
        return "debug"
      case "warn":
      case "warning":
        return "warn"
      case "err":
      case "error":
      case "fatal":
      case "critical":
      case "crit":
      case "alert":
      case "emergency":
      case "panic":
        return "error"
      case "info":
      case "notice":
      case "information":
        return "info"
    }
  }
  return null
}

/**
 * Parses a log line as structured data — a JSON object or a logfmt
 * (`key=value key2="value 2"`) line. Returns null for plain text.
 * A recognised `msg`/`message` key becomes `message`; everything else
 * (including `level`) is returned as ordered fields.
 */
export function parseStructuredLine(text: string): StructuredLogLine | null {
  const trimmed = text.trim()
  if (trimmed.length < 3) return null

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        const fields: Array<StructuredLogField> = []
        let message: string | null = null
        for (const [key, value] of Object.entries(
          parsed as Record<string, unknown>
        )) {
          if (
            message === null &&
            typeof value === "string" &&
            MESSAGE_KEYS.includes(key.toLowerCase())
          ) {
            message = value
            continue
          }
          fields.push({ key, value: stringifyStructuredValue(value) })
        }
        if (message === null && fields.length === 0) return null
        return { format: "json", message, fields }
      }
    } catch {
      // not valid JSON — fall through to logfmt
    }
  }

  if (LOGFMT_LINE_RE.test(text)) {
    const fields: Array<StructuredLogField> = []
    let message: string | null = null
    LOGFMT_PAIR_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = LOGFMT_PAIR_RE.exec(text)) !== null) {
      const key = match[1]
      let value = match[2]
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        try {
          value = JSON.parse(value) as string
        } catch {
          value = value.slice(1, -1)
        }
      }
      if (message === null && MESSAGE_KEYS.includes(key.toLowerCase())) {
        message = value
        continue
      }
      fields.push({ key, value })
    }
    // Require ≥2 tokens so a stray "FOO=bar" env echo isn't parsed as structured.
    if (fields.length + (message === null ? 0 : 1) < 2) return null
    return { format: "logfmt", message, fields }
  }

  return null
}

export function lineLevel(line: LogLine): LogSeverity {
  return line.request
    ? line.request.status >= 500
      ? "error"
      : line.request.status >= 400
        ? "warn"
        : "info"
    : detectLevel(line.text)
}

/**
 * Applies a level filter to a list of lines.
 * "all" is a no-op.
 */
export function filterByLevel(
  lines: ReadonlyArray<LogLine>,
  level: LogLevel
): Array<LogLine> {
  if (level === "all") return lines as Array<LogLine>
  return lines.filter((l) => lineLevel(l) === level)
}

/**
 * Applies a case-insensitive text filter to a list of lines.
 * Empty query is a no-op.
 */
export function filterBySearch(
  lines: ReadonlyArray<LogLine>,
  query: string
): Array<LogLine> {
  const q = query.trim().toLowerCase()
  if (!q) return lines as Array<LogLine>
  return lines.filter((l) => l.text.toLowerCase().includes(q))
}

// ---------------------------------------------------------------------------
// Parsing helper — attempts JSON {t, line} envelope; falls back to raw text
// ---------------------------------------------------------------------------

type ParsedLogLine = LogLine & { _raw: string }

interface FastCgiChunk {
  requestId: string | null
  payload: string
  complete: boolean
}

interface PendingFastCgiChunk {
  requestId: string | null
  envelope: ParsedLogLine
  payload: string
}

function parseLineEnvelope(raw: string, fallbackT: number): ParsedLogLine {
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "line" in parsed &&
        typeof (parsed as Record<string, unknown>)["line"] === "string"
      ) {
        const obj = parsed as Record<string, unknown>
        const t = typeof obj["t"] === "number" ? obj["t"] : fallbackT
        const stream =
          obj["stream"] === "stdout" || obj["stream"] === "stderr"
            ? obj["stream"]
            : undefined
        const request =
          obj.kind === "request" &&
          typeof obj.method === "string" &&
          typeof obj.host === "string" &&
          typeof obj.path === "string" &&
          typeof obj.status === "number" &&
          typeof obj.durationMs === "number" &&
          typeof obj.size === "number" &&
          typeof obj.requestId === "string"
            ? {
                method: obj.method,
                host: obj.host,
                path: obj.path,
                status: obj.status,
                durationMs: obj.durationMs,
                size: obj.size,
                requestId: obj.requestId,
              }
            : undefined
        return {
          id: 0,
          text: obj["line"] as string,
          t,
          stream,
          request,
          _raw: raw,
        }
      }
    } catch {
      // not JSON — fall through
    }
  }
  return { id: 0, text: raw, t: fallbackT, _raw: raw }
}

const FASTCGI_STDERR_MARKER = 'FastCGI sent in stderr: "'
const FASTCGI_STDERR_SUFFIX = '" while '
const PHP_MESSAGE_SPLIT_RE = /;\s*PHP message:\s*/g

function parseFastCgiChunk(text: string): FastCgiChunk | null {
  const markerIndex = text.indexOf(FASTCGI_STDERR_MARKER)
  if (markerIndex === -1) return null

  const payloadStart = markerIndex + FASTCGI_STDERR_MARKER.length
  const suffixIndex = text.lastIndexOf(FASTCGI_STDERR_SUFFIX)
  const complete = suffixIndex > payloadStart
  const payloadEnd = complete ? suffixIndex : text.length
  const payload = text.slice(payloadStart, payloadEnd)

  if (payload.trim().length === 0) return null

  const requestMatch = /\*(\d+)\s+$/.exec(text.slice(0, markerIndex))
  return {
    requestId: requestMatch?.[1] ?? null,
    payload,
    complete,
  }
}

function splitPhpMessages(
  text: string,
  options?: { allowLeadingText?: boolean }
): Array<string> | null {
  const payloadText = text.trim()
  if (
    !payloadText.includes("PHP message:") ||
    (!options?.allowLeadingText && !payloadText.startsWith("PHP message:"))
  ) {
    return null
  }

  const payload = payloadText.replace(/^PHP message:\s*/, "")
  const messages = payload
    .split(PHP_MESSAGE_SPLIT_RE)
    .map((part) => part.trim().replace(/;$/, "").trim())
    .filter(Boolean)

  if (messages.length === 0) return null
  return messages.map((message) => `PHP ${message}`)
}

function expandFastCgiPayload(
  envelope: ParsedLogLine,
  payload: string
): Array<ParsedLogLine> {
  return (
    splitPhpMessages(payload, { allowLeadingText: true }) ?? [envelope.text]
  ).map((text) => ({
    ...envelope,
    text,
  }))
}

function expandPlainLogEnvelope(envelope: ParsedLogLine): Array<ParsedLogLine> {
  return (splitPhpMessages(envelope.text) ?? [envelope.text]).map((text) => ({
    ...envelope,
    text,
  }))
}

function canAppendFastCgiChunk(
  pending: PendingFastCgiChunk,
  chunk: FastCgiChunk
): boolean {
  return (
    pending.requestId !== null &&
    chunk.requestId !== null &&
    pending.requestId === chunk.requestId
  )
}

export function createLogEntryNormalizer(): {
  append: (raw: string, fallbackT: number) => Array<ParsedLogLine>
  flush: () => Array<ParsedLogLine>
} {
  let pendingFastCgi: PendingFastCgiChunk | null = null

  const flush = (): Array<ParsedLogLine> => {
    if (!pendingFastCgi) return []
    const pending = pendingFastCgi
    pendingFastCgi = null
    return expandFastCgiPayload(pending.envelope, pending.payload)
  }

  return {
    append(raw: string, fallbackT: number): Array<ParsedLogLine> {
      const envelope = parseLineEnvelope(raw, fallbackT)
      if (envelope.request) return [...flush(), envelope]
      const chunk = parseFastCgiChunk(envelope.text)

      if (!chunk) {
        return [...flush(), ...expandPlainLogEnvelope(envelope)]
      }

      if (pendingFastCgi && canAppendFastCgiChunk(pendingFastCgi, chunk)) {
        pendingFastCgi.payload += chunk.payload
        if (!chunk.complete) return []

        const pending = pendingFastCgi
        pendingFastCgi = null
        return expandFastCgiPayload(pending.envelope, pending.payload)
      }

      const flushed = flush()
      if (!chunk.complete) {
        pendingFastCgi = {
          requestId: chunk.requestId,
          envelope,
          payload: chunk.payload,
        }
        return flushed
      }

      return [...flushed, ...expandFastCgiPayload(envelope, chunk.payload)]
    },

    flush,
  }
}

function parseStatelessLogEnvelope(
  envelope: ParsedLogLine
): Array<ParsedLogLine> {
  const chunk = parseFastCgiChunk(envelope.text)
  if (chunk) {
    return (
      splitPhpMessages(chunk.payload, { allowLeadingText: true }) ?? [
        envelope.text,
      ]
    ).map((text) => ({
      ...envelope,
      text,
    }))
  }

  return expandPlainLogEnvelope(envelope)
}

export function parseLogEntries(
  raw: string,
  fallbackT: number
): Array<ParsedLogLine> {
  return parseStatelessLogEnvelope(parseLineEnvelope(raw, fallbackT))
}

// ---------------------------------------------------------------------------
// Source selection — isolate which resource/endpoint from parse/filter
// ---------------------------------------------------------------------------

export type LogSource =
  | {
      kind: "app"
      resourceId: string
      buildId?: string
      archiveOnly?: boolean
      containerId?: string
      runtimeSource?: RuntimeLogSource
    }
  | { kind: "database"; resourceId: string }
  | { kind: "service"; resourceId: string; containerIndex?: number }

export interface ResolvedLogSource {
  wsPath: string
  snapshot:
    { type: "archive"; path: string } | { type: "runtime"; path: string }
}

function isAppBuildSource(
  source: LogSource
): source is Extract<LogSource, { kind: "app" }> & { buildId: string } {
  return (
    source.kind === "app" &&
    typeof source.buildId === "string" &&
    source.buildId.length > 0 &&
    source.buildId !== "latest"
  )
}

/**
 * Maps a log source to the live WebSocket path and the HTTP snapshot/archive
 * fallback used by the same viewer for apps, databases, and services.
 */
export function resolveLogSource(source: LogSource): ResolvedLogSource {
  if (source.kind === "app" && isAppBuildSource(source)) {
    return {
      wsPath: `/ws/apps/${source.resourceId}/build/${source.buildId}`,
      snapshot: {
        type: "archive",
        path: `/apps/${source.resourceId}/logs?buildId=${encodeURIComponent(source.buildId)}`,
      },
    }
  }

  if (source.kind === "database") {
    return {
      wsPath: `/ws/databases/${source.resourceId}/logs`,
      snapshot: {
        type: "runtime",
        path: `/databases/${source.resourceId}/logs`,
      },
    }
  }

  if (source.kind === "service") {
    const index = source.containerIndex ?? 0
    const query = `?container=${index}`
    return {
      wsPath: `/ws/services/${source.resourceId}/logs${query}`,
      snapshot: {
        type: "runtime",
        path: `/services/${source.resourceId}/logs${query}`,
      },
    }
  }

  const params = new URLSearchParams()
  if (source.containerId) params.set("container", source.containerId)
  if (source.runtimeSource && source.runtimeSource !== "app")
    params.set("source", source.runtimeSource)
  const query = params.size ? `?${params}` : ""
  return {
    wsPath: `/ws/apps/${source.resourceId}/logs${query}`,
    snapshot: {
      type: "runtime",
      path: `/apps/${source.resourceId}/runtime-logs${query}`,
    },
  }
}

export interface LogProvenance {
  containers: Array<{ id: string; name: string; index: number }>
  index: number
}

export interface RuntimeLogSnapshot {
  containers?: LogProvenance["containers"]
  index?: number
  lines: Array<{
    t: number
    line: string
    stream?: "stdout" | "stderr"
  }>
  containerFound?: boolean
}

export type RuntimeSnapshotFallback =
  | { kind: "empty-runtime" }
  | { kind: "lines"; lines: Array<string>; provenance?: LogProvenance }

/**
 * Turns a runtime-log HTTP payload (app, database, or service) into the same
 * envelope lines the live WebSocket feeds into parseLogEntries.
 */
export function runtimeSnapshotToFallback(
  data: RuntimeLogSnapshot
): RuntimeSnapshotFallback {
  if (data.containerFound === false && data.lines.length === 0) {
    return { kind: "empty-runtime" }
  }
  return {
    kind: "lines",
    lines: data.lines.map((entry) => JSON.stringify(entry)),
  }
}

// ---------------------------------------------------------------------------
// useLogStream
// ---------------------------------------------------------------------------

export interface UseLogStreamOptions {
  source: LogSource
  /** Maximum number of lines retained in memory. Defaults to ABSOLUTE_MAX_LINES. */
  maxLines?: number
}

export type LogStreamStatus = "connecting" | "live" | "snapshot" | "error"

export interface UseLogStreamResult {
  provenance: LogProvenance | null
  lines: Array<LogLine>
  connected: boolean
  status: LogStreamStatus
  snapshotLoadedAt: number | null
  lastLineAt: number | null
  retry: () => void
  error: string | null
}

function loadFailedMessage(status?: number): string {
  if (typeof status === "number") {
    return i18n.t("apps:logs.loadFailedStatus", { status })
  }
  return i18n.t("apps:logs.loadFailed")
}

async function loadArchivedBuildLogs(
  path: string
): Promise<RuntimeSnapshotFallback> {
  const res = await fetch(`${apiBaseUrl()}${path}`, { credentials: "include" })
  if (!res.ok) throw new Error(loadFailedMessage(res.status))
  const text = await res.text()
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
  return { kind: "lines", lines }
}

async function loadRuntimeSnapshot(
  path: string
): Promise<RuntimeSnapshotFallback> {
  const data = await apiFetch<RuntimeLogSnapshot>(path)
  const result = runtimeSnapshotToFallback(data)
  if (result.kind === "lines" && data.containers && data.index !== undefined) {
    result.provenance = { containers: data.containers, index: data.index }
  }
  return result
}

function controlMessageKind(text: string): "missing" | "ignore" | null {
  if (!text.startsWith("{")) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null
    }
    const obj = parsed as Record<string, unknown>
    if (typeof obj.line === "string") return null
    if (obj.type === "runtime.missing") return "missing"
    if (typeof obj.type === "string") return "ignore"
    return null
  } catch {
    return null
  }
}

export function useLogStream({
  source,
  maxLines,
}: UseLogStreamOptions): UseLogStreamResult {
  const cap = Math.min(maxLines ?? ABSOLUTE_MAX_LINES, ABSOLUTE_MAX_LINES)
  const resolved = resolveLogSource(source)
  const archiveOnly = source.kind === "app" && Boolean(source.archiveOnly)
  const isBuild = isAppBuildSource(source)

  const [provenance, setProvenance] = React.useState<LogProvenance | null>(null)
  const [lines, setLines] = React.useState<Array<LogLine>>([])
  const [status, setStatus] = React.useState<LogStreamStatus>("connecting")
  const [snapshotLoadedAt, setSnapshotLoadedAt] = React.useState<number | null>(
    null
  )
  const [lastLineAt, setLastLineAt] = React.useState<number | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const retry = React.useCallback(() => {
    setStatus("connecting")
    setError(null)
    setAttempt((value) => value + 1)
  }, [])
  const [error, setError] = React.useState<string | null>(null)
  // Monotonic IDs keep unread counts valid across retention trims and retries.
  const counterRef = React.useRef(0)
  const normalizerRef = React.useRef(createLogEntryNormalizer())

  const appendParsedEntries = React.useCallback(
    (parsedEntries: Array<ParsedLogLine>) => {
      if (parsedEntries.length === 0) return
      const timestamp = parsedEntries[parsedEntries.length - 1].t
      setLastLineAt(
        typeof timestamp === "number" && Number.isFinite(timestamp)
          ? timestamp
          : Date.now()
      )
      setLines((prev) => {
        const entries = parsedEntries.map((parsed) => {
          const id = ++counterRef.current
          const entry: LogLine = { ...parsed, id }
          return entry
        })
        const next = [...prev, ...entries]
        return next.length > cap ? next.slice(next.length - cap) : next
      })
    },
    [cap]
  )

  const appendLine = React.useCallback(
    (raw: string) => {
      appendParsedEntries(normalizerRef.current.append(raw, Date.now()))
    },
    [appendParsedEntries]
  )

  const flushPendingLines = React.useCallback(() => {
    appendParsedEntries(normalizerRef.current.flush())
  }, [appendParsedEntries])

  // When maxLines changes (user picks a smaller volume), trim existing lines
  React.useEffect(() => {
    setLines((prev) =>
      prev.length > cap ? prev.slice(prev.length - cap) : prev
    )
  }, [cap])

  React.useEffect(() => {
    setLines([])
    setProvenance(null)
    setError(null)
    setStatus("connecting")
    setSnapshotLoadedAt(null)
    setLastLineAt(null)
    normalizerRef.current = createLogEntryNormalizer()

    let cancelled = false
    let ws: WebSocket | undefined
    let fallbackTriggered = false
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    let connectionTimer: ReturnType<typeof setTimeout> | null = null

    const loadSnapshot = async (): Promise<void> => {
      try {
        const result = await (resolved.snapshot.type === "archive"
          ? loadArchivedBuildLogs(resolved.snapshot.path)
          : loadRuntimeSnapshot(resolved.snapshot.path))
        if (cancelled) return
        if (result.kind === "empty-runtime") {
          setError(i18n.t("apps:logs.noRuntimeContainer"))
          setStatus("error")
          return
        }
        setProvenance(result.provenance ?? null)
        setLines([])
        normalizerRef.current = createLogEntryNormalizer()
        for (const raw of result.lines) appendLine(raw)
        flushPendingLines()
        setSnapshotLoadedAt(Date.now())
        setStatus("snapshot")
        setError(null)
      } catch (err: unknown) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : loadFailedMessage())
        setStatus("error")
      }
    }

    const scheduleFallback = (): void => {
      if (cancelled || fallbackTriggered) return
      fallbackTriggered = true
      if (connectionTimer) clearTimeout(connectionTimer)
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      }
      flushPendingLines()
      setStatus("connecting")
      // Finished builds may persist their archive just after the socket closes.
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null
        void loadSnapshot()
      }, 1_000)
    }

    if (archiveOnly && isBuild) {
      void loadSnapshot()
    } else {
      try {
        ws = new WebSocket(`${apiWebSocketBaseUrl()}${resolved.wsPath}`)
        connectionTimer = setTimeout(scheduleFallback, 10_000)
        ws.onopen = () => {
          if (cancelled) return
          if (connectionTimer) clearTimeout(connectionTimer)
          setStatus("live")
          setError(null)
        }
        ws.onmessage = (ev: MessageEvent<string>) => {
          if (cancelled) return
          const text = typeof ev.data === "string" ? ev.data : String(ev.data)
          if (text.startsWith("{")) {
            try {
              const message = JSON.parse(text) as Partial<LogProvenance> & {
                type?: string
              }
              if (
                message.type === "runtime.source" &&
                Array.isArray(message.containers) &&
                typeof message.index === "number"
              ) {
                const containers = message.containers.filter(
                  (container) =>
                    typeof container.id === "string" &&
                    typeof container.name === "string" &&
                    Number.isInteger(container.index)
                )
                setProvenance({ containers, index: message.index })
                return
              }
            } catch {
              /* A non-JSON log line is handled by the normalizer. */
            }
          }
          const control = controlMessageKind(text)
          if (control === "missing") {
            setError(i18n.t("apps:logs.noRuntimeContainer"))
            setStatus("error")
            return
          }
          if (control === "ignore") return
          setStatus("live")
          setError(null)
          appendLine(text)
        }
        ws.onerror = scheduleFallback
        ws.onclose = scheduleFallback
      } catch {
        scheduleFallback()
      }
    }

    return () => {
      cancelled = true
      if (fallbackTimer) clearTimeout(fallbackTimer)
      if (connectionTimer) clearTimeout(connectionTimer)
      if (ws) {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        ws.close()
      }
    }
  }, [
    resolved.wsPath,
    resolved.snapshot.path,
    resolved.snapshot.type,
    archiveOnly,
    isBuild,
    appendLine,
    flushPendingLines,
    attempt,
  ])

  return {
    provenance,
    lines,
    connected: status === "live",
    status,
    snapshotLoadedAt,
    lastLineAt,
    retry,
    error,
  }
}
