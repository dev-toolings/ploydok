// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useMatches, useRouter } from "@tanstack/react-router"
import {
  RiApps2Line,
  RiArchiveLine,
  RiCodeBoxLine,
  RiDashboardLine,
  RiDatabase2Line,
  RiFileListLine,
  RiHardDriveLine,
  RiNotificationLine,
  RiPlugLine,
  RiPulseLine,
  RiRocketLine,
  RiSettings3Line,
  RiShapesLine,
  RiShieldCheckLine,
  RiStopCircleLine,
  RiTeamLine,
  RiTerminalBoxLine,
} from "@remixicon/react"
import { useTranslation } from "react-i18next"
import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandKbd,
  CommandList,
  CommandMeta,
} from "@workspace/ui/components/command"
import { useApps } from "../../lib/apps"
import { useMe } from "../../lib/auth"
import { useDeployApp, useStopApp } from "../../lib/apps-mutations"
import { useCommandPaletteContext } from "../../lib/hooks/command-palette-context"
import {
  organizationPath,
  useCurrentOrganization,
  useCurrentOrganizationSlug,
} from "../../lib/organizations"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NavSection = "Navigation" | "Integrations" | "Account" | "Instance"

const PALETTE_NAV_KEYS = {
  "nav-dashboard": "dashboard",
  "nav-apps": "applications",
  "nav-databases": "databases",
  "nav-services": "services",
  "nav-deployments": "deployments",
  "nav-marketplace": "marketplace",
  "nav-monitoring": "monitoring",
  "nav-members": "members",
  "nav-audit": "audit",
  "nav-integrations-git-providers": "gitProviders",
  "nav-integrations-registry": "registry",
  "nav-integrations-notifications": "notifications",
  "nav-settings": "settings",
  "nav-settings-security": "security",
  "nav-admin-disk": "disk",
} as const

interface NavEntry {
  id: keyof typeof PALETTE_NAV_KEYS
  section: NavSection
  icon: React.ComponentType<{ className?: string }>
  to: string
  orgPathSuffix?: string
  params?: Record<string, string>
  adminOnly?: boolean
}

const NAV_SECTIONS: Array<NavSection> = [
  "Navigation",
  "Integrations",
  "Account",
  "Instance",
]

// Status colour is the only place the palette leaves the neutral token set:
// a deploy state is the one thing a user scans for rather than reads.
const APP_STATUS_TONE: Record<string, string> = {
  running: "bg-emerald-500",
  serving: "bg-emerald-500",
  building: "bg-amber-500",
  restarting: "bg-amber-500",
  pending: "bg-amber-500",
  failed: "bg-red-500",
}

// ---------------------------------------------------------------------------
// Pure filter helper — exported for unit tests
// ---------------------------------------------------------------------------

export interface FilterableItem {
  id: string
  label: string
}

export function matchesQuery(item: FilterableItem, query: string): boolean {
  if (query.trim() === "") return true
  return item.label.toLowerCase().includes(query.trim().toLowerCase())
}

// ---------------------------------------------------------------------------
// Static navigation items
// ---------------------------------------------------------------------------

