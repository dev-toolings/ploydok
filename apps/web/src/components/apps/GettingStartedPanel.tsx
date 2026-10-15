// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { RiArrowRightUpLine } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { ShellPanel } from "../layout/AppShell"

export function GettingStartedPanel({
  githubConnected,
  onCreateApp,
}: {
  githubConnected: boolean
  onCreateApp: () => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <ShellPanel
      title={t("gettingStarted.title")}
      description={t("gettingStarted.description")}
    >
      <div className="space-y-2">
        <MiniStep
          label={t("gettingStarted.connectGithub")}
          body={
            githubConnected
              ? t("gettingStarted.githubConnected")
              : t("gettingStarted.githubInstall")
          }
          to="/settings/git-providers/$slug"
          params={{ slug: "github" }}
        />
        <MiniButton
          label={t("gettingStarted.createApp")}
          body={t("gettingStarted.createBody")}
          onClick={onCreateApp}
        />
        <MiniStep
          label={t("gettingStarted.reviewGuide")}
          body={t("gettingStarted.guideBody")}
          to="/guide"
        />
      </div>
    </ShellPanel>
  )
}

const miniItemClass =
  "group flex min-h-12 w-full items-center justify-between gap-3 rounded-[10px] bg-panel-inset px-4 py-3 text-left transition-colors outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]"

function MiniItemContent({
  label,
  body,
}: {
  label: string
  body: string
}): React.JSX.Element {
  return (
    <>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {label}
        </span>
        <span className="block text-xs leading-5 text-muted-foreground">
          {body}
        </span>
      </span>
      <RiArrowRightUpLine className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
    </>
  )
}

export function MiniStep({
  label,
  body,
  to,
  params,
}: {
  label: string
  body: string
  to: string
  params?: Record<string, string>
}): React.JSX.Element {
  const linkProps = { to, ...(params ? { params } : {}) } as Parameters<
    typeof Link
  >[0]
  return (
    <Link {...linkProps} className={miniItemClass}>
      <MiniItemContent label={label} body={body} />
    </Link>
  )
}

export function MiniButton({
  label,
  body,
  onClick,
}: {
  label: string
  body: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className={miniItemClass}>
      <MiniItemContent label={label} body={body} />
    </button>
  )
}
