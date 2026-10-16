// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

/**
 * Native `<select>` with the same field surface as Input and SelectTrigger.
 * Use it where a short static list does not justify the Radix Select.
 */
function NativeSelect({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-9 w-full min-w-0 cursor-pointer rounded-[10px] border border-input bg-background px-2.5 text-sm text-foreground transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:disabled:bg-input/80",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
