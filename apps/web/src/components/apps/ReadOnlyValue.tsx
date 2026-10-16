// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Read-only stand-in for a settings field. It sits inside a panel Card, so it
 * uses the inset surface and the input border: the same box as the Input that
 * replaces it in edit mode, not a grey block on a grey panel.
 */
export function ReadOnlyValue({
  value,
  placeholder,
  mono = false,
}: {
  value: string
  placeholder: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "min-w-0 rounded-[10px] border border-input bg-panel-inset px-3 py-2 text-sm",
        mono && "font-mono",
        value ? "text-foreground" : "text-muted-foreground"
      )}
    >
      <span className="block truncate">{value || placeholder}</span>
    </div>
  )
}
