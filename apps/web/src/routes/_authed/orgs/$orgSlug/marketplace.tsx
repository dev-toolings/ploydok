// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import {
  RiAlertLine,
  RiExternalLinkLine,
  RiFileCopyLine,
  RiSearchLine,
  RiShapesLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/i18n/dialog"
import { ShellPage, ShellPanel } from "../../../../components/layout/AppShell"
import { useCurrentOrganization } from "../../../../lib/organizations"
import { useInstallService } from "../../../../lib/services"
import { useDebounce } from "../../../../lib/hooks/use-debounce"
import {
  useMarketplaceCatalog,
  useMarketplaceTemplateFiles,
} from "../../../../lib/marketplace"
import { InstallDialog } from "../../../../components/services/InstallDialog"
import type { MarketplaceTemplate } from "../../../../lib/marketplace"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/marketplace")({
  head: createPageHead("marketplace"),
  component: MarketplacePage,
})

function MarketplacePage(): React.JSX.Element {
  const { t } = useTranslation("services")
  const organization = useCurrentOrganization()
  const [query, setQuery] = React.useState("")
  const debouncedQuery = useDebounce(query.trim(), 250)
  const [activeId, setActiveId] = React.useState<string | null>(null)

  const {
    data,
    isLoading,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useMarketplaceCatalog(debouncedQuery)

  const templates = React.useMemo(
    () => data?.pages.flatMap((page) => page.templates) ?? [],
    [data]
  )
  const total = data?.pages[0]?.total ?? 0
  // Any page served from a degraded cache makes the whole list untrustworthy,
  // not just the page that happened to hit upstream while it was down.
  const stale = data?.pages.some((page) => page.stale) ?? false

  const sentinelRef = React.useRef<HTMLDivElement | null>(null)

  // `templates.length` is in the deps on purpose: once a page lands the
  // sentinel may still sit inside the viewport, and IntersectionObserver only
  // notifies on a *change* of intersection. Re-observing re-evaluates it and
  // chains to the next page instead of stalling.
  React.useEffect(() => {
    const node = sentinelRef.current
    if (!node || !hasNextPage || isFetchingNextPage) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void fetchNextPage()
      },
      { rootMargin: "400px" }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, templates.length])

  const activeTemplate = activeId
    ? (templates.find((tpl) => tpl.id === activeId) ?? null)
    : null

  return (
    <ShellPage
      title={t("marketplace.title")}
      description={t("marketplace.description")}
      eyebrow={organization?.name ?? "Workspace"}
    >
      <ShellPanel
        title={t("marketplace.templates")}
        description={t("marketplace.catalogHint")}
        action={
          <div className="relative w-64">
            <RiSearchLine className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("marketplace.search")}
              className="pl-9"
              aria-label={t("marketplace.searchTemplate")}
            />
          </div>
        }
      >
        {stale ? (
          <p className="mb-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <RiAlertLine className="size-4 shrink-0" />
            {t("marketplace.unreachable")}
          </p>
        ) : null}

        {isLoading ? (
          <CatalogSkeleton />
        ) : error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          >
            {t("marketplace.loadFailed", { message: error.message })}
          </p>
        ) : templates.length === 0 ? (
          <EmptyState query={debouncedQuery} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {templates.map((tpl) => (
                <TemplateCard
                  key={tpl.id}
                  template={tpl}
                  onOpen={() => setActiveId(tpl.id)}
                />
              ))}
            </div>
            <div
              ref={sentinelRef}
              className="flex flex-col items-center justify-center gap-2 py-6 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {isFetchingNextPage ? (
                <span className="flex items-center gap-2">
                  <span className="size-3 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
                  {t("marketplace.loadingCount", {
                    count: templates.length,
                    total,
                  })}
                </span>
              ) : hasNextPage ? (
                // Fallback when IntersectionObserver never fires (no JS scroll,
                // keyboard-only navigation, reduced-motion browsers).
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void fetchNextPage()}
                >
                  {t("marketplace.loadMore", {
                    count: templates.length,
                    total,
                  })}
                </Button>
              ) : (
                `${total} template${total > 1 ? "s" : ""}`
              )}
            </div>
          </>
        )}
      </ShellPanel>

      <TemplateDialog
        template={activeTemplate}
        onClose={() => setActiveId(null)}
      />
    </ShellPage>
  )
}

interface TemplateCardProps {
  template: MarketplaceTemplate
  onOpen: () => void
}

