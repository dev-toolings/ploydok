// SPDX-License-Identifier: AGPL-3.0-only
import { RiHardDrive3Line, RiStackLine } from "@remixicon/react"
import { cn } from "@workspace/ui/lib/utils"
import type { RemixiconComponentType } from "@remixicon/react"
import type { StorageProviderId } from "../../lib/storage-destinations"

const MARKS: Record<
  StorageProviderId,
  { sources: ReadonlyArray<string> } | { icon: RemixiconComponentType }
> = {
  aws: { sources: ["amazon-s3"] },
  "cloudflare-r2": { sources: ["cloudflare-r2"] },
  "azure-blob": { sources: ["azure-blob-storage"] },
  gcs: { sources: ["google-cloud-storage"] },
  "backblaze-b2": { sources: ["backblaze-b2"] },
  wasabi: { sources: ["wasabi"] },
  "digitalocean-spaces": { sources: ["digitalocean-spaces"] },
  hetzner: { sources: ["hetzner"] },
  scaleway: { sources: ["scaleway"] },
  ovhcloud: { sources: ["ovhcloud"] },
  minio: { sources: ["minio", "garage"] },
  "s3-compatible": { icon: RiStackLine },
  local: { icon: RiHardDrive3Line },
}

export function ProviderMark({
  provider,
  className,
}: {
  provider: StorageProviderId
  className?: string
}): React.JSX.Element {
  const mark = MARKS[provider]
  const Icon = "icon" in mark ? mark.icon : undefined
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center gap-0.5 rounded-lg border border-panel-border/70",
        "sources" in mark ? "bg-white" : "bg-panel-inset text-muted-foreground",
        className
      )}
    >
      {"sources" in mark &&
        mark.sources.map((source) => (
          <img
            key={source}
            src={`/icons/storage/${source}.svg`}
            alt=""
            width={20}
            height={20}
            className={cn(
              "shrink-0 object-contain",
              mark.sources.length > 1 ? "size-3.5" : "size-5"
            )}
          />
        ))}
      {Icon && <Icon className="size-5" />}
    </span>
  )
}
