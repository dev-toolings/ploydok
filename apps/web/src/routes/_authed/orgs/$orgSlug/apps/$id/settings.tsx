// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
  RiAddLine,
  RiDeleteBinLine,
  RiExternalLinkLine,
  RiGitBranchLine,
  RiGitCommitLine,
  RiGithubFill,
  RiGitlabFill,
  RiGlobalLine,
} from "@remixicon/react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"
import { createPageHead } from "../../../../../../lib/page-metadata"
import { ChannelList } from "../../../../../../components/notifications/ChannelList"
import { AppIcon } from "../../../../../../components/apps/AppIcon"
import { useApp } from "../../../../../../lib/apps"
import { useUpdateAppSettings } from "../../../../../../lib/apps-mutations"
import type { AppDetail } from "../../../../../../lib/apps"
import type { AppQuickLink } from "@ploydok/shared"

function AppSettingsGeneral(): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { id: routeAppId } = useParams({ strict: false })
  const appId = routeAppId!
  const { data: app, isLoading, error } = useApp(appId)

  if (isLoading) {
    return (
      <div className="w-full px-4 py-6 md:px-8 md:py-8">
        <SettingsSkeleton />
      </div>
    )
  }

  if (error || !app) {
    return (
      <div className="w-full px-4 py-6 md:px-8 md:py-8">
        <Alert variant="destructive">
          <AlertTitle>{t("settings.loadFailed")}</AlertTitle>
          <AlertDescription>
            {error?.message ?? t("settings.notFound")}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4 px-4 py-6 md:px-8 md:py-8">
      <SourceCard app={app} />

      <div className="grid gap-4 xl:grid-cols-2">
        <AppMetadataCard app={app} />
        <NotificationsCard appId={appId} />
      </div>
    </div>
  )
}

function NotificationsCard({ appId }: { appId: string }): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.notifications")}</CardTitle>
        <CardDescription>{t("settings.notificationsDesc")}</CardDescription>
      </CardHeader>

      <CardContent>
        <ChannelList appId={appId} showHeader={false} />
      </CardContent>
    </Card>
  )
}

