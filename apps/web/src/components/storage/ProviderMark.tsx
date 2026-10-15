// SPDX-License-Identifier: AGPL-3.0-only
import {
  RiAmazonLine,
  RiGoogleLine,
  RiHardDrive3Line,
  RiMicrosoftLine,
  RiServerLine,
  RiStackLine,
} from "@remixicon/react"
import { cn } from "@workspace/ui/lib/utils"
import type { RemixiconComponentType } from "@remixicon/react"
import type { StorageProviderId } from "../../lib/storage-destinations"

/** Brand glyph when Remix Icon has one, a short monogram otherwise. */
const MARKS: Record<
  StorageProviderId,
  { icon?: RemixiconComponentType; monogram?: string; tone: string }
> = {
  aws: { icon: RiAmazonLine, tone: "text-[#ff9900]" },
  "cloudflare-r2": { monogram: "R2", tone: "text-[#f38020]" },
  "azure-blob": { icon: RiMicrosoftLine, tone: "text-[#0078d4]" },
  gcs: { icon: RiGoogleLine, tone: "text-[#4285f4]" },
  "backblaze-b2": { monogram: "B2", tone: "text-[#e21e29]" },
  wasabi: { monogram: "W", tone: "text-[#3cb64b]" },
  "digitalocean-spaces": { monogram: "DO", tone: "text-[#0069ff]" },
  hetzner: { monogram: "H", tone: "text-[#d50c2d]" },
  scaleway: { monogram: "SW", tone: "text-[#4f0599] dark:text-[#a77ce0]" },
  ovhcloud: { monogram: "OVH", tone: "text-[#123f6d] dark:text-[#6fa8e6]" },
  minio: { icon: RiServerLine, tone: "text-[#c72e49]" },
  "s3-compatible": { icon: RiStackLine, tone: "text-muted-foreground" },
  local: { icon: RiHardDrive3Line, tone: "text-muted-foreground" },
}

export function ProviderMark({
  provider,
  className,
}: {
  provider: StorageProviderId
  className?: string
}): React.JSX.Element {
  const mark = MARKS[provider]
  const Icon = mark.icon
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-lg border border-panel-border/70 bg-panel-inset",
        mark.tone,
        className
      )}
    >
      {Icon ? (
        <Icon className="size-5" />
      ) : (
        <span className="text-xs font-semibold tracking-tight">
          {mark.monogram}
        </span>
      )}
    </span>
  )
}
