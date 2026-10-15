// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  RiArrowRightSLine,
  RiShieldCheckLine,
  RiUserLine,
} from "@remixicon/react"
import { createPageHead } from "../../../lib/page-metadata"
import { ShellPage } from "../../../components/layout/AppShell"
import { SettingsTabs } from "../../../components/settings/SettingsTabs"
import { WorkspacesSection } from "../../../components/settings/WorkspacesSection"
import { AppearancePanel } from "../../../components/theme/AppearancePanel"
import { useMe } from "../../../lib/auth"

export const Route = createFileRoute("/_authed/settings/")({
  head: createPageHead("settings"),
  component: SettingsOverviewPage,
})

interface SectionCard {
  to: string
  eyebrow: string
  title: string
  description: string
  icon: React.ComponentType<{ className?: string }>
}

const SECTIONS: ReadonlyArray<SectionCard> = [
  {
    to: "/settings/security",
    eyebrow: "Account",
    title: "Security",
    description: "Passkeys, TOTP, sessions and backup codes.",
    icon: RiShieldCheckLine,
  },
]

function SettingsOverviewPage(): React.JSX.Element {
  const { data: me } = useMe()

  return (
    <ShellPage
      title="Settings"
      description="Manage your account, identities, and deployment sources."
      eyebrow="Account"
    >
      <div className="space-y-6">
        <SettingsTabs />

        <section
          aria-label="Account"
          className="rounded-2xl bg-panel p-5"
        >
          <div className="flex items-center gap-4">
            <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <RiUserLine className="size-5" />
            </div>
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-medium">
                {me?.display_name ?? "Utilisateur"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {me?.email}
              </p>
            </div>
          </div>

          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="font-sans text-xs text-muted-foreground">
                Passkeys
              </dt>
              <dd className="mt-0.5 font-medium">
                {me?.has_passkey_plus ? "2+ registered" : "Configure"}
              </dd>
            </div>
            <div>
              <dt className="font-sans text-xs text-muted-foreground">
                TOTP
              </dt>
              <dd className="mt-0.5 font-medium">
                {me?.has_totp ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div>
              <dt className="font-sans text-xs text-muted-foreground">
                Backup codes
              </dt>
              <dd className="mt-0.5 font-medium">
                {me?.has_backup_codes ? "Available" : "None"}
              </dd>
            </div>
          </dl>
        </section>

        <WorkspacesSection />

        <AppearancePanel />

        <section
          aria-label="Sections"
          className="grid gap-3 md:grid-cols-2 lg:grid-cols-3"
        >
          {SECTIONS.map((s) => (
            <SectionLink key={s.to} section={s} />
          ))}
        </section>
      </div>
    </ShellPage>
  )
}

function SectionLink({ section }: { section: SectionCard }): React.JSX.Element {
  const Icon = section.icon
  return (
    <Link
      to={section.to}
      className="group flex items-start gap-3 rounded-2xl bg-panel p-4 transition-colors"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <Icon className="size-5 text-muted-foreground group-hover:text-foreground" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-sans text-xs text-muted-foreground">
          {section.eyebrow}
        </p>
        <p className="text-sm font-medium">{section.title}</p>
        <p className="text-xs text-muted-foreground">{section.description}</p>
      </div>
      <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  )
}
