// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import i18n from "../../lib/i18n"
import { MonacoEnvEditorDialog } from "./MonacoEnvEditorDialog"
import { EnvImportDialog } from "./EnvImportDialog"
import type { ImportStrategy } from "./EnvImportDialog"
import type { EnvVar, EnvVarPatch } from "../../lib/apps-env"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENV_KEY_REGEX = /^[A-Z][A-Z0-9_]*$/
const SECRET_MASK = "********"
const MAX_IMPORT_BYTES = 512 * 1024

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EditableVar extends EnvVarPatch {
  revealed: boolean
  keyError?: string
}

export interface EnvTableProps {
  serverVars: Array<EnvVar>
  isSaving: boolean
  onSave: (vars: Array<EnvVarPatch>) => void
  /** When set, Save is disabled with this tooltip (e.g. 2FA required). */
  lockReason?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function shouldOfferMultilineEdit(value: string): boolean {
  return value.includes("\n") || value.length > 80
}

export function validateKey(key: string): string | undefined {
  if (!key) return i18n.t("apps:env.keyRequired")
  if (!ENV_KEY_REGEX.test(key)) return i18n.t("apps:env.upperSnake")
  return undefined
}

export function hasDiff(
  localVars: Array<EnvVarPatch>,
  serverVars: Array<EnvVar>
): boolean {
  if (localVars.length !== serverVars.length) return true
  const serverMap = new Map(serverVars.map((v) => [v.key, v]))
  for (const local of localVars) {
    const server = serverMap.get(local.key)
    if (!server) return true
    if (local.secret !== server.secret) return true
    if (local.secret && local.value === SECRET_MASK) continue
    if (local.value !== server.value) return true
  }
  return false
}

function initEditable(serverVars: Array<EnvVar>): Array<EditableVar> {
  return serverVars.map((v) => ({
    key: v.key,
    value: v.value,
    secret: v.secret,
    revealed: false,
    keyError: undefined,
  }))
}

// ---------------------------------------------------------------------------
// EnvTable
// ---------------------------------------------------------------------------

interface MonacoDialogState {
  open: boolean
  rowIndex: number
  rowKey: string
  rowValue: string
}

interface ImportDialogState {
  open: boolean
  rawContent: string
  filename: string
}

export function EnvTable({
  serverVars,
  isSaving,
  onSave,
  lockReason,
}: EnvTableProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [rows, setRows] = React.useState<Array<EditableVar>>(() =>
    initEditable(serverVars)
  )
  const [revealAll, setRevealAll] = React.useState(false)
  const [monacoDialog, setMonacoDialog] = React.useState<MonacoDialogState>({
    open: false,
    rowIndex: -1,
    rowKey: "",
    rowValue: "",
  })
  const [importDialog, setImportDialog] = React.useState<ImportDialogState>({
    open: false,
    rawContent: "",
    filename: "",
  })
  const [isDragging, setIsDragging] = React.useState(false)
  const [importError, setImportError] = React.useState<string | null>(null)
  const dragDepth = React.useRef(0)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const prevServerRef = React.useRef(serverVars)
  React.useEffect(() => {
    if (prevServerRef.current !== serverVars) {
      prevServerRef.current = serverVars
      setRows(initEditable(serverVars))
      setRevealAll(false)
    }
  }, [serverVars])

  const localPatches: Array<EnvVarPatch> = rows.map(
    ({ key, value, secret }) => ({
      key,
      value,
      secret,
    })
  )

  const diff = hasDiff(localPatches, serverVars)
  const hasKeyErrors = rows.some((r) => r.keyError !== undefined)
  const pendingCount = (() => {
    if (!diff) return 0
    const serverMap = new Map(serverVars.map((v) => [v.key, v]))
    let count = 0
    for (const row of rows) {
      const server = serverMap.get(row.key)
      if (!server) {
        count++
        continue
      }
      if (row.secret !== server.secret) {
        count++
        continue
      }
      if (row.secret && row.value === SECRET_MASK) continue
      if (row.value !== server.value) count++
    }
    const localKeys = new Set(rows.map((r) => r.key))
    for (const sv of serverVars) {
      if (!localKeys.has(sv.key)) count++
    }
    return count
  })()

  // ---------------------------------------------------------------------------
  // Row handlers
  // ---------------------------------------------------------------------------

  function updateRow(index: number, updates: Partial<EditableVar>) {
    setRows((prev) =>
      prev.map((row, i) => {
        if (i !== index) return row
        const next = { ...row, ...updates }
        if ("key" in updates) {
          next.keyError = validateKey(next.key)
        }
        return next
      })
    )
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        key: "",
        value: "",
        secret: false,
        revealed: false,
        keyError: undefined,
      },
    ])
  }

  function deleteRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index))
  }

  function toggleRevealRow(index: number) {
    updateRow(index, { revealed: !rows[index].revealed })
  }

  function openMonacoEditor(index: number) {
    const row = rows[index]
    setMonacoDialog({
      open: true,
      rowIndex: index,
      rowKey: row.key,
      rowValue: row.value,
    })
  }

  function handleMonacoSave(newValue: string) {
    updateRow(monacoDialog.rowIndex, { value: newValue })
  }

  function handleSave() {
    const validated = rows.map((row) => ({
      ...row,
      keyError: validateKey(row.key),
    }))
    setRows(validated)
    if (validated.some((r) => r.keyError)) return
    onSave(localPatches)
  }

  // ---------------------------------------------------------------------------
  // Import / drag & drop
  // ---------------------------------------------------------------------------

  function openFilePicker() {
    fileInputRef.current?.click()
  }

  async function readFile(file: File) {
    setImportError(null)
    if (file.size > MAX_IMPORT_BYTES) {
      setImportError(
        t("env.fileTooLarge", { size: (file.size / 1024).toFixed(0) })
      )
      return
    }
    try {
      const text = await file.text()
      setImportDialog({ open: true, rawContent: text, filename: file.name })
    } catch {
      setImportError(t("env.couldNotRead"))
    }
  }

  async function onFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (file) await readFile(file)
  }

  function onDragEnter(e: React.DragEvent) {
    if (!hasFileItems(e.dataTransfer)) return
    e.preventDefault()
    dragDepth.current++
    setIsDragging(true)
  }

  function onDragOver(e: React.DragEvent) {
    if (!hasFileItems(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = "copy"
  }

  function onDragLeave(e: React.DragEvent) {
    if (!hasFileItems(e.dataTransfer)) return
    e.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  }

  async function onDrop(e: React.DragEvent) {
    if (!hasFileItems(e.dataTransfer)) return
    e.preventDefault()
    dragDepth.current = 0
    setIsDragging(false)
    const file = e.dataTransfer.files.item(0)
    if (file) await readFile(file)
  }

  function handleImportConfirm(
    entries: Array<EnvVarPatch>,
    strategy: ImportStrategy
  ) {
    setRows((prev) => {
      if (strategy === "replace") {
        return entries.map((e) => ({
          key: e.key,
          value: e.value,
          secret: e.secret,
          revealed: false,
          keyError: validateKey(e.key),
        }))
      }

      const existing = new Map(prev.map((r, i) => [r.key, i]))
      const next = [...prev]

      for (const entry of entries) {
        const idx = existing.get(entry.key)
        if (idx === undefined) {
          next.push({
            key: entry.key,
            value: entry.value,
            secret: entry.secret,
            revealed: false,
            keyError: validateKey(entry.key),
          })
          continue
        }
        if (strategy === "merge") {
          next[idx] = {
            ...next[idx],
            value: entry.value,
            secret: entry.secret,
            keyError: validateKey(entry.key),
          }
        }
      }
      return next
    })
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="relative space-y-5"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-sm font-medium">{t("env.title")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("env.variables", { count: rows.length })}
              {t("env.dragHint")}
            </p>
          </div>
          {diff && pendingCount > 0 && (
            <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              {t("env.unsaved", { count: pendingCount })}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".env,.env.local,.env.production,.env.development,.env.*,text/plain,application/octet-stream"
            onChange={onFileInputChange}
            className="hidden"
            aria-hidden="true"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openFilePicker}
            className="gap-1.5 text-xs"
          >
            <UploadIcon className="size-3.5" />
            {t("env.importEnv")}
          </Button>
          {rows.some((r) => r.secret) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRevealAll((v) => !v)}
              className="gap-1.5 text-xs"
            >
              {revealAll ? (
                <EyeOffIcon className="size-3.5" />
              ) : (
                <EyeIcon className="size-3.5" />
              )}
              {revealAll ? t("env.hideAll") : t("env.revealAll")}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            loading={isSaving}
            disabled={!diff || hasKeyErrors || Boolean(lockReason)}
            onClick={handleSave}
            title={lockReason}
          >
            {isSaving ? t("common:saving") : t("common:save")}
          </Button>
        </div>
      </div>

      {importError && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-neg-100 dark:bg-[#4d0218]/60 px-3 py-2 text-xs text-neg-700 dark:text-[#ff637e]"
        >
          {importError}
        </div>
      )}

      {/* Drag overlay */}
      {isDragging && (
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-sm"
          aria-hidden="true"
        >
          <div className="flex flex-col items-center gap-2 text-primary">
            <UploadIcon className="size-8" />
            <p className="text-sm font-medium">{t("env.dropFile")}</p>
            <p className="text-xs text-primary/70">
              {t("env.dropReview")}
            </p>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-2xl bg-panel/30">
        {rows.length === 0 ? (
          <EmptyDropArea onPickFile={openFilePicker} onAddManually={addRow} />
        ) : (
          <>
            <div className="grid grid-cols-[minmax(200px,1.1fr)_minmax(260px,2fr)_auto_auto_auto] gap-0 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-medium text-muted-foreground">
              <span>{t("env.key")}</span>
              <span>{t("env.value")}</span>
              <span className="px-3">{t("env.secret")}</span>
              <span />
              <span />
            </div>

            <div className="divide-y divide-border">
              {rows.map((row, idx) => {
                const isRevealed = revealAll || row.revealed
                const isSecret = row.secret
                const multiline = shouldOfferMultilineEdit(row.value)

                return (
                  <div
                    key={idx}
                    className="grid grid-cols-[minmax(200px,1.1fr)_minmax(260px,2fr)_auto_auto_auto] items-start gap-0 px-4 py-3 transition-colors hover:bg-muted/20"
                  >
                    {/* Key */}
                    <div className="pr-3">
                      <input
                        type="text"
                        value={row.key}
                        onChange={(e) =>
                          updateRow(idx, { key: e.target.value.toUpperCase() })
                        }
                        placeholder="MY_VAR"
                        aria-label={t("env.variableKey")}
                        className={[
                          "w-full rounded-md border px-2.5 py-1.5 font-mono text-xs",
                          "bg-background outline-none focus:ring-1",
                          row.keyError
                            ? "border-destructive focus:ring-destructive"
                            : "border-border focus:border-ring focus:ring-ring",
                        ].join(" ")}
                      />
                      {row.keyError && (
                        <p className="mt-1 text-[10px] text-destructive">
                          {row.keyError}
                        </p>
                      )}
                    </div>

                    {/* Value */}
                    <div className="flex items-start gap-1.5 pr-3">
                      <input
                        type={isSecret && !isRevealed ? "password" : "text"}
                        value={row.value}
                        onChange={(e) =>
                          updateRow(idx, { value: e.target.value })
                        }
                        placeholder={isSecret ? SECRET_MASK : t("env.valuePlaceholder")}
                        aria-label={t("env.variableValue")}
                        className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-ring focus:ring-1 focus:ring-ring"
                      />
                      {isSecret && (
                        <button
                          type="button"
                          onClick={() => toggleRevealRow(idx)}
                          title={isRevealed ? t("common:hide") : t("common:reveal")}
                          aria-label={
                            isRevealed ? t("env.hideValue") : t("env.revealValue")
                          }
                          className="flex-shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          {isRevealed ? (
                            <EyeOffIcon className="size-3.5" />
                          ) : (
                            <EyeIcon className="size-3.5" />
                          )}
                        </button>
                      )}
                    </div>

                    {/* Secret toggle */}
                    <div className="flex items-center justify-center px-3 pt-1">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isSecret}
                        onClick={() => updateRow(idx, { secret: !isSecret })}
                        title={
                          isSecret ? t("env.markPlainText") : t("env.markSecret")
                        }
                        className={[
                          "relative inline-flex h-4 w-7 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent",
                          "transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:outline-none",
                          isSecret ? "bg-primary" : "bg-muted",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "pointer-events-none inline-block size-3 rounded-full bg-white shadow",
                            "transform transition duration-200 ease-in-out",
                            isSecret ? "translate-x-3" : "translate-x-0",
                          ].join(" ")}
                        />
                      </button>
                    </div>

                    {/* Monaco editor */}
                    <div className="flex items-center justify-center pt-0.5">
                      <button
                        type="button"
                        onClick={() => openMonacoEditor(idx)}
                        title={t("env.editAsText")}
                        aria-label={t("env.editKey", { key: row.key || t("env.deleteVariableFallback") })}
                        className={[
                          "rounded p-1.5 transition-colors",
                          multiline
                            ? "text-primary hover:bg-primary/10"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        ].join(" ")}
                      >
                        <PenIcon className="size-3.5" />
                      </button>
                    </div>

                    {/* Delete */}
                    <div className="flex items-center justify-center pt-0.5">
                      <button
                        type="button"
                        onClick={() => deleteRow(idx)}
                        aria-label={t("env.deleteVariable", { name: row.key || t("env.deleteVariableFallback") })}
                        className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2.5">
              <button
                type="button"
                onClick={addRow}
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <PlusIcon className="size-3.5" />
                {t("env.addVariable")}
              </button>
              <button
                type="button"
                onClick={openFilePicker}
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <UploadIcon className="size-3.5" />
                {t("env.importEnv")}
              </button>
            </div>
          </>
        )}
      </div>

      <MonacoEnvEditorDialog
        open={monacoDialog.open}
        onOpenChange={(open) => setMonacoDialog((prev) => ({ ...prev, open }))}
        envKey={monacoDialog.rowKey}
        initialValue={monacoDialog.rowValue}
        onSave={handleMonacoSave}
      />

      <EnvImportDialog
        open={importDialog.open}
        onOpenChange={(open) => setImportDialog((prev) => ({ ...prev, open }))}
        rawContent={importDialog.rawContent}
        filename={importDialog.filename}
        existingKeys={rows.map((r) => r.key)}
        onConfirm={handleImportConfirm}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// EmptyDropArea — shown when there are zero rows
// ---------------------------------------------------------------------------

function EmptyDropArea({
  onPickFile,
  onAddManually,
}: {
  onPickFile: () => void
  onAddManually: () => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <UploadIcon className="size-6 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">{t("env.dropToStart")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("env.emptyHint")}
        </p>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onPickFile}>
          {t("env.chooseFile")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onAddManually}>
          {t("env.addManually")}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFileItems(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes("Files")
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function EyeIcon({ className }: { className?: string }): React.JSX.Element {
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
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function EyeOffIcon({ className }: { className?: string }): React.JSX.Element {
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
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
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
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4h6v2" />
    </svg>
  )
}

function PlusIcon({ className }: { className?: string }): React.JSX.Element {
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
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function PenIcon({ className }: { className?: string }): React.JSX.Element {
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
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  )
}

function UploadIcon({ className }: { className?: string }): React.JSX.Element {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}
