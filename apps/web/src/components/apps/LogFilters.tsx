// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiCloseLine,
  RiMoreLine,
  RiPauseLine,
  RiPlayLine,
  RiSearchLine,
} from "@remixicon/react"
import { cn } from "@workspace/ui/lib/utils"
import { Button } from "@workspace/ui/components/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@workspace/ui/components/input-group"
import { NativeSelect } from "@workspace/ui/components/native-select"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../i18n/dialog"
import type { LogLevel } from "../../lib/hooks/use-log-stream"

export type VolumeOption = 100 | 500 | 1000 | 5000

export const VOLUME_OPTIONS: ReadonlyArray<VolumeOption> = [
  100, 500, 1000, 5000,
]

export interface LogFiltersState {
  volume: VolumeOption
  level: LogLevel
  search: string
  paused: boolean
  /** Word-wrap long log lines (default true) */
  wrap: boolean
  /** Show timestamp column (default true) */
  timestamps: boolean
}

export interface LogFiltersProps {
  state: LogFiltersState
  onChange: (next: Partial<LogFiltersState>) => void
  /** Called when the user clicks Download (raw .log). */
  onDownload: () => void
  /** Called when the user clicks Copy: copies filtered lines to clipboard. */
  onCopy?: () => void | Promise<void>
  /** Called when the user wants to jump to next/previous error line. */
  onJumpError?: (direction: "next" | "prev") => void
  /** Number of buffered lines (shown when paused) */
  bufferedCount?: number
  /** Total error / warn line counts in the current view (filtered). */
  errorCount?: number
  className?: string
  /** Imperative ref to focus the search input (e.g. via "/" shortcut). */
  searchInputRef?: React.RefObject<HTMLInputElement | null>
}

export function formatVolume(v: VolumeOption): string {
  return v >= 1000 ? `${v / 1000}k` : String(v)
}