const NAV_ITEMS: Array<NavEntry> = [
  {
    id: "nav-dashboard",
    section: "Navigation",
    icon: RiDashboardLine,
    to: "/dashboard",
    orgPathSuffix: "dashboard",
  },
  {
    id: "nav-apps",
    section: "Navigation",
    icon: RiApps2Line,
    to: "/apps",
    orgPathSuffix: "apps",
  },
  {
    id: "nav-databases",
    section: "Navigation",
    icon: RiDatabase2Line,
    to: "/databases",
    orgPathSuffix: "databases",
  },
  {
    id: "nav-services",
    section: "Navigation",
    icon: RiCodeBoxLine,
    to: "/dashboard",
    orgPathSuffix: "services",
  },
  {
    id: "nav-deployments",
    section: "Navigation",
    icon: RiRocketLine,
    to: "/dashboard",
    orgPathSuffix: "deployments",
  },
  {
    id: "nav-marketplace",
    section: "Navigation",
    icon: RiShapesLine,
    to: "/dashboard",
    orgPathSuffix: "marketplace",
  },
  {
    id: "nav-monitoring",
    section: "Navigation",
    icon: RiPulseLine,
    to: "/dashboard",
    orgPathSuffix: "monitoring",
  },
  {
    id: "nav-members",
    section: "Navigation",
    icon: RiTeamLine,
    to: "/dashboard",
    orgPathSuffix: "members",
  },
  {
    id: "nav-audit",
    section: "Navigation",
    icon: RiFileListLine,
    to: "/dashboard",
    orgPathSuffix: "audit",
  },
  {
    id: "nav-integrations-git-providers",
    section: "Integrations",
    icon: RiPlugLine,
    to: "/settings/git-providers",
  },
  {
    id: "nav-integrations-registry",
    section: "Integrations",
    icon: RiArchiveLine,
    to: "/settings/registry",
  },
  {
    id: "nav-integrations-notifications",
    section: "Integrations",
    icon: RiNotificationLine,
    to: "/settings/notifications",
  },
  {
    id: "nav-settings",
    section: "Account",
    icon: RiSettings3Line,
    to: "/settings",
  },
  {
    id: "nav-settings-security",
    section: "Account",
    icon: RiShieldCheckLine,
    to: "/settings/security",
  },
  {
    id: "nav-admin-disk",
    section: "Instance",
    icon: RiHardDriveLine,
    to: "/admin/disk",
    orgPathSuffix: "disk",
    adminOnly: true,
  },
]

// ---------------------------------------------------------------------------
// CurrentAppActions — quick actions when an app route is active
// Mounted only when palette is open (lazy) so mutations don't subscribe
// to the events stream until the user actually needs them.
// ---------------------------------------------------------------------------

interface CurrentAppActionsProps {
  appId: string
  onClose: () => void
}

function CurrentAppActions({
  appId,
  onClose,
}: CurrentAppActionsProps): React.JSX.Element {
  const currentOrgSlug = useCurrentOrganizationSlug()
  const deploy = useDeployApp(appId)
  const stop = useStopApp(appId)
  const router = useRouter()

  const handleDeploy = () => {
    deploy.mutate()
    onClose()
  }

  const handleStop = () => {
    stop.mutate()
    onClose()
  }

  const handleLogs = () => {
    void router.navigate({
      href: currentOrgSlug
        ? organizationPath(currentOrgSlug, `apps/${appId}/logs`)
        : `/apps/${appId}/logs`,
    })
    onClose()
  }

  const { t } = useTranslation("common")
  return (
    <CommandGroup heading={t("commandPalette.currentApp")}>
      <CommandItem
        value="app-action logs terminal output"
        onSelect={handleLogs}
      >
        <RiTerminalBoxLine className="size-4" />
        <span className="flex-1 truncate">{t("commandPalette.viewLogs")}</span>
      </CommandItem>
      <CommandItem value="app-action deploy build ship" onSelect={handleDeploy}>
        <RiRocketLine className="size-4" />
        <span className="flex-1 truncate">{t("commandPalette.deploy")}</span>
      </CommandItem>
      <CommandItem value="app-action stop halt" onSelect={handleStop}>
        <RiStopCircleLine className="size-4" />
        <span className="flex-1 truncate">{t("commandPalette.stop")}</span>
      </CommandItem>
    </CommandGroup>
  )
}

// ---------------------------------------------------------------------------
// CommandPaletteContent — the dynamic, query-dependent part.
// Only mounted when the palette is open, so useApps / useMatches / mutations
// never subscribe while the palette sits idle. Prevents SSR-hydration races
// that surface as "Cannot read properties of undefined (reading 'subscribe')".
// ---------------------------------------------------------------------------

interface CommandPaletteContentProps {
  onClose: () => void
}

