// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  Link,
  useMatches,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import {
  RiAddLine,
  RiApps2Line,
  RiArchiveLine,
  RiArrowDownSLine,
  RiBookOpenLine,
  RiCloseLine,
  RiCodeBoxLine,
  RiDashboardLine,
  RiDatabase2Line,
  RiExpandUpDownLine,
  RiFileListLine,
  RiHardDrive3Line,
  RiHardDriveLine,
  RiHistoryLine,
  RiKey2Line,
  RiKeyLine,
  RiLoader4Line,
  RiLogoutBoxRLine,
  RiMenuLine,
  RiMoonLine,
  RiNotificationLine,
  RiPlugLine,
  RiPriceTagLine,
  RiPulseLine,
  RiRocketLine,
  RiSearchLine,
  RiSendPlane2Line,
  RiSettings3Line,
  RiShapesLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
  RiSideBarFill,
  RiStackLine,
  RiSunLine,
  RiTeamLine,
  RiTimerLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { useApp } from "../../lib/apps"
import { useLogout, useSessionMe } from "../../lib/auth"
import {
  CommandPaletteProvider,
  useCommandPaletteContext,
} from "../../lib/hooks/command-palette-context"
import { usePendingAction } from "../../lib/hooks/use-pending-action"
import { useUnseenRelease } from "../../lib/hooks/use-unseen-release"
import {
  organizationDashboardPath,
  organizationPath,
  replaceOrganizationInPath,
  useCreateOrganization,
  useCurrentOrganization,
  useCurrentOrganizationSlug,
  useOrganizations,
} from "../../lib/organizations"
import { useTheme } from "../theme/ThemeToggle"
import { CommandBar, detectMac } from "./CommandBar"
import { CommandPaletteRoot } from "./CommandPalette"
import { AppActivityIndicator } from "./AppActivityIndicator"
import { BuildActivityIndicator } from "./BuildActivityIndicator"
import { NotificationBell } from "./NotificationBell"
import {
  extractAppId,
  extractAppName,
  resolveTopbarBreadcrumb,
} from "./topbar-breadcrumb"
import type { OrganizationSummary } from "@ploydok/shared"

interface AppShellProps {
  children: React.ReactNode
}

interface ShellPageProps {
  title: string
  description?: string
  eyebrow?: string
  actions?: React.ReactNode
  children: React.ReactNode
}

interface ShellPanelProps {
  title?: string
  description?: string
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}

interface NavItem {
  id: string
  icon: React.ComponentType<{ className?: string }>
  href?: string
  orgPathSuffix?: string
  rootSettingsPathSuffix?: string
  fallbackHref?: string
  comingSoon?: boolean
  tooltipKey?: string
  adminOnly?: boolean
}

interface ResolvedNavItem {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  to?: string
  comingSoon?: boolean
  tooltip?: string
  loading?: boolean
}

const workspaceNav: Array<NavItem> = [
  {
    id: "dashboard",
    icon: RiDashboardLine,
    orgPathSuffix: "dashboard",
    fallbackHref: "/dashboard",
  },
  {
    id: "applications",
    icon: RiApps2Line,
    orgPathSuffix: "apps",
    fallbackHref: "/apps",
  },
  {
    id: "databases",
    icon: RiDatabase2Line,
    orgPathSuffix: "databases",
    fallbackHref: "/databases",
  },
  { id: "deployments", icon: RiRocketLine, orgPathSuffix: "deployments" },
  { id: "services", icon: RiCodeBoxLine, orgPathSuffix: "services" },
  { id: "marketplace", icon: RiShapesLine, orgPathSuffix: "marketplace" },
  {
    id: "templates",
    icon: RiStackLine,
    comingSoon: true,
    tooltipKey: "nav.templatesTooltip",
  },
  { id: "monitoring", icon: RiPulseLine, orgPathSuffix: "monitoring" },
]

const platformNav: Array<NavItem> = [
  {
    id: "disk",
    icon: RiHardDriveLine,
    orgPathSuffix: "disk",
    adminOnly: true,
  },
  { id: "storage", icon: RiHardDrive3Line, orgPathSuffix: "storage" },
  { id: "members", icon: RiTeamLine, orgPathSuffix: "members" },
  { id: "audit", icon: RiFileListLine, orgPathSuffix: "audit" },
  {
    id: "sharedEnv",
    icon: RiKeyLine,
    comingSoon: true,
    tooltipKey: "nav.sharedEnvTooltip",
  },
  {
    id: "scheduledJobs",
    icon: RiTimerLine,
    comingSoon: true,
    tooltipKey: "nav.scheduledJobsTooltip",
  },
  {
    id: "eventWebhooks",
    icon: RiSendPlane2Line,
    comingSoon: true,
    tooltipKey: "nav.eventWebhooksTooltip",
  },
  {
    id: "tags",
    icon: RiPriceTagLine,
    comingSoon: true,
    tooltipKey: "nav.tagsTooltip",
  },
]

const integrationsNav: Array<NavItem> = [
  {
    id: "gitProviders",
    icon: RiPlugLine,
    rootSettingsPathSuffix: "git-providers",
  },
  {
    id: "registry",
    icon: RiArchiveLine,
    rootSettingsPathSuffix: "registry",
  },
  {
    id: "notifications",
    icon: RiNotificationLine,
    rootSettingsPathSuffix: "notifications",
  },
  {
    id: "apiTokens",
    icon: RiKey2Line,
    rootSettingsPathSuffix: "api-tokens",
  },
]

const accountNav: Array<NavItem> = [
  { id: "guide", icon: RiBookOpenLine, href: "/guide" },
  { id: "changelog", icon: RiHistoryLine, href: "/changelog" },
  { id: "settings", icon: RiSettings3Line, href: "/settings" },
]

/**
 * Several core operations sit behind `requireTotpVerified` server-side: secret
 * reveal, webhook secret rotation and replay, database credential rotation,
 * the Adminer console, and backup restore. Enrollment is skippable at setup and
 * absent from the invitation flow, so without this prompt the requirement is
 * only ever discovered by hitting a wall mid-task.
 */
function TwoFactorPrompt(): React.JSX.Element {
  const { t } = useTranslation("common")
  return (
    <Link
      to="/settings/security/totp"
      preload={false}
      className="mb-1 flex flex-col gap-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 transition-colors group-data-[sidebar-state=collapsed]/shell:hidden hover:bg-amber-500/15"
    >
      <span className="flex items-center gap-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
        <RiShieldKeyholeLine className="size-4 shrink-0" aria-hidden="true" />
        {t("twoFactorPrompt.title")}
      </span>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t("twoFactorPrompt.body")}
      </span>
      <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
        {t("twoFactorPrompt.cta")}
      </span>
    </Link>
  )
}