function TemplateCard({
  template,
  onOpen,
}: TemplateCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-full cursor-pointer flex-col gap-3 rounded-xl border border-panel-border bg-panel-inset p-4 text-left shadow-sm transition-colors outline-none hover:border-muted-foreground/30 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
          {template.logoUrl ? (
            <img
              src={template.logoUrl}
              alt=""
              className="size-10 object-contain"
              loading="lazy"
              onError={(event) => {
                event.currentTarget.style.display = "none"
              }}
            />
          ) : (
            <RiShapesLine className="size-5 text-muted-foreground" />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{template.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            v{template.version}
          </p>
        </div>
      </div>
      <p className="line-clamp-2 text-xs text-muted-foreground">
        {template.description}
      </p>
      {template.tags.length ? (
        <div className="mt-auto flex flex-wrap gap-1">
          {template.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  )
}

function CatalogSkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, idx) => (
        <div
          key={idx}
          className="flex h-32 flex-col gap-3 rounded-xl border border-panel-border bg-panel-inset p-4 shadow-sm"
        >
          <div className="flex items-center gap-3">
            <span className="size-10 shrink-0 skeleton-surface rounded-md" />
            <div className="flex-1 space-y-2">
              <span className="block h-3 w-24 skeleton-surface rounded" />
              <span className="block h-2 w-12 skeleton-surface rounded" />
            </div>
          </div>
          <span className="block h-2 w-full skeleton-surface rounded" />
          <span className="block h-2 w-3/4 skeleton-surface rounded" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ query }: { query: string }): React.JSX.Element {
  const { t } = useTranslation("services")
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-panel-border bg-panel-inset px-6 py-12 text-center">
      <RiShapesLine className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{t("marketplace.empty")}</p>
      <p className="text-xs text-muted-foreground">
        {query
          ? t("marketplace.noMatch", { query })
          : t("marketplace.emptyCatalog")}
      </p>
    </div>
  )
}

interface TemplateDialogProps {
  template: MarketplaceTemplate | null
  onClose: () => void
}

function TemplateDialog({
  template,
  onClose,
}: TemplateDialogProps): React.JSX.Element {
  const { t } = useTranslation("services")
  const router = useRouter()
  const organization = useCurrentOrganization()
  const { data, isLoading, error } = useMarketplaceTemplateFiles(
    template?.id ?? null
  )
  const [copied, setCopied] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const installService = useInstallService()

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const handleCopy = async (): Promise<void> => {
    if (!data?.dockerCompose) return
    try {
      await navigator.clipboard.writeText(data.dockerCompose)
      setCopied(true)
    } catch {
      // ignore clipboard failure
    }
  }

  const handleInstall = async (): Promise<void> => {
    if (!template || !data?.dockerCompose || !organization) return
    const result = await installService.mutateAsync({
      projectId: organization.id,
      templateId: template.id,
      templateVersion: template.version,
      name: template.name,
      compose: data.dockerCompose,
      templateToml: data.templateToml,
    })
    setConfirmOpen(false)
    onClose()
    await router.navigate({
      to: "/orgs/$orgSlug/services/$id",
      params: { orgSlug: organization.slug, id: result.service.id },
    })
  }

  return (
    <>
      <Dialog
        open={Boolean(template)}
        onOpenChange={(open) => (!open ? onClose() : null)}
      >
        <DialogContent className="sm:max-w-3xl">
          {template ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {template.name}
                  <span className="text-xs font-normal text-muted-foreground">
                    v{template.version}
                  </span>
                </DialogTitle>
                <DialogDescription>{template.description}</DialogDescription>
              </DialogHeader>

              <div className="flex flex-wrap gap-2 text-xs">
                {template.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-muted px-2 py-0.5 text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              <div className="flex min-h-[12rem] flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    docker-compose.yml
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleCopy()}
                    disabled={!data?.dockerCompose}
                  >
                    <RiFileCopyLine className="size-4" />
                    {copied ? t("marketplace.copied") : t("marketplace.copy")}
                  </Button>
                </div>
                {isLoading ? (
                  <div className="h-40 skeleton-surface rounded-md" />
                ) : error ? (
                  <p
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    {t("marketplace.filesFailed", { message: error.message })}
                  </p>
                ) : (
                  <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
                    <code>{data?.dockerCompose ?? ""}</code>
                  </pre>
                )}
              </div>

              <DialogFooter className="flex-wrap gap-2 sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  {template.links.github ? (
                    <a
                      href={template.links.github}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs hover:bg-accent"
                    >
                      <RiExternalLinkLine className="size-3.5" />
                      GitHub
                    </a>
                  ) : null}
                  {template.links.website ? (
                    <a
                      href={template.links.website}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs hover:bg-accent"
                    >
                      <RiExternalLinkLine className="size-3.5" />
                      Site
                    </a>
                  ) : null}
                  {template.links.docs ? (
                    <a
                      href={template.links.docs}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs hover:bg-accent"
                    >
                      <RiExternalLinkLine className="size-3.5" />
                      Docs
                    </a>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={onClose}>
                    {t("common:close")}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    loading={installService.isPending}
                    disabled={!data?.dockerCompose || !organization}
                  >
                    {installService.isPending
                      ? t("install.installing")
                      : t("install.submit")}
                  </Button>
                </div>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {template ? (
        <InstallDialog
          open={confirmOpen}
          templateName={template.name}
          templateVersion={template.version}
          isPending={installService.isPending}
          onConfirm={() => void handleInstall()}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
    </>
  )
}
