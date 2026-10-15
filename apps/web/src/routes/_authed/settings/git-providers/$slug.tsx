// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, notFound } from "@tanstack/react-router"
import { RiCheckboxCircleFill, RiCircleLine } from "@remixicon/react"
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
    },
    gitlab: {
      title: t("gitlab.title"),
      description: t("gitProviders.gitlabHint"),
    },
  } as const
  const provider = providers[slug as ProviderSlug]

  // The page header already names the provider: its status sits beside it
  // instead of in a card repeating the title and description.
  return (
    <ShellPage
      title={provider.title}
      description={provider.description}
      actions={<ProviderStatusBadge slug={slug as ProviderSlug} />}
    >
      <div className="space-y-6">
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
}): React.JSX.Element | null {
  const { t } = useTranslation("settings")
  const providers = useGitProviderStatus()
  const status = providers.data?.[slug]

  if (providers.isLoading) return null
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
