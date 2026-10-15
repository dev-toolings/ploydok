// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { cva } from "class-variance-authority"
import { Slot } from "radix-ui"
import { RiLoader4Line } from "@remixicon/react"

import { cn } from "@workspace/ui/lib/utils"
import type { VariantProps } from "class-variance-authority"

const buttonVariants = cva(
  "group/button inline-flex cursor-pointer shrink-0 items-center justify-center rounded-[10px] border bg-clip-padding text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,background-image] duration-150 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-[#3080ff]/20 focus-visible:ring-offset-2 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-[image:var(--gradient-primary)] text-white shadow-[0_1px_2px_0_#0000000d] hover:bg-[image:var(--gradient-primary-hover)] active:bg-[image:var(--gradient-primary-active)]",
        outline:
          "border-border bg-background text-foreground shadow-[0_1px_2px_0_#0000000d] hover:border-input hover:bg-muted aria-expanded:bg-muted dark:border-neutral-700 dark:bg-neutral-800 dark:hover:bg-neutral-700",
        secondary:
          "border-border bg-secondary text-secondary-foreground shadow-[0_1px_2px_0_#0000000d] hover:border-input hover:bg-secondary/80 dark:border-neutral-700",
        ghost:
          "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive:
          "border-transparent bg-destructive/10 text-destructive hover:bg-destructive/20",
        link: "h-auto border-transparent bg-transparent p-0 text-primary hover:underline",
      },
      size: {
        default: "h-9 gap-1.5 px-3",
        sm: "h-8 gap-1.5 px-2.5 text-sm",
        xs: "h-7 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 gap-2 px-4 text-sm",
        icon: "size-9",
        "icon-sm": "size-8",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  loading = false,
  disabled,
  children,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"
  // Slot.Root forwards to a single child, so injecting a spinner would break it.
  const showSpinner = loading && !asChild

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      disabled={asChild ? disabled : (disabled ?? false) || loading}
      className={cn(
        buttonVariants({ variant, size, className }),
        // The spinner replaces whatever icon the button carries, so call sites
        // never have to hide theirs by hand.
        showSpinner && "[&_svg:not([data-slot=button-spinner])]:hidden"
      )}
      {...props}
    >
      {showSpinner ? (
        <>
          <RiLoader4Line
            data-slot="button-spinner"
            className="animate-spin"
            aria-hidden="true"
          />
          {children}
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }
