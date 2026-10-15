// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, notFound } from "@tanstack/react-router"
import {
  RiCheckboxCircleFill,
  RiCircleLine,
  RiGithubFill,
  RiGitlabFill,
} from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import { ShellPage } from "../../../../components/layout/AppShell"
import { GitHubPanel } from "../../../../components/settings/providers/GitHubPanel"
import { GitLabPanel } from "../../../../components/settings/providers/GitLabPanel"
import { useGitProviderStatus } from "../../../../lib/git-providers"

type ProviderSlug = "github" | "gitlab"

function isSlug(v: string): v is ProviderSlug {
  return v === "github" || v === "gitlab"
}

export const Route = createFileRoute("/_authed/settings/git-providers/$slug")({
  head: createPageHead("gitProvider"),
  beforeLoad: ({ params }) => {
    if (!isSlug(params.slug)) {
      throw notFound()
    }
  },
  component: ProviderDashboard,
})

function ProviderDashboard(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { slug } = Route.useParams()
  const providers = {
    github: {
      title: t("github.title"),
      description: t("gitProviders.githubHint"),
      icon: RiGithubFill,
      accent: "text-foreground",
    },
    gitlab: {
      title: t("gitlab.title"),
      description: t("gitProviders.gitlabHint"),
      icon: RiGitlabFill,
      accent: "text-[#fc6d26]",
    },
  } as const
  const provider = providers[slug as ProviderSlug]
  const Icon = provider.icon

  return (
    <ShellPage title={provider.title} description={provider.description}>
      <div className="space-y-6">
        <section
          aria-label={t("gitProviders.header")}
          className="flex items-center gap-3 rounded-2xl bg-panel p-4"
        >
          <div className="flex size-10 items-center justify-center rounded-md border border-border bg-background">
            <Icon className={`size-5 ${provider.accent}`} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{provider.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {provider.description}
            </p>
          </div>
          <ProviderStatusBadge slug={slug as ProviderSlug} />
        </section>

        {slug === "github" ? <GitHubPanel /> : null}
        {slug === "gitlab" ? <GitLabPanel /> : null}
      </div>
    </ShellPage>
  )
}

function ProviderStatusBadge({
  slug,
}: {
  slug: ProviderSlug
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const providers = useGitProviderStatus()
  const status = providers.data?.[slug]

  if (providers.isLoading) {
    return (
      <span className="font-sans text-xs text-muted-foreground">
        …
      </span>
    )
  }
  if (slug === "gitlab" && providers.data?.gitlab.state === "unavailable") {
    return (
      <span className="inline-flex items-center gap-1 font-sans text-xs text-amber-600 dark:text-amber-400">
        <RiCircleLine className="size-3" />
        {t("gitlab.unavailableShort")}
      </span>
    )
  }
  return status?.connected ? (
    <span className="inline-flex items-center gap-1 font-sans text-xs text-emerald-600 dark:text-emerald-400">
      <RiCheckboxCircleFill className="size-3" />
      {t("gitlab.connected")}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 font-sans text-xs text-muted-foreground">
      <RiCircleLine className="size-3" />
      {status?.configured ? t("gitProviders.ready") : t("gitProviders.notSet")}
    </span>
  )
}
