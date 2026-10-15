// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  RiCloseLine,
  RiCloudLine,
  RiExternalLinkLine,
  RiFlashlightLine,
  RiQuestionLine,
  RiSave3Line,
} from "@remixicon/react"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import i18n from "../../lib/i18n"
import {
  useAppCdn,
  useAppCloudflareCdn,
  usePurgeAppCloudflareCdn,
  useUpdateAppCdn,
  useUpdateAppCloudflareCdn,
} from "../../lib/apps"
import type { CdnConfig, CdnMode } from "@ploydok/shared"

const DEFAULT_CDN_CONFIG: CdnConfig = {
  mode: "off",
  cache_ttl_s: 300,
  cache_paths: [],
  compression: false,
  image_optim: false,
  headers: {},
  external_provider: null,
}

const CLOUDFLARE_GUIDE_IMAGES = {
  customize: "/guides/cloudflare/api-token-customize.webp",
  summary: "/guides/cloudflare/api-token-summary.webp",
  complete: "/guides/cloudflare/api-token-complete.webp",
} as const

type GuideImagePreview = {
  src: string
  alt: string
  caption: string
}

function pathsToText(paths: Array<string>): string {
  return paths.join("\n")
}

function parsePaths(value: string): Array<string> {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function headersToText(headers: Record<string, string>): string {
  return Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : ""
}

function parseHeaders(value: string): Record<string, string> {
  if (!value.trim()) return {}
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(i18n.t("apps:cdn.headersMustBeObject"))
  }

  const headers: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") {
      throw new Error(i18n.t("apps:cdn.headerMustBeString", { key }))
    }
    headers[key] = headerValue
  }
  return headers
}