function SidebarProfileSkeleton({
  expanded,
}: {
  expanded: boolean
}): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      aria-busy="true"
      className={cx(
        "flex items-center overflow-hidden",
        expanded
          ? "w-full gap-2 rounded-[12px] border-2 border-transparent bg-[#ebebeb] py-2 pr-4 pl-[10px] dark:bg-neutral-800"
          : "size-9 justify-center"
      )}
    >
      <Skeleton className="size-8 shrink-0 rounded-full" />
      {expanded ? (
        <span className="grid flex-1 gap-1.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-28" />
        </span>
      ) : null}
    </div>
  )
}

function SidebarQuickSearch({
  expanded,
}: {
  expanded: boolean
}): React.JSX.Element {
  const { t } = useTranslation("common")
  const { setOpen } = useCommandPaletteContext()
  const [isMac, setIsMac] = React.useState(false)

  React.useEffect(() => {
    setIsMac(detectMac())
  }, [])

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label={t("commandPalette.open")}
      title={expanded ? undefined : t("nav.quickSearch")}
      className={cx(
        "flex shrink-0 cursor-pointer items-center gap-2 rounded-full bg-[#ebebeb] p-2 transition-[width,border-radius,background-color] duration-300 ease-in-out outline-none hover:bg-[#d4d4d4]/55 focus-visible:ring-2 focus-visible:ring-[#3080ff] focus-visible:ring-offset-2 dark:bg-neutral-800 dark:hover:bg-neutral-700/55",
        expanded ? "w-full" : "size-9 justify-center"
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <RiSearchLine className="size-5 shrink-0 text-neutral-500" />
        {expanded ? (
          <span className="text-sm font-medium whitespace-nowrap text-neutral-500">
            {t("nav.quickSearch")}
          </span>
        ) : null}
      </span>
      {expanded ? (
        <kbd className="inline-flex items-center justify-center rounded-md bg-[#d4d4d4] px-1 py-0.5 font-sans text-xs leading-4 font-semibold tracking-normal whitespace-nowrap text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">
          {isMac ? "⌘K" : "Ctrl K"}
        </kbd>
      ) : null}
    </button>
  )
}

function resolveNavItem(
  item: NavItem,
  currentOrgSlug: string | null,
  t: (key: string) => string
): ResolvedNavItem {
  const label = t(`nav.${item.id}`)
  const tooltip = item.tooltipKey ? t(item.tooltipKey) : undefined
  if (item.comingSoon) {
    return {
      id: item.id,
      label,
      icon: item.icon,
      comingSoon: true,
      tooltip,
    }
  }
  if (item.href) {
    return { id: item.id, label, icon: item.icon, to: item.href }
  }
  if (item.rootSettingsPathSuffix) {
    return {
      id: item.id,
      label,
      icon: item.icon,
      to: `/settings/${item.rootSettingsPathSuffix}`,
    }
  }
  if (item.orgPathSuffix) {
    if (currentOrgSlug) {
      return {
        id: item.id,
        label,
        icon: item.icon,
        to: organizationPath(currentOrgSlug, item.orgPathSuffix),
      }
    }
    if (item.fallbackHref) {
      return { id: item.id, label, icon: item.icon, to: item.fallbackHref }
    }
    return {
      id: item.id,
      label,
      icon: item.icon,
      comingSoon: true,
      tooltip: t("nav.selectWorkspace"),
    }
  }
  return { id: item.id, label, icon: item.icon }
}

const STORAGE_KEY = "ploydok.sidebar.state"
const CREATE_WORKSPACE_VALUE = "__create_workspace__"

function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ")
}