function CommandPaletteContent({
  onClose,
}: CommandPaletteContentProps): React.JSX.Element {
  const { t } = useTranslation("common")
  const router = useRouter()
  const matches = useMatches()
  const organization = useCurrentOrganization()
  const currentOrgSlug = useCurrentOrganizationSlug()
  const { data: me } = useMe()
  const { data: apps } = useApps(organization?.id)

  const currentAppMatch = matches.find(
    (m) => m.routeId === "/_authed/orgs/$orgSlug/apps/$id"
  )
  const currentAppId = currentAppMatch
    ? (currentAppMatch.params as { id?: string }).id
    : undefined

  const handleNavSelect = React.useCallback(
    (to: string, params?: Record<string, string>) => {
      void router.navigate({ to, params } as Parameters<
        typeof router.navigate
      >[0])
      onClose()
    },
    [router, onClose]
  )

  const visibleNav = NAV_ITEMS.filter(
    (item) => !item.adminOnly || me?.is_instance_admin
  )

  return (
    <>
      {currentAppId ? (
        <CurrentAppActions appId={currentAppId} onClose={onClose} />
      ) : null}

      {apps && apps.length > 0 ? (
        <CommandGroup heading={t("commandPalette.applications")}>
          {apps.map((app) => (
            <CommandItem
              key={app.id}
              value={`app ${app.name} ${app.slug} ${app.status}`}
              disabled={app.status === "deleting"}
              onSelect={() => {
                if (app.status === "deleting") return
                handleNavSelect(
                  currentOrgSlug
                    ? organizationPath(
                        currentOrgSlug,
                        `apps/${app.id}/settings`
                      )
                    : "/apps/$id/settings",
                  currentOrgSlug ? undefined : { id: app.id }
                )
              }}
            >
              <RiApps2Line className="size-4" />
              <span className="flex-1 truncate">{app.name}</span>
              <CommandMeta>{app.slug}</CommandMeta>
              <span
                aria-hidden="true"
                className={`size-1.5 shrink-0 rounded-full ${
                  APP_STATUS_TONE[app.status] ?? "bg-muted-foreground/40"
                }`}
              />
              <span className="sr-only">{app.status}</span>
              <CommandMeta className="w-16 shrink-0">{app.status}</CommandMeta>
            </CommandItem>
          ))}
        </CommandGroup>
      ) : null}

      {NAV_SECTIONS.map((section) => {
        const items = visibleNav.filter((item) => item.section === section)
        if (items.length === 0) return null
        return (
          <CommandGroup
            key={section}
            heading={t(`commandPalette.${section.toLowerCase()}`)}
          >
            {items.map((item) => {
              const Icon = item.icon
              const label = t(`nav.${PALETTE_NAV_KEYS[item.id]}`)
              const target =
                currentOrgSlug && item.orgPathSuffix
                  ? organizationPath(currentOrgSlug, item.orgPathSuffix)
                  : item.to
              const hint = item.orgPathSuffix
                ? `/${item.orgPathSuffix}`
                : item.to
              return (
                <CommandItem
                  key={item.id}
                  value={`nav ${section} ${label} ${hint}`}
                  onSelect={() => handleNavSelect(target, item.params)}
                >
                  <Icon className="size-4" />
                  <span className="flex-1 truncate">{label}</span>
                  <CommandMeta>{hint}</CommandMeta>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )
      })}
    </>
  )
}

// ---------------------------------------------------------------------------
// CommandPalette — shell, always mounted, cheap when closed.
// ---------------------------------------------------------------------------

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPalette({
  open,
  onOpenChange,
}: CommandPaletteProps): React.JSX.Element {
  const { t } = useTranslation("common")
  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-xl md:max-w-2xl"
      title={t("commandPalette.title")}
      description={t("commandPalette.description")}
      closeLabel={t("close")}
    >
      <CommandInput placeholder={t("commandPalette.placeholderLong")} />
      <CommandList className="max-h-[55dvh] sm:max-h-[26rem]">
        <CommandEmpty>
          <span className="text-muted-foreground">
            {t("commandPalette.emptyLong")}
          </span>
        </CommandEmpty>

        {open ? <CommandPaletteContent onClose={close} /> : null}
      </CommandList>

      <CommandFooter className="hidden sm:flex">
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <CommandKbd>↑</CommandKbd>
            <CommandKbd>↓</CommandKbd>
            {t("commandPalette.navigate")}
          </span>
          <span className="flex items-center gap-1.5">
            <CommandKbd>↵</CommandKbd>
            {t("commandPalette.select")}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <CommandKbd>esc</CommandKbd>
          {t("commandPalette.closeAction")}
        </span>
      </CommandFooter>
    </CommandDialog>
  )
}

// ---------------------------------------------------------------------------
// CommandPaletteRoot — consumes the shared context from CommandPaletteProvider
// so the header CommandBar and the palette share one open/close state.
// ---------------------------------------------------------------------------

export function CommandPaletteRoot(): React.JSX.Element {
  const { open, setOpen } = useCommandPaletteContext()
  return <CommandPalette open={open} onOpenChange={setOpen} />
}
