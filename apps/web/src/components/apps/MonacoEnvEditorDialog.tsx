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
import { detectLanguage } from "../../lib/env-language-detect"

// ---------------------------------------------------------------------------
// Lazy load Monaco — not SSR-safe.
// The Editor is only mounted when the dialog opens on the client, so we guard
// with React.lazy + a Suspense boundary.  The fallback textarea avoids a
// render-flash on first open.
// ---------------------------------------------------------------------------

const MonacoEditor = React.lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default })),
)

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MonacoEnvEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The env var key — displayed in the dialog title. */
  envKey: string
  /** Value when the dialog opens. */
  initialValue: string
  /** Called with the new value when the user clicks Save or presses Cmd/Ctrl+S. */
  onSave: (value: string) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MonacoEnvEditorDialog({
  open,
  onOpenChange,
  envKey,
  initialValue,
  onSave,
}: MonacoEnvEditorDialogProps): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const [draft, setDraft] = React.useState(initialValue)

  // Reset draft whenever dialog opens with a new value.
  React.useEffect(() => {
    if (open) setDraft(initialValue)
  }, [open, initialValue])

  const language = detectLanguage(initialValue)

  function handleSave() {
    onSave(draft)
    onOpenChange(false)
  }

  function handleCancel() {
    onOpenChange(false)
  }

  // Cmd+S / Ctrl+S keybinding — Monaco also has its own editor action for
  // CtrlCmd+S, but we wire it here as well so the dialog-level handler fires
  // regardless of focus.
  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault()
      handleSave()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-w-4xl flex-col gap-0 p-0 sm:max-w-4xl"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="font-mono text-sm">
            {t("common:edit")}{" "}
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{envKey}</span>
          </DialogTitle>
        </DialogHeader>

        {/* Editor area — only rendered on the client */}
        <div className="h-[60vh] w-full overflow-hidden">
          {typeof window !== "undefined" ? (
            <React.Suspense
              fallback={
                <textarea
                  className="h-full w-full resize-none bg-[#1e1e1e] p-3 font-mono text-xs text-[#d4d4d4] outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label={t("env.loadingEditor")}
                />
              }
            >
              <MonacoEditor
                height="60vh"
                language={language}
                value={draft}
                theme="vs-dark"
                onChange={(v) => setDraft(v ?? "")}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  tabSize: 2,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  renderLineHighlight: "line",
                  // Wire Cmd+S / Ctrl+S inside the editor
                  // (editor-level keybinding is added via onMount below)
                }}
                onMount={(editor, monaco) => {
                  editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                    () => handleSave(),
                  )
                  editor.focus()
                }}
              />
            </React.Suspense>
          ) : (
            // SSR placeholder — never visible to the user since the Dialog
            // is never rendered on the server (radix portal).
            <div className="h-full w-full bg-[#1e1e1e]" />
          )}
        </div>

        <DialogFooter className="items-center justify-between rounded-b-xl border-t bg-muted/50 px-4 py-2">
          <span className="text-xs text-muted-foreground">
            <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]">
              {typeof navigator !== "undefined" &&
              /Mac/.test(navigator.platform)
                ? "⌘"
                : "Ctrl"}
            </kbd>
            {"+"}
            <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]">S</kbd>
            {t("env.saveShortcut")}
            <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]">Esc</kbd>
            {t("env.cancelShortcut")}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleCancel}>
              {t("common:cancel")}
            </Button>
            <Button size="sm" onClick={handleSave}>
              {t("common:save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