const APP_LOGS_RE = /^\/(?:orgs\/[^/]+\/)?apps\/[^/]+\/logs(\/|$)/
const APP_DETAIL_RE = /^\/(?:orgs\/[^/]+\/)?apps\/[^/]+(\/|$)/

function resolveWrapperClass(pathname: string): string {
  if (APP_LOGS_RE.test(pathname)) return "overflow-hidden"
  if (APP_DETAIL_RE.test(pathname)) return "overflow-y-auto"
  return "overflow-y-auto"
}

function isNavActive(pathname: string, target: string): boolean {
  if (target === "/dashboard") return pathname === "/dashboard"
  return pathname === target || pathname.startsWith(`${target}/`)
}

function useSidebarState(): {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  toggle: () => void
} {
  const [open, setOpen] = React.useState<boolean>(() => {
    if (typeof window === "undefined") return true
    try {
      return window.localStorage.getItem(STORAGE_KEY) !== "collapsed"
    } catch {
      return true
    }
  })

  React.useEffect(() => {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(STORAGE_KEY, open ? "expanded" : "collapsed")
    } catch {
      // ignore
    }
  }, [open])

  const toggle = React.useCallback(() => {
    setOpen((prev) => !prev)
  }, [])

  return { open, setOpen, toggle }
}

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (organization: OrganizationSummary) => Promise<void> | void
}

