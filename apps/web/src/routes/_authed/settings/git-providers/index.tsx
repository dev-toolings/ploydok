// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  RiArrowRightSLine,
  RiCheckboxCircleFill,
  RiCircleLine,
  RiGithubFill,
  RiGitlabFill,
} from "@remixicon/react"
import { cn } from "@workspace/ui/lib/utils"
import { ShellPage } from "../../../../components/layout/AppShell"
import { useTranslation } from "react-i18next"
import { useGitProviderStatus } from "../../../../lib/git-providers"

export const Route = createFileRoute("/_authed/settings/git-providers/")({
  component: GitProvidersHub,
})

interface ProviderCardProps {
  slug: "github" | "gitlab"
  name: string
  status: "configured" | "not_configured" | "loading"
  description: string
  icon: React.ComponentType<{ className?: string }>
  accent: string
  note?: string
}

function GitProvidersHub(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const providerStatus = useGitProviderStatus()

  const providers: ReadonlyArray<ProviderCardProps> = [
    {
      slug: "github",
      name: t("github.title"),
      description: t("gitProviders.githubHint"),
      icon: RiGithubFill,
      accent: "text-foreground",
      status: providerStatus.isLoading
        ? "loading"
        : providerStatus.data?.github.connected
          ? "configured"
          : "not_configured",
      ...(providerStatus.data?.github.configured &&
      !providerStatus.data.github.connected
        ? { note: t("gitProviders.readyToConnect") }
        : {}),
    },
    {
      slug: "gitlab",
      name: t("gitlab.title"),
      description: t("gitProviders.gitlabHint"),
      icon: RiGitlabFill,
      accent: "text-[#fc6d26]",
      status: providerStatus.isLoading
        ? "loading"
        : providerStatus.data?.gitlab.connected
          ? "configured"
          : "not_configured",
      ...(providerStatus.data?.gitlab.state === "unavailable"
        ? { note: t("gitProviders.temporarilyUnavailable") }
        : providerStatus.data?.gitlab.state === "expired"
          ? { note: t("gitProviders.oauthExpired") }
          : {}),
    },
  ]

  return (
    <ShellPage
      title={t("gitProviders.title")}
      description={t("gitProviders.description")}
    >
      <div className="space-y-6">
        <section aria-label="Providers" className="grid gap-3 md:grid-cols-2">
          {providers.map((p) => (
            <ProviderCard key={p.slug} {...p} />
          ))}
        </section>
      </div>
    </ShellPage>
  )
}

function ProviderCard({
  slug,
  name,
  status,
  description,
  icon: Icon,
  accent,
  note,
}: ProviderCardProps): React.JSX.Element {
  const inner = (
    <>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Icon className={cn("size-5", accent)} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <p className="text-base font-medium">{name}</p>
            <StatusBadge status={status} />
          </div>
          {note ? (
            <p className="font-mono text-[10px] tracking-wide text-muted-foreground">
              {note}
            </p>
          ) : null}
        </div>
        <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </>
  )

  return (
    <Link
      to="/settings/git-providers/$slug"
      params={{ slug }}
      className="group flex flex-col gap-4 rounded-2xl rounded-xl bg-panel p-5 transition-colors hover:border-primary/40"
    >
      {inner}
    </Link>
  )
}

function StatusBadge({
  status,
}: {
  status: "configured" | "not_configured" | "loading"
}): React.JSX.Element {
  if (status === "loading") {
    return (
      <span className="font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
        …
      </span>
    )
  }
  if (status === "configured") {
    return (
      <span className="inline-flex items-center gap-1 font-sans text-[10px] tracking-wide text-emerald-600 uppercase dark:text-emerald-400">
        <RiCheckboxCircleFill className="size-3" />
        Configured
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
      <RiCircleLine className="size-3" />
      Not set
    </span>
  )
}
