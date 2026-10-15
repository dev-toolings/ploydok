// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {  cva } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@workspace/ui/lib/utils"
import type {VariantProps} from "class-variance-authority";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-[#ebebeb] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400 [a]:hover:bg-[#ebebeb]/80",
        destructive:
          "bg-neg-100 text-neg-700 focus-visible:ring-destructive/20 dark:bg-[#4d0218]/60 dark:text-[#ff637e] dark:focus-visible:ring-destructive/40 [a]:hover:bg-neg-100/80",
        success:
          "bg-pos-100 text-pos-700 dark:bg-[#192e03]/60 dark:text-[#9ae600] [a]:hover:bg-pos-100/80",
        warning:
          "bg-warn-100 text-warn-700 dark:bg-[#432004]/60 dark:text-[#fdc700] [a]:hover:bg-warn-100/80",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