function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateWorkspaceDialogProps): React.JSX.Element {
  const { t } = useTranslation("common")
  const createOrganization = useCreateOrganization()
  const [name, setName] = React.useState("")
  const wasOpenRef = React.useRef(open)

  React.useEffect(() => {
    if (open || !wasOpenRef.current) {
      wasOpenRef.current = open
      return
    }

    setName("")
    createOrganization.reset()
    wasOpenRef.current = open
  }, [open])

  const trimmedName = name.trim()

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    if (!trimmedName || createOrganization.isPending) return

    try {
      const organization = await createOrganization.mutateAsync({
        name: trimmedName,
      })
      setName("")
      onOpenChange(false)
      await onCreated(organization)
    } catch {
      return
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspaceDialog.title")}</DialogTitle>
          <DialogDescription>
            {t("workspaceDialog.description")}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="flex flex-col gap-4"
        >
          <FieldGroup>
            <Field data-invalid={Boolean(createOrganization.error)}>
              <FieldContent>
                <FieldLabel htmlFor="workspace-name">
                  {t("workspaceDialog.name")}
                </FieldLabel>
                <FieldDescription>
                  {t("workspaceDialog.nameHint")}
                </FieldDescription>
              </FieldContent>
              <Input
                id="workspace-name"
                value={name}
                autoFocus
                aria-invalid={Boolean(createOrganization.error)}
                placeholder={t("workspaceDialog.placeholder")}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldError>{createOrganization.error?.message}</FieldError>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createOrganization.isPending}
            >
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              loading={createOrganization.isPending}
              disabled={!trimmedName}
            >
              {createOrganization.isPending
                ? t("workspaceDialog.creating")
                : t("workspaceDialog.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  const { t } = useTranslation("common")
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  // `location` moves as soon as a link is clicked, while the rendered matches
  // stay on the previous page until its loader resolves. Chrome that depends
  // on the page being shown must follow `resolvedLocation`, or it flashes.
  const renderedPathname = useRouterState({
    select: (state) => (state.resolvedLocation ?? state.location).pathname,
  })
  const me = useSessionMe()
  const meLoading = me === undefined
  const { data: organizations = [], isPending: orgsLoading } =
    useOrganizations()
  const currentOrganization = useCurrentOrganization()
  // The current workspace is known from the session; the full list only
  // feeds the switcher and must not hold the sidebar in a second skeleton.
  const workspaceLoading = orgsLoading && !currentOrganization
  const currentOrgSlug = useCurrentOrganizationSlug()
  const logout = useLogout()
  const router = useRouter()
  const {
    mode: themeMode,
    resolved: resolvedTheme,
    setMode: setThemeMode,
    toggle: toggleTheme,
  } = useTheme()
  const {
    open: sidebarOpen,
    setOpen: setSidebarOpen,
    toggle: toggleSidebar,
  } = useSidebarState()
  const {
    unseen: unseenRelease,
    markSeen: markReleaseSeen,
    version,
  } = useUnseenRelease()
  const [profileOpen, setProfileOpen] = React.useState(false)
  const [workspaceSelectOpen, setWorkspaceSelectOpen] = React.useState(false)
  const [openWorkspaceSelectOnExpand, setOpenWorkspaceSelectOnExpand] =
    React.useState(false)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = React.useState(false)
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false)

  React.useEffect(() => {
    setProfileOpen(false)
    setWorkspaceSelectOpen(false)
    setMobileNavOpen(false)
  }, [pathname])

  React.useEffect(() => {
    if (typeof window === "undefined" || !mobileNavOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMobileNavOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [mobileNavOpen])

  React.useEffect(() => {
    if (
      !sidebarOpen ||
      !openWorkspaceSelectOnExpand ||
      typeof window === "undefined"
    )
      return
    const frame = window.requestAnimationFrame(() => {
      setWorkspaceSelectOpen(true)
      setOpenWorkspaceSelectOnExpand(false)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [openWorkspaceSelectOnExpand, sidebarOpen])

  React.useEffect(() => {
    if (sidebarOpen) return
    setWorkspaceSelectOpen(false)
  }, [sidebarOpen])

  const displayName = me?.display_name ?? t("nav.workspaceOwner")
  const email = me?.email ?? "hello@ploydok.dev"
  const initials = displayName
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
  const workspaceInitial = (currentOrganization?.name ?? t("nav.myOrganization"))
    .charAt(0)
    .toUpperCase()
  const availableOrganizations = React.useMemo(() => {
    const rows = [...organizations]
    if (
      currentOrganization &&
      !rows.some((organization) => organization.id === currentOrganization.id)
    ) {
      rows.unshift(currentOrganization)
    }
    return rows
  }, [currentOrganization, organizations])

  const signOut = usePendingAction(
    async () => {
      await logout.mutateAsync()
      await router.navigate({ to: "/login" })
    },
    { keepPendingOnSuccess: true }
  )

  const expanded = sidebarOpen || mobileNavOpen
  const state = expanded ? "expanded" : "collapsed"
  const navGroups: Array<{ title: string; items: Array<ResolvedNavItem> }> = [
    {
      title: t("nav.workspace"),
      items: workspaceNav.map((item) =>
        resolveNavItem(item, currentOrgSlug, t)
      ),
    },
    {
      title: t("nav.platform"),
      items: platformNav
        .filter((item) => !item.adminOnly || me?.is_instance_admin || meLoading)
        .map((item) => {
          const resolved = resolveNavItem(item, currentOrgSlug, t)
          return item.adminOnly && meLoading
            ? { ...resolved, loading: true }
            : resolved
        }),
    },
    {
      title: t("nav.integrations"),
      items: integrationsNav.map((item) =>
        resolveNavItem(item, currentOrgSlug, t)
      ),
    },
  ]
  const accountNavItems = accountNav.map((item) =>
    resolveNavItem(item, currentOrgSlug, t)
  )

  const handleOrganizationChange = async (nextSlug: string): Promise<void> => {
    if (!nextSlug || nextSlug === currentOrgSlug) return
    await router.navigate({
      href: replaceOrganizationInPath(pathname, nextSlug),
    })
  }

  const handleWorkspaceSelect = (nextValue: string): void => {
    if (nextValue === CREATE_WORKSPACE_VALUE) {
      setWorkspaceSelectOpen(false)
      setCreateWorkspaceOpen(true)
      return
    }
    void handleOrganizationChange(nextValue)
  }

  const handleCollapsedWorkspaceClick = (): void => {
    if (sidebarOpen) {
      setWorkspaceSelectOpen(true)
      return
    }
    setSidebarOpen(true)
    setOpenWorkspaceSelectOnExpand(true)
  }

  const handleWorkspaceCreated = async (
    organization: OrganizationSummary
  ): Promise<void> => {
    setWorkspaceSelectOpen(false)
    await router.navigate({
      href: organizationDashboardPath(organization.slug),
    })
  }

  const wrapperStyle: React.CSSProperties = {
    ["--sidebar-width" as string]: "276px",
    ["--sidebar-width-icon" as string]: "60px",
    ["--sidebar-inset-radius" as string]: "calc(var(--radius) * 4)",
    ["--sidebar-animation-duration" as string]: "300ms",
    ["--sidebar-animation-ease" as string]: "cubic-bezier(0.32, 0.72, 0, 1)",
  }

  return (
    <CommandPaletteProvider>
      <div
        data-sidebar-state={state}
        style={wrapperStyle}
        className="group/shell flex h-dvh w-full overflow-hidden bg-background text-foreground"
      >
        {/* Mobile backdrop */}
        {mobileNavOpen ? (
          <button
            type="button"
            aria-label={t("nav.closeNavigation")}
            onClick={() => setMobileNavOpen(false)}
            className="fixed inset-0 z-40 cursor-pointer bg-black/40 backdrop-blur-sm md:hidden"
          />
        ) : null}

        {/* Sidebar (peer) */}
        <div
          data-slot="sidebar"
          data-state={state}
          data-collapsible={state === "collapsed" ? "icon" : ""}
          data-variant="floating"
          data-mobile-open={mobileNavOpen ? "true" : "false"}
          className="peer"
        >
          {/* Gap: reserves horizontal space on desktop only */}
          <div
            aria-hidden
            className={cx(
              "relative hidden h-svh shrink-0 bg-transparent md:block",
              "w-[var(--sidebar-width)] transition-[width] duration-(--sidebar-animation-duration) ease-(--sidebar-animation-ease)",
              "group-data-[sidebar-state=collapsed]/shell:w-[calc(var(--sidebar-width-icon)+1rem)]"
            )}
          />

          {/* Container: fixed positioned. Drawer on mobile, persistent on md+. */}
          <div
            className={cx(
              "fixed inset-y-0 left-0 z-50 flex h-dvh p-2 md:z-10",
              "w-[min(18rem,85vw)] md:w-[var(--sidebar-width)]",
              "transition-transform duration-(--sidebar-animation-duration) ease-(--sidebar-animation-ease)",
              "md:transition-[width]",
              mobileNavOpen
                ? "translate-x-0"
                : "-translate-x-full md:translate-x-0",
              "group-data-[sidebar-state=collapsed]/shell:md:w-[calc(var(--sidebar-width-icon)+1rem)]"
            )}
          >
            <aside
              className={cx(
                "flex size-full shrink-0 flex-col justify-between overflow-hidden rounded-[24px] border border-white bg-sidebar shadow-[var(--shadow-elevated)] transition-[padding] duration-300 ease-in-out dark:border-[#26262a] dark:shadow-[0_1px_0_0_#0000001a,0_1px_12px_0_#00000029,0_0_1px_0_#0000006b]",
                expanded ? "p-3" : "px-[11px] py-3"
              )}
            >
              <div className="-m-2 flex min-h-0 w-[calc(100%+16px)] flex-col gap-3 overflow-y-auto p-2 [scrollbar-width:none]">
                {/* Header: workspace menu + collapse */}
                <div
                  className={cx(
                    "flex w-full transition-[gap] duration-300 ease-in-out",
                    expanded
                      ? "flex-row items-center justify-between"
                      : "flex-col-reverse items-center gap-3"
                  )}
                >
                  {workspaceLoading ? (
                    <div
                      aria-hidden
                      aria-busy="true"
                      className="flex h-8 min-w-0 items-center gap-2"
                    >
                      <Skeleton className="size-8 shrink-0 rounded-full" />
                      {expanded ? <Skeleton className="h-3 w-24" /> : null}
                    </div>
                  ) : expanded ? (
                    <div className="-m-2 min-w-0 overflow-hidden p-2">
                      <Select
                        open={workspaceSelectOpen}
                        onOpenChange={setWorkspaceSelectOpen}
                        value={currentOrgSlug ?? currentOrganization?.slug ?? ""}
                        onValueChange={handleWorkspaceSelect}
                      >
                        <SelectTrigger
                          aria-label={t("nav.openWorkspaceSwitcher")}
                          className={cx(
                            "relative h-8 w-auto max-w-[206px] min-w-0 cursor-pointer justify-start gap-2 rounded-full border-0 !bg-transparent p-0 text-sm font-medium text-neutral-950 shadow-none dark:text-neutral-50",
                            "before:pointer-events-none before:absolute before:-inset-x-1.5 before:-inset-y-[5px] before:rounded-full before:border-2 before:border-transparent before:transition-colors hover:before:border-[#d4d4d4] dark:hover:before:border-neutral-500",
                            "focus-visible:ring-2 focus-visible:ring-[#3080ff] focus-visible:ring-offset-2",
                            "[&>svg:last-child]:hidden"
                          )}
                        >
                          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#d4d4d4] text-base leading-[22px] font-semibold text-neutral-500 dark:bg-neutral-700 dark:text-neutral-300">
                            {workspaceInitial}
                          </span>
                          <span className="flex min-w-0 items-center gap-0.5">
                            <span className="truncate">
                              <SelectValue
                                placeholder={t("nav.selectWorkspacePlaceholder")}
                              />
                            </span>
                            <RiExpandUpDownLine className="size-4 shrink-0 text-neutral-400" />
                          </span>
                        </SelectTrigger>
                        <SelectContent
                          align="start"
                          className="min-w-[220px]"
                        >
                          <SelectGroup>
                            {availableOrganizations.map((organization) => (
                              <SelectItem
                                key={organization.id}
                                value={organization.slug}
                                className="cursor-pointer"
                              >
                                {organization.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                          <SelectGroup>
                            <SelectItem
                              value={CREATE_WORKSPACE_VALUE}
                              className="cursor-pointer"
                            >
                              <span className="flex items-center gap-2">
                                <RiAddLine className="size-4 shrink-0" />
                                <span>{t("workspaceDialog.submit")}</span>
                              </span>
                            </SelectItem>
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={handleCollapsedWorkspaceClick}
                      className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#d4d4d4] text-base leading-[22px] font-semibold text-neutral-500 outline-none focus-visible:ring-2 focus-visible:ring-[#3080ff] focus-visible:ring-offset-2 dark:bg-neutral-700 dark:text-neutral-300"
                      aria-label={t("nav.openWorkspaceSwitcher")}
                      title={currentOrganization?.name ?? t("nav.myOrganization")}
                    >
                      {workspaceInitial}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setMobileNavOpen(false)}
                    className="cursor-pointer text-neutral-500 outline-none md:hidden"
                    aria-label={t("nav.closeNavigation")}
                  >
                    <RiCloseLine className="size-5" />
                  </button>
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    className="hidden cursor-pointer text-neutral-500 transition-transform duration-300 ease-in-out outline-none focus-visible:ring-2 focus-visible:ring-[#3080ff] md:block"
                    aria-label={
                      expanded ? t("nav.collapseSidebar") : t("nav.expandSidebar")
                    }
                    aria-expanded={expanded}
                  >
                    <RiSideBarFill
                      className={cx(
                        "size-5 transition-transform duration-300 ease-in-out",
                        expanded && "-scale-x-100"
                      )}
                    />
                  </button>
                </div>

                <SidebarQuickSearch expanded={expanded} />

                {navGroups.map((group) => (
                  <div key={group.title} className="flex flex-col gap-1">
                    {expanded ? (
                      <div className="flex h-6 shrink-0 items-center overflow-hidden px-2.5 text-xs font-medium text-neutral-500">
                        {group.title}
                      </div>
                    ) : null}
                    <ul
                      className={cx(
                        "flex w-full min-w-0 flex-col gap-1",
                        expanded && "px-0.5"
                      )}
                    >
                      {group.items.map((item) => {
                        const Icon = item.icon
                        if (item.loading) {
                          return (
                            <li key={item.id} aria-hidden="true">
                              <div
                                aria-busy="true"
                                className={cx(
                                  "flex h-9 items-center gap-2 overflow-hidden rounded-[10px] p-2",
                                  expanded ? "w-full" : "w-9 justify-center"
                                )}
                              >
                                <Skeleton className="size-5 shrink-0" />
                                {expanded ? (
                                  <Skeleton className="h-3 w-16" />
                                ) : null}
                              </div>
                            </li>
                          )
                        }
                        if (item.comingSoon || !item.to) {
                          return (
                            <li key={item.id}>
                              <span
                                title={item.tooltip ?? t("unavailable")}
                                aria-disabled="true"
                                className={cx(
                                  "flex h-9 cursor-not-allowed items-center justify-between overflow-hidden rounded-[10px] p-2 text-neutral-400 dark:text-neutral-600",
                                  expanded ? "w-full" : "w-9 justify-center"
                                )}
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  <Icon className="size-5 shrink-0" />
                                  {expanded ? (
                                    <span className="truncate text-sm font-medium">
                                      {item.label}
                                    </span>
                                  ) : null}
                                </span>
                                {expanded ? (
                                  <span
                                    aria-hidden="true"
                                    className="inline-flex shrink-0 items-center justify-center rounded-sm bg-[#ebebeb] px-1 py-px text-xs leading-4 font-semibold whitespace-nowrap text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                                  >
                                    {item.comingSoon
                                      ? t("planned")
                                      : t("unavailable")}
                                  </span>
                                ) : null}
                              </span>
                            </li>
                          )
                        }
                        const active = isNavActive(pathname, item.to)
                        return (
                          <li key={item.id}>
                            <Link
                              to={item.to}
                              preload={false}
                              title={item.label}
                              aria-current={active ? "page" : undefined}
                              className={cx(
                                "flex h-9 items-center justify-between overflow-hidden rounded-[10px] p-2 transition-[width,background-color] duration-300 ease-in-out outline-none focus-visible:ring-2 focus-visible:ring-[#3080ff] focus-visible:ring-offset-2",
                                expanded ? "w-full" : "w-9 justify-center",
                                active
                                  ? "bg-[#ebebeb] dark:bg-neutral-800"
                                  : "hover:bg-[#ebebeb] dark:hover:bg-neutral-800"
                              )}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <Icon
                                  className={cx(
                                    "size-5 shrink-0",
                                    active
                                      ? "text-neutral-950 dark:text-neutral-50"
                                      : "text-neutral-500"
                                  )}
                                />
                                {expanded ? (
                                  <span
                                    className={cx(
                                      "truncate text-sm font-medium",
                                      active
                                        ? "text-neutral-950 dark:text-neutral-50"
                                        : "text-neutral-500"
                                    )}
                                  >
                                    {item.label}
                                  </span>
                                ) : null}
                              </span>
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div
                className={cx(
                  "mt-3 flex w-full shrink-0 flex-col gap-3",
                  !expanded && "items-center"
                )}
              >
                {me && !me.has_totp ? <TwoFactorPrompt /> : null}

                {expanded ? (
                  <div className="relative inline-flex w-fit items-center gap-1 rounded-full bg-[#ebebeb] p-1 dark:bg-neutral-800">
                    <span
                      aria-hidden="true"
                      className={cx(
                        "pointer-events-none absolute start-1 top-1 size-8 rounded-full bg-white shadow-xs transition-transform duration-200 ease-[ease] dark:bg-neutral-700",
                        resolvedTheme === "dark" && "translate-x-9"
                      )}
                    />
                    {(["light", "dark"] as const).map((mode) => {
                      const ModeIcon = mode === "light" ? RiSunLine : RiMoonLine
                      const selected = resolvedTheme === mode
                      return (
                        <button
                          key={mode}
                          type="button"
                          onClick={(event) =>
                            setThemeMode(mode, event.currentTarget)
                          }
                          aria-pressed={selected}
                          aria-label={t(`theme.${mode}`)}
                          className={cx(
                            "relative z-10 grid size-8 cursor-pointer place-items-center rounded-full transition-colors duration-150 ease-[ease] outline-none focus-visible:ring-2 focus-visible:ring-[#3080ff]",
                            selected
                              ? "text-neutral-950 dark:text-neutral-50"
                              : "text-neutral-500 hover:text-neutral-950 dark:hover:text-neutral-50"
                          )}
                        >
                          <ModeIcon className="size-4" />
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={(event) =>
                      setThemeMode(
                        resolvedTheme === "dark" ? "light" : "dark",
                        event.currentTarget
                      )
                    }
                    aria-label={
                      resolvedTheme === "dark"
                        ? t("theme.lightTheme")
                        : t("theme.darkTheme")
                    }
                    className="grid size-9 cursor-pointer place-items-center rounded-[10px] text-neutral-500 outline-none hover:bg-[#ebebeb] focus-visible:ring-2 focus-visible:ring-[#3080ff] dark:hover:bg-neutral-800"
                  >
                    {resolvedTheme === "dark" ? (
                      <RiSunLine className="size-5" />
                    ) : (
                      <RiMoonLine className="size-5" />
                    )}
                  </button>
                )}

                {/* User */}
                {meLoading ? (
                  <SidebarProfileSkeleton expanded={expanded} />
                ) : (
                  <DropdownMenu open={profileOpen} onOpenChange={setProfileOpen}>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        title={displayName}
                        className={cx(
                          "flex cursor-pointer items-center overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-[#3080ff] focus-visible:ring-offset-2",
                          "transition-[width,background-color,border-color,padding] duration-300 ease-in-out",
                          expanded
                            ? "w-full justify-between rounded-[12px] border-2 border-transparent bg-[#ebebeb] py-2 pr-4 pl-[10px] hover:border-[#d4d4d4] dark:bg-neutral-800 dark:hover:border-neutral-500"
                            : "size-9 justify-center rounded-full"
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[#90c5ff] text-sm font-semibold text-[#1c398e]">
                            {initials}
                          </span>
                          {expanded ? (
                            <span className="flex min-w-0 flex-col items-start justify-center">
                              <span className="max-w-full truncate text-sm font-medium text-neutral-950 dark:text-neutral-50">
                                {displayName}
                              </span>
                              <span className="max-w-full truncate text-sm text-neutral-500">
                                {email}
                              </span>
                            </span>
                          ) : null}
                        </span>
                        {expanded ? (
                          <span className="flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-[#d4d4d4] dark:bg-neutral-700">
                            <RiArrowDownSLine
                              className={cx(
                                "size-4 text-neutral-500 transition-transform duration-200 ease-[ease]",
                                profileOpen && "rotate-180"
                              )}
                            />
                          </span>
                        ) : null}
                      </button>
                    </DropdownMenuTrigger>
                        <DropdownMenuContent
                          side="right"
                          align="end"
                          sideOffset={8}
                          className="w-[265px] max-w-[calc(100vw-2rem)] origin-bottom-left rounded-2xl border border-border bg-popover p-2.5 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
                        >
                          <div className="flex w-full items-center gap-2 px-2 pt-1 pb-1">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[image:var(--gradient-primary)] text-xs font-semibold text-white shadow-[0_0_0_1px_#3080ff,inset_0_1px_0_0_#ffffff40]">
                              {initials}
                            </span>
                            <span className="flex min-w-0 flex-col items-start justify-center">
                              <span className="truncate text-sm font-medium text-foreground">
                                {displayName}
                              </span>
                              <span className="truncate text-xs text-muted-foreground">
                                {email}
                              </span>
                            </span>
                          </div>

                          <DropdownMenuSeparator className="-mx-2.5 my-2.5 h-px bg-border" />

                          {accountNavItems.map((item) => {
                            const Icon = item.icon
                            if (!item.to) return null
                            const showReleaseDot =
                              item.id === "changelog" && unseenRelease
                            return (
                              <DropdownMenuItem
                                key={item.id}
                                asChild
                                className="cursor-pointer rounded-xl p-2 text-sm text-foreground"
                              >
                                <Link
                                  to={item.to}
                                  preload={false}
                                  onClick={
                                    showReleaseDot ? markReleaseSeen : undefined
                                  }
                                  className="flex items-center gap-2.5"
                                >
                                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                                  {item.label}
                                  {showReleaseDot ? (
                                    <span
                                      aria-label={`New release v${version}`}
                                      className="ml-auto inline-flex items-center gap-1 rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary"
                                    >
                                      <span
                                        aria-hidden="true"
                                        className="inline-block size-1.5 rounded-full bg-primary"
                                      />
                                      {t("new")}
                                    </span>
                                  ) : null}
                                </Link>
                              </DropdownMenuItem>
                            )
                          })}

                          <DropdownMenuItem
                            asChild
                            className="cursor-pointer rounded-xl p-2 text-sm text-foreground"
                          >
                            <Link
                              to="/settings/security"
                              preload={false}
                              className="flex items-center gap-2.5"
                            >
                              <RiShieldCheckLine className="size-4 shrink-0 text-muted-foreground" />
                              {t("nav.security")}
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(event) =>
                              toggleTheme(event.currentTarget as Element)
                            }
                            className="flex cursor-pointer items-center justify-between gap-2.5 rounded-xl p-2 text-sm text-foreground"
                          >
                            <span className="flex items-center gap-2.5">
                              {resolvedTheme === "dark" ? (
                                <RiSunLine className="size-4 shrink-0 text-muted-foreground" />
                              ) : (
                                <RiMoonLine className="size-4 shrink-0 text-muted-foreground" />
                              )}
                              {resolvedTheme === "dark"
                                ? t("theme.lightTheme")
                                : t("theme.darkTheme")}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {themeMode}
                            </span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={signOut.pending}
                            // Keep the menu open, otherwise it closes on select
                            // and the sign-out round trip happens with nothing
                            // on screen.
                            onSelect={(event) => {
                              event.preventDefault()
                              void signOut.run()
                            }}
                            className="cursor-pointer rounded-xl p-2 text-sm"
                          >
                            {signOut.pending ? (
                              <RiLoader4Line className="size-4 shrink-0 animate-spin" />
                            ) : (
                              <RiLogoutBoxRLine className="size-4 shrink-0" />
                            )}
                            {signOut.pending
                              ? t("signingOut")
                              : t("signOut")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
              </div>
            </aside>
          </div>
        </div>

        {/* Main inset */}
        <main
          data-slot="sidebar-inset"
          className={cx(
            "relative flex w-full min-w-0 flex-1 flex-col bg-background text-foreground"
          )}
        >
          <div className="relative flex h-12 items-center gap-2 px-3 sm:gap-3 sm:px-4 md:px-8">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
              aria-label={t("nav.openNavigation")}
              aria-expanded={mobileNavOpen}
            >
              <RiMenuLine className="size-5" />
            </button>
            <div className="flex min-w-0 flex-1 items-center">
              <TopbarBreadcrumb />
            </div>
            <div className="hidden w-full max-w-md shrink-0 md:flex md:basis-[28rem]">
              <CommandBar />
            </div>
            <div className="flex shrink-0 items-center gap-1 md:min-w-0 md:flex-1 md:justify-end">
              <MobileSearchButton />
              <BuildActivityIndicator />
              <AppActivityIndicator />
              <NotificationBell />
            </div>
          </div>
          <div
            className={cx(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              // App-detail routes own their own chrome (AppBar + padded main) and
              // the logs route needs the terminal flush to the edges, so we strip
              // padding/gap on `/apps/<id>/*` and only apply scroll. Logs also
              // disables scroll here — its internal body handles overflow.
              resolveWrapperClass(renderedPathname)
            )}
          >
            {APP_DETAIL_RE.test(renderedPathname) ? (
              children
            ) : (
              // BoardUI caps page content at 1300px and centers it; the 48px
              // covers ShellPage's horizontal padding.
              <div className="mx-auto flex w-full max-w-[1348px] min-w-0 flex-1 flex-col gap-4">
                {children}
              </div>
            )}
          </div>
        </main>

        {/* Global command palette — portalized, position-safe */}
        <CommandPaletteRoot />
        <CreateWorkspaceDialog
          open={createWorkspaceOpen}
          onOpenChange={setCreateWorkspaceOpen}
          onCreated={handleWorkspaceCreated}
        />
      </div>
    </CommandPaletteProvider>
  )
}

export function ShellPage({
  title,
  description,
  eyebrow,
  actions,
  children,
}: ShellPageProps): React.JSX.Element {
  return (
    <div className="flex w-full min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1">
          {eyebrow ? (
            <p className="text-xs font-medium text-neutral-500">{eyebrow}</p>
          ) : null}
          <h1 className="text-xl leading-[26px] font-medium text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="max-w-3xl text-sm leading-6 text-neutral-500">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {actions}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  )
}

export function ShellPanel({
  title,
  description,
  action,
  className,
  children,
}: ShellPanelProps): React.JSX.Element {
  return (
    <section className={cx("min-w-0 rounded-2xl bg-panel p-4", className)}>
      {title || description || action ? (
        <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            {title ? (
              <h2 className="text-sm font-medium text-foreground">{title}</h2>
            ) : null}
            {description ? (
              <p className="text-[13px] leading-[18px] text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

function MobileSearchButton(): React.JSX.Element {
  const { t } = useTranslation("common")
  const { setOpen } = useCommandPaletteContext()
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:hidden"
      aria-label={t("commandPalette.open")}
    >
      <RiSearchLine className="size-4" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// TopbarBreadcrumb — resolves the current breadcrumb from route matches.
// Mounted in the global topbar next to NotificationBell so every page shows
// consistent navigation context without the children having to opt in.
// ---------------------------------------------------------------------------

function TopbarBreadcrumb(): React.JSX.Element | null {
  const { t } = useTranslation("common")
  const matches = useMatches()
  const pathname = useRouterState({
    select: (s) => (s.resolvedLocation ?? s.location).pathname,
  })
  const orgSlug = useCurrentOrganizationSlug()

  const appId = extractAppId(matches)
  const { data: liveApp } = useApp(appId ?? "", { subscribeToEvents: false })
  const appName = liveApp?.name ?? extractAppName(matches)
  const items = resolveTopbarBreadcrumb(pathname, appName, orgSlug)
  if (items.length === 0) return null

  return (
    <nav
      aria-label={t("breadcrumb.label")}
      className="flex min-w-0 items-center gap-1 overflow-hidden text-xs sm:gap-1.5"
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1
        return (
          <React.Fragment key={`${item.label}:${item.to ?? "current"}`}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            {item.to && !isLast ? (
              <Link
                to={item.to}
                className="hidden truncate whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground sm:inline"
              >
                {item.label}
              </Link>
            ) : (
              <span
                aria-current={isLast ? "page" : undefined}
                className="truncate font-medium text-foreground"
              >
                {item.label}
              </span>
            )}
          </React.Fragment>
        )
      })}
    </nav>
  )
}

function BreadcrumbSeparator(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-3 shrink-0 text-muted-foreground/50"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