export function CdnSection({ appId }: { appId: string }): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const { data, isLoading, error } = useAppCdn(appId)
  const { data: cloudflare } = useAppCloudflareCdn(appId)
  const update = useUpdateAppCdn()
  const updateCloudflare = useUpdateAppCloudflareCdn()
  const purgeCloudflare = usePurgeAppCloudflareCdn(appId)
  const config = data ?? DEFAULT_CDN_CONFIG
  const [mode, setMode] = React.useState<CdnMode>(config.mode)
  const [ttl, setTtl] = React.useState(String(config.cache_ttl_s))
  const [pathsText, setPathsText] = React.useState(
    pathsToText(config.cache_paths)
  )
  const [compression, setCompression] = React.useState(config.compression)
  const [imageOptim, setImageOptim] = React.useState(config.image_optim)
  const [headersText, setHeadersText] = React.useState(
    headersToText(config.headers)
  )
  const [cloudflareToken, setCloudflareToken] = React.useState("")
  const [cloudflareZoneId, setCloudflareZoneId] = React.useState("")
  const [cloudflareZoneName, setCloudflareZoneName] = React.useState("")
  const [cloudflareHostname, setCloudflareHostname] = React.useState("")
  const [cloudflareOrigin, setCloudflareOrigin] = React.useState("")
  const [formError, setFormError] = React.useState<string | null>(null)
  const [guideOpen, setGuideOpen] = React.useState(false)

  React.useEffect(() => {
    if (!data) return
    setMode(data.mode)
    setTtl(String(data.cache_ttl_s))
    setPathsText(pathsToText(data.cache_paths))
    setCompression(data.compression)
    setImageOptim(data.image_optim)
    setHeadersText(headersToText(data.headers))
    setFormError(null)
  }, [data])

  React.useEffect(() => {
    if (!cloudflare) return
    setCloudflareZoneId(cloudflare.zone_id ?? "")
    setCloudflareZoneName(cloudflare.zone_name ?? "")
    setCloudflareHostname(cloudflare.hostname ?? "")
    setCloudflareOrigin(cloudflare.origin ?? "")
  }, [cloudflare])

  const statusLabel =
    mode === "internal"
      ? t("cdn.statusInternal")
      : mode === "external"
        ? t("cdn.statusExternal")
        : t("cdn.off")

  const handleSave = async (): Promise<void> => {
    setFormError(null)
    const ttlSeconds = Number.parseInt(ttl, 10)
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 0 || ttlSeconds > 86400) {
      setFormError(t("cdn.ttlRange"))
      return
    }

    const cachePaths = parsePaths(pathsText)
    const invalidPath = cachePaths.find((path) => !path.startsWith("/"))
    if (invalidPath) {
      setFormError(t("cdn.cachePathMustStart", { path: invalidPath }))
      return
    }

    let headers: Record<string, string>
    try {
      headers = parseHeaders(headersText)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("cdn.invalidHeaders"))
      return
    }

    if (mode === "external") {
      if (!cloudflareZoneId.trim()) {
        setFormError(t("cdn.zoneIdRequired"))
        return
      }
      if (!cloudflareHostname.trim()) {
        setFormError(t("cdn.hostnameRequired"))
        return
      }
      if (!cloudflareOrigin.trim()) {
        setFormError(t("cdn.originRequired"))
        return
      }
      if (!cloudflare?.configured && !cloudflareToken.trim()) {
        setFormError(t("cdn.tokenRequiredFirst"))
        return
      }

      await updateCloudflare.mutateAsync({
        appId,
        config: {
          ...(cloudflareToken.trim()
            ? { api_token: cloudflareToken.trim() }
            : {}),
          zone_id: cloudflareZoneId.trim(),
          zone_name: cloudflareZoneName.trim() || null,
          hostname: cloudflareHostname.trim(),
          origin: cloudflareOrigin.trim(),
          cache_ttl_s: ttlSeconds,
          cache_paths: cachePaths,
          headers,
        },
      })
      setCloudflareToken("")
      return
    }

    await update.mutateAsync({
      appId,
      config: {
        mode,
        cache_ttl_s: ttlSeconds,
        cache_paths: cachePaths,
        compression,
        image_optim: imageOptim,
        headers,
        external_provider: null,
      },
    })
  }

  if (isLoading) {
    return <Skeleton className="h-96 rounded-lg" />
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <>
      <Card data-app-id={appId} aria-label={t("cdn.title")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RiCloudLine className="size-4" aria-hidden="true" />
            {t("cdn.cachingTitle")}
          </CardTitle>
          <CardDescription>{t("cdn.description")}</CardDescription>
          <CardAction className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setGuideOpen(true)}
            >
              <RiQuestionLine className="size-4" aria-hidden="true" />
              {t("cdn.guide")}
            </Button>
            <Badge variant={mode === "off" ? "outline" : "secondary"}>
              {statusLabel}
            </Badge>
          </CardAction>
        </CardHeader>

        <CardContent className="space-y-5">
          {data?.warning ? (
            <Alert>
              <AlertDescription>{data.warning}</AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-4 md:grid-cols-[220px_1fr]">
            <div className="space-y-2">
              <Label>{t("cdn.mode")}</Label>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as CdnMode)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t("cdn.off")}</SelectItem>
                  <SelectItem value="internal">{t("cdn.internal")}</SelectItem>
                  <SelectItem value="external">{t("cdn.external")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === "external" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>{t("cdn.provider")}</Label>
                  <Input value={t("cdn.cloudflareManaged")} disabled readOnly />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cloudflare-status">{t("cdn.syncStatus")}</Label>
                  <Input
                    id="cloudflare-status"
                    value={cloudflare?.status ?? t("cdn.notConfigured")}
                    disabled
                    readOnly
                  />
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                <Metric
                  icon={<RiFlashlightLine className="size-4" />}
                  label={t("cdn.cache")}
                  value={mode === "internal" ? t("cdn.caddy") : t("cdn.disabled")}
                />
                <Metric
                  icon={<RiSave3Line className="size-4" />}
                  label={t("cdn.compression")}
                  value={compression ? t("common:on") : t("common:off")}
                />
                <Metric
                  icon={<RiExternalLinkLine className="size-4" />}
                  label={t("cdn.imageVariants")}
                  value={imageOptim ? t("common:on") : t("common:off")}
                />
              </div>
            )}
          </div>

          {mode === "external" ? (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="cloudflare-token">{t("cdn.apiToken")}</Label>
                <Input
                  id="cloudflare-token"
                  type="password"
                  value={cloudflareToken}
                  placeholder={
                    cloudflare?.configured
                      ? t("cdn.keepToken")
                      : t("cdn.tokenRequired")
                  }
                  onChange={(event) => setCloudflareToken(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cloudflare-zone-id">{t("cdn.zoneId")}</Label>
                <Input
                  id="cloudflare-zone-id"
                  value={cloudflareZoneId}
                  className="font-mono"
                  onChange={(event) => setCloudflareZoneId(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cloudflare-zone-name">{t("cdn.zoneName")}</Label>
                <Input
                  id="cloudflare-zone-name"
                  value={cloudflareZoneName}
                  placeholder="example.com"
                  onChange={(event) =>
                    setCloudflareZoneName(event.target.value)
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cloudflare-hostname">{t("cdn.proxiedHostname")}</Label>
                <Input
                  id="cloudflare-hostname"
                  value={cloudflareHostname}
                  placeholder="app.example.com"
                  onChange={(event) =>
                    setCloudflareHostname(event.target.value)
                  }
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="cloudflare-origin">{t("cdn.originTarget")}</Label>
                <Input
                  id="cloudflare-origin"
                  value={cloudflareOrigin}
                  placeholder={t("cdn.originPlaceholder")}
                  onChange={(event) => setCloudflareOrigin(event.target.value)}
                />
              </div>
              {cloudflare?.last_sync_error ? (
                <p className="text-sm text-destructive md:col-span-2">
                  {cloudflare.last_sync_error}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="cdn-ttl">{t("cdn.ttl")}</Label>
              <Input
                id="cdn-ttl"
                type="number"
                min={0}
                max={86400}
                value={ttl}
                disabled={mode !== "internal"}
                onChange={(event) => setTtl(event.target.value)}
              />
            </div>

            <ToggleRow
              id="cdn-compression"
              title={t("cdn.compression")}
              description={t("cdn.compressionDesc")}
              checked={compression}
              disabled={mode !== "internal"}
              onCheckedChange={setCompression}
            />

            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="cdn-paths">{t("cdn.cachePaths")}</Label>
              <Textarea
                id="cdn-paths"
                value={pathsText}
                disabled={mode !== "internal"}
                placeholder={"/assets/*\n/images/*"}
                className="min-h-24 font-mono text-sm"
                onChange={(event) => setPathsText(event.target.value)}
              />
            </div>

            <ToggleRow
              id="cdn-image-optim"
              title={t("cdn.imageOptim")}
              description={t("cdn.imageOptimDesc")}
              checked={imageOptim}
              disabled={mode !== "internal"}
              onCheckedChange={setImageOptim}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cdn-headers">{t("cdn.headersJson")}</Label>
            <Textarea
              id="cdn-headers"
              value={headersText}
              placeholder={`{\n  "Cache-Control": "public, max-age=300",\n  "X-Content-Type-Options": "nosniff"\n}`}
              className="min-h-32 font-mono text-sm"
              onChange={(event) => setHeadersText(event.target.value)}
            />
          </div>

          {formError ? (
            <p className="text-sm text-destructive">{formError}</p>
          ) : null}
        </CardContent>

        <CardFooter className="justify-end">
          {mode === "external" && cloudflare?.configured ? (
            <Button
              variant="outline"
              onClick={() => purgeCloudflare.mutate()}
              loading={purgeCloudflare.isPending}
            >
              {purgeCloudflare.isPending ? t("cdn.purging") : t("cdn.purgeCloudflare")}
            </Button>
          ) : null}
          <Button
            onClick={() => void handleSave()}
            loading={update.isPending || updateCloudflare.isPending}
          >
            {update.isPending || updateCloudflare.isPending
              ? t("cdn.saving")
              : t("cdn.saveCdn")}
          </Button>
        </CardFooter>
      </Card>
      <CloudflareGuideAside open={guideOpen} onOpenChange={setGuideOpen} />
    </>
  )
}

function CloudflareGuideAside({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [preview, setPreview] = React.useState<GuideImagePreview | null>(null)

  React.useEffect(() => {
    if (!open) setPreview(null)
  }, [open])

  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      if (preview) {
        setPreview(null)
        return
      }
      onOpenChange(false)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onOpenChange, open, preview])

  return (
    <>
      <button
        type="button"
        aria-label="Close Cloudflare guide"
        className={
          open
            ? "fixed inset-0 z-40 bg-background/30 md:bg-transparent"
            : "pointer-events-none fixed inset-0 z-40 hidden"
        }
        onClick={() => onOpenChange(false)}
      />
      <aside
        aria-label="Cloudflare API token guide"
        aria-hidden={!open}
        className={[
          "fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col border-l border-border bg-background shadow-2xl transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <RiCloudLine className="size-4 text-muted-foreground" />
              <p className="text-sm font-semibold">Cloudflare managed CDN</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Create a scoped API token, copy the Zone ID, then let Ploydok
              create the proxied DNS record and cache rule.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onOpenChange(false)}
          >
            <RiCloseLine className="size-4" aria-hidden="true" />
            <span className="sr-only">Close guide</span>
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-5">
            <GuideStep
              number="1"
              title="Open API tokens"
              copy="In Cloudflare, open My Profile, then API Tokens. Use a custom token so permissions stay scoped to one zone."
            >
              <GuideImage
                src={CLOUDFLARE_GUIDE_IMAGES.customize}
                alt="Cloudflare profile page with API Tokens selected"
                caption="Profile sidebar: open API Tokens before creating the custom token."
                imageClassName="h-48 object-cover object-left-top"
                onPreview={setPreview}
              />
            </GuideStep>

            <GuideStep
              number="2"
              title="Create a custom token"
              copy="Choose Custom token. Avoid the global API key: Ploydok only needs DNS, cache rules, and purge permissions."
            >
              <GuideImage
                src={CLOUDFLARE_GUIDE_IMAGES.customize}
                alt="Cloudflare custom API token permission form"
                caption="Cloudflare custom token screen: token name, permissions, and zone resources."
                onPreview={setPreview}
              />
            </GuideStep>

            <GuideStep
              number="3"
              title="Grant the minimum permissions"
              copy="Cloudflare permission names can vary by account, but this is the target shape for DNS + Cache Rules + purge."
            >
              <div className="space-y-3">
                <GuideImage
                  src={CLOUDFLARE_GUIDE_IMAGES.customize}
                  alt="Cloudflare API token permissions fields"
                  caption="Permissions area: add one row for each Cloudflare permission Ploydok needs."
                  imageClassName="h-56 object-cover object-[52%_44%]"
                  onPreview={setPreview}
                />
                <div className="space-y-2">
                  <PermissionLine scope="Zone" name="DNS" level="Edit" />
                  <PermissionLine
                    scope="Zone"
                    name="Cache Purge"
                    level="Purge"
                  />
                  <PermissionLine
                    scope="Zone"
                    name="Cache Rules"
                    level="Edit"
                  />
                  <PermissionLine
                    scope="Account"
                    name="Rulesets"
                    level="Edit"
                  />
                  <PermissionLine
                    scope="Account"
                    name="Filter Lists"
                    level="Edit"
                  />
                </div>
              </div>
            </GuideStep>

            <GuideStep
              number="4"
              title="Review token summary"
              copy="Before creation, verify that the permissions and zone resources are scoped to the domain that owns your app hostname."
            >
              <GuideImage
                src={CLOUDFLARE_GUIDE_IMAGES.summary}
                alt="Cloudflare API token summary before creation"
                caption="Cloudflare summary screen: confirm the scoped token before creating it."
                onPreview={setPreview}
              />
            </GuideStep>

            <GuideStep
              number="5"
              title="Copy token and Zone ID"
              copy="Paste the token once in Ploydok. For Zone ID, open the zone Overview page in Cloudflare and copy the Zone ID from the API panel."
            >
              <GuideImage
                src={CLOUDFLARE_GUIDE_IMAGES.complete}
                alt="Cloudflare generated API token screen"
                caption="Cloudflare only shows the generated token once. Copy it before closing this screen."
                onPreview={setPreview}
              />
            </GuideStep>

            <GuideStep
              number="6"
              title="Fill Ploydok Cloudflare fields"
              copy="Hostname is the public app domain. Origin is where Cloudflare should point the proxied DNS record: your Ploydok origin hostname or server IP."
            >
              <ScreenshotFrame title="Ploydok CDN fields">
                <div className="space-y-2">
                  <MockRow label="Hostname" value="app.example.com" />
                  <MockRow label="Origin" value="origin.example.com" />
                  <MockRow label="Cache paths" value="/assets/*" />
                </div>
              </ScreenshotFrame>
            </GuideStep>
          </div>
        </div>

        <div className="border-t border-border px-5 py-4">
          <div className="flex flex-wrap gap-2">
            <a
              href="https://dash.cloudflare.com/profile/api-tokens"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
            >
              Open Cloudflare API tokens
              <RiExternalLinkLine className="size-4" aria-hidden="true" />
            </a>
            <a
              href="https://developers.cloudflare.com/fundamentals/api/get-started/create-token/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
            >
              Cloudflare docs
              <RiExternalLinkLine className="size-4" aria-hidden="true" />
            </a>
          </div>
        </div>
      </aside>

      {preview ? (
        <GuideImageLightbox image={preview} onClose={() => setPreview(null)} />
      ) : null}
    </>
  )
}

function GuideStep({
  number,
  title,
  copy,
  children,
}: {
  number: string
  title: string
  copy: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="grid gap-3">
      <div className="flex gap-3">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
          {number}
        </div>
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{copy}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

function GuideImage({
  src,
  alt,
  caption,
  imageClassName,
  onPreview,
}: {
  src: string
  alt: string
  caption: string
  imageClassName?: string
  onPreview: (image: GuideImagePreview) => void
}): React.JSX.Element {
  return (
    <figure className="overflow-hidden rounded-lg border border-border bg-muted/30">
      <button
        type="button"
        className="group relative block w-full cursor-zoom-in bg-background text-left"
        onClick={() => onPreview({ src, alt, caption })}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={[
            "block w-full bg-background object-contain",
            imageClassName ?? "",
          ].join(" ")}
        />
        <span className="absolute right-2 bottom-2 rounded-md border border-border bg-background/95 px-2 py-1 text-[11px] font-medium text-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          View larger
        </span>
      </button>
      <figcaption className="border-t border-border px-3 py-2 text-[11px] leading-4 text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  )
}

function GuideImageLightbox({
  image,
  onClose,
}: {
  image: GuideImagePreview
  onClose: () => void
}): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-[70] bg-background/95 px-4 py-4 backdrop-blur-sm md:px-8 md:py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Cloudflare guide image preview"
      onClick={onClose}
    >
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-3">
        <div
          className="flex items-center justify-between gap-3"
          onClick={(event) => event.stopPropagation()}
        >
          <p className="min-w-0 truncate text-sm font-medium">
            {image.caption}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <a
              href={image.src}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
            >
              Open file
              <RiExternalLinkLine className="size-4" aria-hidden="true" />
            </a>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              onClick={onClose}
            >
              <RiCloseLine className="size-4" aria-hidden="true" />
              <span className="sr-only">Close image preview</span>
            </Button>
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-background p-2"
          onClick={(event) => event.stopPropagation()}
        >
          <img
            src={image.src}
            alt={image.alt}
            className="mx-auto block max-h-[calc(100vh-8rem)] w-auto max-w-full object-contain"
          />
        </div>
      </div>
    </div>
  )
}

function ScreenshotFrame({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
      <div className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2">
        <span className="size-2 rounded-full bg-destructive/70" />
        <span className="size-2 rounded-full bg-yellow-500/70" />
        <span className="size-2 rounded-full bg-emerald-500/70" />
        <span className="ml-2 truncate font-mono text-[11px] text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

function MockRow({
  label,
  value,
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="truncate font-mono text-[11px]">{value}</span>
    </div>
  )
}

function PermissionLine({
  scope,
  name,
  level,
}: {
  scope: string
  name: string
  level: string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[64px_1fr_64px] items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-[11px]">
      <span className="text-muted-foreground">{scope}</span>
      <span className="font-medium">{name}</span>
      <span className="rounded bg-muted px-2 py-0.5 text-center text-muted-foreground">
        {level}
      </span>
    </div>
  )
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="mb-2 flex size-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
        {icon}
      </div>
      <p className="text-xs font-medium">{label}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{value}</p>
    </div>
  )
}

function ToggleRow({
  id,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-20 items-center justify-between gap-4 rounded-lg border border-border px-3 py-2">
      <div className="space-y-1">
        <Label htmlFor={id}>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}
