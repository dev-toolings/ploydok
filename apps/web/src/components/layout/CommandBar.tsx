// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiSearchLine } from "@remixicon/react"
import { useCommandPaletteContext } from "../../lib/hooks/command-palette-context"

export function detectMac(): boolean {
  if (typeof navigator === "undefined") return false
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)
}

export function CommandBar(): React.JSX.Element {
  const { setOpen } = useCommandPaletteContext()
  const [isMac, setIsMac] = React.useState(false)

  React.useEffect(() => {
    setIsMac(detectMac())
  }, [])

  const handleClick = React.useCallback(() => {
    setOpen(true)
  }, [setOpen])

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group flex h-8 w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      aria-label="Open command palette"
    >
      <RiSearchLine className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1 text-left truncate">Search apps, commands…</span>
      <kbd
        aria-hidden="true"
        className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground"
      >
        <span>{isMac ? "⌘" : "Ctrl"}</span>
        <span>K</span>
      </kbd>
    </button>
  )
}