export function LogFilters({
  state,
  onChange,
  onDownload,
  onCopy,
  onJumpError,
  bufferedCount = 0,
  errorCount = 0,
  className,
  searchInputRef,
}: LogFiltersProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [searchDraft, setSearchDraft] = React.useState(state.search)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const volumeId = React.useId()
  const levelId = React.useId()

  React.useEffect(() => {
    setSearchDraft(state.search)
  }, [state.search])

  const handleSearchChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setSearchDraft(value)
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        onChange({ search: value })
      }, 200)
    },
    [onChange]
  )

  const handleClearSearch = React.useCallback(() => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    setSearchDraft("")
    onChange({ search: "" })
  }, [onChange])

  React.useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    },
    []
  )

  const handleVolumeChange = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onChange({ volume: Number(e.target.value) as VolumeOption })
    },
    [onChange]
  )

  const handleLevelChange = React.useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onChange({ level: e.target.value as LogLevel })
    },
    [onChange]
  )

  const handleTogglePause = React.useCallback(() => {
    onChange({ paused: !state.paused })
  }, [onChange, state.paused])

  const handleCopy = async () => {
    if (!onCopy || copying) return
    setCopying(true)
    try {
      await onCopy()
      setCopied(true)
    } finally {
      setCopying(false)
    }
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-panel-border bg-panel px-4 py-2 font-sans",
        className
      )}
      role="toolbar"
      aria-label={t("logs.filters")}
    >
      <InputGroup className="h-9 basis-full sm:grow sm:basis-56">
        <InputGroupAddon>
          <RiSearchLine aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchInputRef}
          type="search"
          value={searchDraft}
          onChange={handleSearchChange}
          placeholder={t("logs.searchPlaceholder")}
          aria-label={t("logs.search")}
        />
        {searchDraft && (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-sm"
              onClick={handleClearSearch}
              aria-label={t("logs.clearSearch")}
            >
              <RiCloseLine aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        )}
      </InputGroup>
      <div className="flex min-w-0 items-center gap-1.5">
        <label htmlFor={volumeId} className="text-xs text-muted-foreground">
          {t("logs.lines")}
        </label>
        <NativeSelect
          id={volumeId}
          value={state.volume}
          onChange={handleVolumeChange}
          aria-label={t("logs.maxLines")}
          className="w-auto text-base md:text-sm"
        >
          {VOLUME_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {formatVolume(v)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <label htmlFor={levelId} className="text-xs text-muted-foreground">
          {t("logs.level")}
        </label>
        <NativeSelect
          id={levelId}
          value={state.level}
          onChange={handleLevelChange}
          aria-label={t("logs.levelFilter")}
          className="w-auto text-base md:text-sm"
        >
          <option value="all">{t("logs.all")}</option>
          <option value="debug">{t("logs.debug")}</option>
          <option value="info">{t("logs.info")}</option>
          <option value="warn">{t("logs.warn")}</option>
          <option value="error">{t("logs.error")}</option>
        </NativeSelect>
      </div>
      {onJumpError && errorCount > 0 && (
        <div className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onJumpError("prev")}
            title={t("logs.prevErrorTitle")}
            aria-label={t("logs.prevError")}
          >
            <RiArrowUpLine aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onJumpError("next")}
            title={t("logs.nextErrorTitle")}
            aria-label={t("logs.nextError")}
          >
            <RiArrowDownLine aria-hidden="true" />
          </Button>
        </div>
      )}
      {state.paused && bufferedCount > 0 && (
        <span className="text-xs text-muted-foreground">
          {t("logs.buffered", { count: bufferedCount })}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleTogglePause}
        aria-pressed={state.paused}
        title={state.paused ? t("logs.resumeFlush") : t("logs.pauseDisplay")}
      >
        {state.paused ? (
          <RiPlayLine aria-hidden="true" />
        ) : (
          <RiPauseLine aria-hidden="true" />
        )}
        {state.paused ? t("logs.resume") : t("logs.pause")}
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="ghost" size="sm">
            {t("logs.shortcuts")}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[80dvh] overflow-auto font-sans">
          <DialogHeader>
            <DialogTitle>{t("logs.shortcuts")}</DialogTitle>
            <DialogDescription>{t("logs.shortcutsScope")}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-5 gap-y-3 text-sm">
            {(
              [
                ["/", "shortcutSearch"],
                [t("logs.escapeKey"), "shortcutEscape"],
                ["P", "shortcutPause"],
                ["W", "shortcutWrap"],
                ["T", "shortcutTimestamps"],
                ["g / G", "shortcutEdges"],
                ["n / N", "shortcutErrors"],
              ] as const
            ).map(([keys, label]) => (
              <React.Fragment key={label}>
                <dt>
                  <kbd className="rounded border border-panel-border bg-panel-inset px-2 py-1 font-sans">
                    {keys}
                  </kbd>
                </dt>
                <dd>{t(`logs.${label}`)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("logs.options")}
          >
            <RiMoreLine aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 font-sans">
          <DropdownMenuCheckboxItem
            checked={state.wrap}
            onCheckedChange={(wrap) => onChange({ wrap })}
          >
            {t("logs.wrapTitle")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={state.timestamps}
            onCheckedChange={(timestamps) => onChange({ timestamps })}
          >
            {t("logs.timestampsTitle")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {onCopy && (
            <DropdownMenuItem
              asChild
              onSelect={(event) => {
                event.preventDefault()
                void handleCopy()
              }}
            >
              <Button
                type="button"
                variant="ghost"
                loading={copying}
                className="w-full justify-start"
              >
                {copied ? t("logs.copied") : t("logs.copyLogs")}
              </Button>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={onDownload}>
            {t("logs.downloadLogs")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const PREFS_KEY = "ploydok:logs:prefs"

interface PersistedPrefs {
  wrap?: boolean
  timestamps?: boolean
  volume?: VolumeOption
}

function loadPrefs(): PersistedPrefs {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersistedPrefs
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function savePrefs(prefs: PersistedPrefs): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable */
  }
}

export function useLogFilters(
  defaults?: Partial<LogFiltersState>
): [LogFiltersState, (next: Partial<LogFiltersState>) => void] {
  const [state, setState] = React.useState<LogFiltersState>(() => {
    const persisted = loadPrefs()
    return {
      volume: persisted.volume ?? 100,
      level: "all",
      search: "",
      paused: false,
      wrap: persisted.wrap ?? true,
      timestamps: persisted.timestamps ?? true,
      ...defaults,
    }
  })

  const onChange = React.useCallback((next: Partial<LogFiltersState>) => {
    setState((prev) => {
      const merged = { ...prev, ...next }
      // Persist UI prefs only: search/level/paused are session-scoped
      if ("wrap" in next || "timestamps" in next || "volume" in next) {
        savePrefs({
          wrap: merged.wrap,
          timestamps: merged.timestamps,
          volume: merged.volume,
        })
      }
      return merged
    })
  }, [])

  return [state, onChange]
}
