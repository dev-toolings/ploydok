// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import i18n from "../../lib/i18n"
import { looksSecret, parseDotenv } from "../../lib/env-parser"
import type { ParseEnvError, ParsedEnvEntry } from "../../lib/env-parser"
import type { EnvVarPatch } from "../../lib/apps-env"

export type ImportStrategy = "merge" | "replace" | "append"

export interface EnvImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Raw .env content to preview. */
  rawContent: string
  /** Optional filename shown in the header. */
  filename?: string
  /** Current rows in the table, used for conflict detection. */
  existingKeys: Array<string>
  /** Called when the user confirms the import. */
  onConfirm: (entries: Array<EnvVarPatch>, strategy: ImportStrategy) => void
}

export function EnvImportDialog({
  open,
  onOpenChange,
  rawContent,
  filename,
  existingKeys,
  onConfirm,
}: EnvImportDialogProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [strategy, setStrategy] = React.useState<ImportStrategy>("merge")
  const [overrides, setOverrides] = React.useState<Map<string, { value: string; secret: boolean; skip: boolean }>>(
    new Map(),
  )

  const parsed = React.useMemo(() => parseDotenv(rawContent), [rawContent])
  const existingSet = React.useMemo(() => new Set(existingKeys), [existingKeys])

  React.useEffect(() => {
    if (!open) return
    const next = new Map<string, { value: string; secret: boolean; skip: boolean }>()
    for (const entry of parsed.entries) {
      next.set(entry.key, {
        value: entry.value,
        secret: looksSecret(entry.key),
        skip: false,
      })
    }
    setOverrides(next)
    setStrategy("merge")
  }, [open, parsed])

  const conflicts = parsed.entries.filter((e) => existingSet.has(e.key))
  const additions = parsed.entries.filter((e) => !existingSet.has(e.key))

  const selectedEntries = parsed.entries.filter((e) => !overrides.get(e.key)?.skip)

  function handleConfirm() {
    const patches: Array<EnvVarPatch> = selectedEntries.map((e) => {
      const o = overrides.get(e.key)
      return {
        key: e.key,
        value: o?.value ?? e.value,
        secret: o?.secret ?? looksSecret(e.key),
      }
    })
    onConfirm(patches, strategy)
    onOpenChange(false)
  }

  function toggleSkip(key: string) {
    setOverrides((prev) => {
      const next = new Map(prev)
      const cur = next.get(key)
      if (cur) next.set(key, { ...cur, skip: !cur.skip })
      return next
    })
  }

  function toggleSecret(key: string) {
    setOverrides((prev) => {
      const next = new Map(prev)
      const cur = next.get(key)
      if (cur) next.set(key, { ...cur, secret: !cur.secret })
      return next
    })
  }

  const selectedCount = selectedEntries.length
  const hasEntries = parsed.entries.length > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-sm">
            {t("env.importTitle")}
            {filename && (
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {filename}
              </span>
            )}
          </DialogTitle>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <Stat label={t("env.total")} value={parsed.entries.length} />
            <Stat label={t("env.new")} value={additions.length} tone="success" />
            <Stat label={t("env.conflicts")} value={conflicts.length} tone={conflicts.length > 0 ? "warning" : "muted"} />
            {parsed.errors.length > 0 && (
              <Stat label={t("env.errors")} value={parsed.errors.length} tone="destructive" />
            )}
          </div>
        </DialogHeader>

        {conflicts.length > 0 && (
          <div className="border-b bg-muted/30 px-5 py-3">
            <p className="mb-2 text-xs font-medium">{t("env.onConflict")}</p>
            <div className="flex flex-wrap gap-2">
              <StrategyChip
                active={strategy === "merge"}
                onClick={() => setStrategy("merge")}
                label={t("env.overwrite")}
                hint={t("env.overwriteHint")}
              />
              <StrategyChip
                active={strategy === "append"}
                onClick={() => setStrategy("append")}
                label={t("env.keepExisting")}
                hint={t("env.keepHint")}
              />
              <StrategyChip
                active={strategy === "replace"}
                onClick={() => setStrategy("replace")}
                label={t("env.replaceAll")}
                hint={t("env.replaceHint")}
              />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {!hasEntries && parsed.errors.length === 0 && (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              {t("env.noVars")}
            </div>
          )}

          {parsed.errors.length > 0 && (
            <div className="border-b px-5 py-3">
              <p className="mb-1.5 text-xs font-medium text-destructive">{t("env.parseErrors")}</p>
              <ul className="space-y-1 text-xs">
                {parsed.errors.map((err, i) => (
                  <li key={i} className="font-mono text-destructive/90">
                    <span className="text-muted-foreground">{t("env.line", { line: err.line })}</span> {err.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasEntries && (
            <ul className="divide-y divide-border">
              {parsed.entries.map((entry) => {
                const override = overrides.get(entry.key)
                const isConflict = existingSet.has(entry.key)
                const isSkipped = override?.skip ?? false
                const isSecret = override?.secret ?? looksSecret(entry.key)
                return (
                  <li
                    key={entry.key}
                    className={[
                      "grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-2.5 text-xs transition-opacity",
                      isSkipped ? "opacity-40" : "",
                    ].join(" ")}
                  >
                    <input
                      type="checkbox"
                      checked={!isSkipped}
                      onChange={() => toggleSkip(entry.key)}
                      className="size-3.5 cursor-pointer accent-primary"
                      aria-label={t("env.includeKey", { key: entry.key })}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono font-medium">{entry.key}</span>
                        {isConflict && (
                          <span className="rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                            {t("env.conflict")}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {isSecret ? "•".repeat(Math.min(entry.value.length, 24)) : preview(entry.value)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleSecret(entry.key)}
                      title={isSecret ? t("env.markPlain") : t("env.markSecret")}
                      className={[
                        "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                        isSecret
                          ? "bg-primary/10 text-primary hover:bg-primary/20"
                          : "bg-muted text-muted-foreground hover:bg-muted/70",
                      ].join(" ")}
                    >
                      {isSecret ? t("env.secret") : t("env.plain")}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="items-center justify-between rounded-b-xl border-t bg-muted/40 px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {t("env.willImport", {
              selected: selectedCount,
              total: parsed.entries.length,
            })}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t("common:cancel")}
            </Button>
            <Button size="sm" onClick={handleConfirm} disabled={selectedCount === 0}>
              {selectedCount > 0
                ? t("env.importCount", { count: selectedCount })
                : t("env.import")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function preview(value: string): string {
  if (value.length > 80) return value.slice(0, 80) + "…"
  if (value.includes("\n")) return value.replace(/\n/g, "⏎").slice(0, 80)
  return value || i18n.t("apps:env.emptyValue")
}

function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string
  value: number
  tone?: "muted" | "success" | "warning" | "destructive"
}): React.JSX.Element {
  const toneClass = {
    muted: "text-muted-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    destructive: "text-destructive",
  }[tone]
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={[toneClass, "font-semibold tabular-nums"].join(" ")}>{value}</span>
      <span>{label}</span>
    </span>
  )
}

function StrategyChip({
  active,
  onClick,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  label: string
  hint: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={[
        "rounded-md border px-2.5 py-1 text-left text-[11px] transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground",
      ].join(" ")}
    >
      <div className="font-medium">{label}</div>
      <div className="text-[10px] opacity-75">{hint}</div>
    </button>
  )
}

export type { ParsedEnvEntry, ParseEnvError }
