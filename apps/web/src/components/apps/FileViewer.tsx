// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { RiAlertLine, RiFileLine, RiLoader4Line } from "@remixicon/react"
import { Badge } from "@workspace/ui/components/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import {
  decodeFileContent,
  formatBytes,
  readContainerFile,
} from "../../lib/container-files"

interface FileViewerProps {
  appId: string
  path: string | null
  onClose: () => void
}

interface ViewerState {
  loading: boolean
  error: string | null
  text: string | null
  size: number
  truncated: boolean
  isBinary: boolean
}

const INITIAL: ViewerState = {
  loading: true,
  error: null,
  text: null,
  size: 0,
  truncated: false,
  isBinary: false,
}

export function FileViewer({
  appId,
  path,
  onClose,
}: FileViewerProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [state, setState] = React.useState<ViewerState>(INITIAL)

  React.useEffect(() => {
    if (!path) return
    let cancelled = false
    setState(INITIAL)
    readContainerFile(appId, path)
      .then((res) => {
        if (cancelled) return
        if (res.is_binary) {
          setState({
            loading: false,
            error: null,
            text: null,
            size: res.total_size,
            truncated: res.truncated,
            isBinary: true,
          })
          return
        }
        const text = decodeFileContent(res.content_b64)
        setState({
          loading: false,
          error: text === null ? t("files.decodeFailed") : null,
          text,
          size: res.total_size,
          truncated: res.truncated,
          isBinary: false,
        })
      })
      .catch((err) => {
        if (cancelled) return
        const message =
          err instanceof Error ? err.message : t("files.readFailed")
        setState({
          loading: false,
          error: message,
          text: null,
          size: 0,
          truncated: false,
          isBinary: false,
        })
      })
    return () => {
      cancelled = true
    }
  }, [appId, path, t])

  const open = path !== null
  const basename = path?.split("/").filter(Boolean).pop() ?? ""

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="flex h-[85vh] max-h-[85vh] w-[95vw] max-w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:h-[60vh] sm:max-h-[60vh] sm:w-[50vw] sm:max-w-[50vw]">
        <DialogHeader className="border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-center gap-2">
            <RiFileLine
              size={16}
              className="shrink-0 text-muted-foreground"
              aria-hidden
            />
            <DialogTitle className="min-w-0 truncate text-sm font-medium">
              {basename}
            </DialogTitle>
            <div className="ml-auto flex items-center gap-2">
              {state.truncated && (
                <Badge variant="outline" className="text-[10px]">
                  {t("files.truncated")}
                </Badge>
              )}
              {state.isBinary && (
                <Badge variant="outline" className="text-[10px]">
                  {t("files.binary")}
                </Badge>
              )}
              {!state.loading && state.size > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  {formatBytes(state.size)}
                </span>
              )}
            </div>
          </div>
          <DialogDescription
            className="truncate text-[11px] text-muted-foreground"
            title={path ?? undefined}
          >
            {path ?? ""}
          </DialogDescription>
        </DialogHeader>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-auto bg-background">
          {state.loading && (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
              <RiLoader4Line size={14} className="mr-2 animate-spin" />
              {t("files.loading")}
            </div>
          )}

          {!state.loading && state.error && (
            <div className="flex items-start gap-2 p-4 text-xs text-red-400">
              <RiAlertLine size={14} className="mt-0.5 shrink-0" />
              <span>{state.error}</span>
            </div>
          )}

          {!state.loading && !state.error && state.isBinary && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <RiFileLine size={28} className="text-muted-foreground/60" />
              <div className="font-medium">{t("files.binary")}</div>
              <div className="text-[11px]">{formatBytes(state.size)}</div>
            </div>
          )}

          {!state.loading && !state.error && state.text !== null && (
            <pre className="m-0 min-h-full p-4 font-mono text-[12px] leading-relaxed whitespace-pre text-foreground">
              {state.text}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