function AppMetadataCard({ app }: { app: AppDetail }): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const updateMutation = useUpdateAppSettings(app.id)
  const [iconUrl, setIconUrl] = React.useState(app.iconUrl ?? "")
  const [quickLinks, setQuickLinks] = React.useState<Array<AppQuickLink>>(
    app.quickLinks ?? []
  )
  const [trackLatest, setTrackLatest] = React.useState(app.trackLatest ?? false)

  React.useEffect(() => {
    setIconUrl(app.iconUrl ?? "")
    setQuickLinks(app.quickLinks ?? [])
    setTrackLatest(app.trackLatest ?? false)
  }, [app.iconUrl, app.quickLinks, app.trackLatest])

  function addQuickLink() {
    setQuickLinks((prev) =>
      prev.length >= 8 ? prev : [...prev, { label: "", url: "" }]
    )
  }

  function updateQuickLink(index: number, updates: Partial<AppQuickLink>) {
    setQuickLinks((prev) =>
      prev.map((link, i) => (i === index ? { ...link, ...updates } : link))
    )
  }

  function removeQuickLink(index: number) {
    setQuickLinks((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSave() {
    const hasIncompleteLink = quickLinks.some(
      (link) => !link.label.trim() || !link.url.trim()
    )
    if (hasIncompleteLink) {
      toast.error(t("settings.incompleteLink"))
      return
    }
    const urls = [
      iconUrl.trim(),
      ...quickLinks.map((link) => link.url.trim()),
    ].filter(Boolean)
    if (urls.some((value) => !isSafeHttpUrl(value))) {
      toast.error(t("settings.unsafeUrl"))
      return
    }

    updateMutation.mutate({
      iconUrl: iconUrl.trim() || null,
      quickLinks: quickLinks.map((link) => ({
        label: link.label.trim(),
        url: link.url.trim(),
      })),
      ...(app.gitProvider === "image" ? { trackLatest } : {}),
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.iconLinks")}</CardTitle>
        <CardDescription>{t("settings.iconLinksDesc")}</CardDescription>
      </CardHeader>

      <CardContent className="max-w-2xl space-y-6">
        <div className="space-y-2">
          <Label htmlFor="app-icon-url">{t("settings.iconUrl")}</Label>
          <div className="flex items-center gap-3">
            <Input
              id="app-icon-url"
              type="url"
              value={iconUrl}
              onChange={(e) => setIconUrl(e.target.value)}
              placeholder="https://example.com/icon.png"
              className="min-w-0 flex-1"
            />
            <AppIcon
              name={app.name}
              src={iconUrl || null}
              className="size-8"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Label>{t("settings.quickLinks")}</Label>
            <span className="text-xs text-muted-foreground">
              {quickLinks.length}/8
            </span>
          </div>

          {quickLinks.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.noShortcuts")}
            </p>
          ) : (
            <div className="space-y-2">
              {quickLinks.map((link, idx) => (
                <div
                  key={idx}
                  className="flex flex-col gap-2 sm:flex-row sm:items-center"
                >
                  <Input
                    value={link.label}
                    onChange={(e) =>
                      updateQuickLink(idx, { label: e.target.value })
                    }
                    placeholder={t("settings.label")}
                    maxLength={40}
                    className="sm:w-40"
                    aria-label={t("settings.quickLinkLabel")}
                  />
                  <Input
                    type="url"
                    value={link.url}
                    onChange={(e) =>
                      updateQuickLink(idx, { url: e.target.value })
                    }
                    placeholder="https://example.com"
                    className="min-w-0 flex-1"
                    aria-label={t("settings.quickLinkUrl")}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeQuickLink(idx)}
                    aria-label={t("settings.removeQuickLink", {
                      label: link.label || t("settings.quickLinkFallback"),
                    })}
                    className="shrink-0 self-end sm:self-auto"
                  >
                    <RiDeleteBinLine className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addQuickLink}
            disabled={quickLinks.length >= 8}
            className="gap-1.5"
          >
            <RiAddLine className="size-3.5" aria-hidden="true" />
            {t("settings.addQuickLink")}
          </Button>
        </div>

        {app.gitProvider === "image" ? (
          <div className="flex items-center justify-between gap-4 rounded-lg bg-panel-inset p-3 shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]">
            <div className="space-y-1">
              <Label htmlFor="track-latest">{t("settings.trackLatest")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("settings.trackLatestDesc")}
              </p>
            </div>
            <Switch
              id="track-latest"
              checked={trackLatest}
              onCheckedChange={setTrackLatest}
              aria-label={t("settings.trackLatest")}
            />
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="justify-end">
        <Button onClick={handleSave} loading={updateMutation.isPending}>
          {updateMutation.isPending
            ? t("common:saving")
            : t("settings.saveChanges")}
        </Button>
      </CardFooter>
    </Card>
  )
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function SourceCard({ app }: { app: AppDetail }): React.JSX.Element {
  const { t } = useTranslation("apps")
  const repoHref = buildRepoHref(app.gitProvider, app.repoFullName)
  const commitShort = app.currentCommitSha
    ? app.currentCommitSha.slice(0, 7)
    : null
  const commitHref =
    repoHref && app.currentCommitSha
      ? `${repoHref}/commit/${app.currentCommitSha}`
      : undefined
  const branchHref =
    repoHref && app.branch ? `${repoHref}/tree/${app.branch}` : undefined
  const ProviderIcon =
    app.gitProvider === "gitlab" ? RiGitlabFill : RiGithubFill

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.sourceDomain")}</CardTitle>
        <CardDescription>{t("settings.sourceDomainDesc")}</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoTile
          label={t("settings.repository")}
          value={app.repoFullName ?? "—"}
          href={repoHref}
          icon={<ProviderIcon className="size-3.5" aria-hidden="true" />}
        />
        <InfoTile
          label={t("create.branch")}
          value={app.branch ?? "main"}
          href={branchHref}
          mono
          icon={<RiGitBranchLine className="size-3.5" aria-hidden="true" />}
        />
        <InfoTile
          label={t("settings.currentCommit")}
          value={commitShort ?? "—"}
          title={app.currentCommitSha ?? undefined}
          href={commitHref}
          mono
          icon={<RiGitCommitLine className="size-3.5" aria-hidden="true" />}
        />
        <InfoTile
          label={t("settings.domain")}
          value={app.domain ?? t("settings.notSet")}
          href={app.publicUrl ?? undefined}
          muted={!app.domain}
          icon={<RiGlobalLine className="size-3.5" aria-hidden="true" />}
        />
      </CardContent>
    </Card>
  )
}

function buildRepoHref(
  provider: string | undefined,
  repoFullName: string | undefined
): string | undefined {
  if (!repoFullName) return undefined
  if (provider === "gitlab") return `https://gitlab.com/${repoFullName}`
  return `https://github.com/${repoFullName}`
}

function InfoTile({
  label,
  value,
  href,
  title,
  mono,
  muted,
  icon,
}: {
  label: string
  value: string
  href?: string
  title?: string
  mono?: boolean
  muted?: boolean
  icon?: React.ReactNode
}): React.JSX.Element {
  const valueClass = cn(
    "min-w-0 truncate text-sm",
    mono ? "font-mono" : "font-medium",
    muted ? "text-muted-foreground" : "text-foreground"
  )

  return (
    <div className="min-w-0 rounded-lg bg-panel-inset px-3 py-2.5 shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </p>
      <div className="mt-1.5 min-w-0">
        {href ? (
          <a
            className={cn(
              valueClass,
              "inline-flex max-w-full items-center gap-1.5 hover:underline"
            )}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={title ?? value}
          >
            <span className="truncate">{value}</span>
            <RiExternalLinkLine
              className="size-3 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </a>
        ) : (
          <p className={valueClass} title={title ?? value}>
            {value}
          </p>
        )}
      </div>
    </div>
  )
}

function SettingsSkeleton(): React.JSX.Element {
  return (
    <div className="w-full space-y-4">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-md" />
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, index) => (
          <Card key={index}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-72" />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authed/orgs/$orgSlug/apps/$id/settings"
)({
  head: createPageHead("applicationSettings"),
  component: AppSettingsGeneral,
})
