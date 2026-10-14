// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import {
  RiArrowRightLine,
  RiBox3Line,
  RiCheckLine,
  RiGithubFill,
  RiGitlabFill,
  RiLock2Line,
  RiRefreshLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import {
  ChoiceCard,
  OnboardingStepShell,
  StepFooter,
  StepHeading,
} from "../components/onboarding/OnboardingStepShell"
import { GitHubAppSetupCard } from "../components/settings/providers/GitHubAppSetupCard"
import {
  GitLabConfigForm,
  GitLabSetupHelp,
} from "../components/settings/providers/GitLabConfigForm"
import { requireMe } from "../lib/auth-guards"
import { useLogout } from "../lib/auth"
import { apiFetch } from "../lib/api"
import {
  getGitProviderStatus,
  useGitProviderStatus,
} from "../lib/git-providers"
import { useCreateGitHubAppFlow } from "../lib/github"
import { usePendingAction } from "../lib/hooks/use-pending-action"
import {
  gitLabOAuthErrorMessage,
  gitlabConnectUrl,
  useGitLabConfig,
  useSaveGitLabConfig,
} from "../lib/gitlab"
import { useRenameOrganization } from "../lib/organizations"
import {
  onboardingDashboardHref,
  rememberOnboardingDeploymentSource,
} from "../lib/onboarding"
import { apiBaseUrl } from "../lib/api/base"
import i18n from "../lib/i18n"
import type { GitProviderStatus } from "../lib/git-providers"
import type { OnboardingDeploymentSource } from "../lib/onboarding"
import type { Me } from "@ploydok/shared"

/** Every external round-trip started here is told to come back to this path. */
const RETURN_TO = "/onboarding"

type ProviderKey = "github" | "gitlab"

export const Route = createFileRoute("/onboarding")({
  beforeLoad: async (): Promise<{ me: Me; providers: GitProviderStatus }> => {
    const me = await requireMe()
    const providers = await getGitProviderStatus()
    return { me, providers }
  },
  component: OnboardingPage,
})

function resolveApiHref(
  value: string | null | undefined,
  returnTo: string
): string | null {
  if (!value) return null
  const base = apiBaseUrl()
  const absolute = /^https?:\/\//.test(value)
    ? new URL(value)
    : /^https?:\/\//.test(base)
      ? new URL(value, base)
      : null
  if (!absolute) {
    const joined = `${base.replace(/\/$/, "")}/${value.replace(/^\//, "")}`
    return `${joined}?return_to=${encodeURIComponent(returnTo)}`
  }
  absolute.searchParams.set("return_to", returnTo)
  return absolute.toString()
}

function OnboardingPage(): React.JSX.Element {
  const { me, providers: initialProviders } = Route.useRouteContext()
  const router = useRouter()
  const logout = useLogout()
  const statusQuery = useGitProviderStatus()
  const providers = statusQuery.data ?? initialProviders
  const [deploymentSource, setDeploymentSource] =
    React.useState<OnboardingDeploymentSource | null>(() => {
      if (typeof window === "undefined") return null
      const source = new URLSearchParams(window.location.search).get("source")
      return source === "github" || source === "gitlab" ? source : null
    })
  const oauthError =
    typeof window !== "undefined"
      ? gitLabOAuthErrorMessage(window.location.search)
      : null

  const connected = providers.github.connected || providers.gitlab.connected

  const refreshProviderStatus =
    React.useCallback(async (): Promise<GitProviderStatus> => {
      const result = await statusQuery.refetch()
      if (result.error) throw result.error
      if (!result.data)
        throw new Error(i18n.t("onboarding:provider.statusUnavailable"))
      return result.data
    }, [statusQuery])

  const onLogout = React.useCallback(() => {
    void logout.mutateAsync().finally(() => {
      void router.navigate({ to: "/login" })
    })
  }, [logout, router])

  if (connected || deploymentSource === "image") {
    const source =
      deploymentSource ??
      (providers.gitlab.connected && !providers.github.connected
        ? "gitlab"
        : "github")
    return <ProjectStep me={me} source={source} onLogout={onLogout} />
  }
  return (
    <ProviderStep
      me={me}
      providers={providers}
      onRefreshStatus={refreshProviderStatus}
      refreshing={statusQuery.isFetching}
      oauthError={oauthError}
      onUseImage={() => setDeploymentSource("image")}
      onLogout={onLogout}
    />
  )
}

// ---------------------------------------------------------------------------
// Step 1 — Git provider
// ---------------------------------------------------------------------------

function ProviderStep({
  me,
  providers,
  onRefreshStatus,
  refreshing,
  oauthError,
  onUseImage,
  onLogout,
}: {
  me: Me
  providers: GitProviderStatus
  onRefreshStatus: () => Promise<GitProviderStatus>
  refreshing: boolean
  oauthError: string | null
  onUseImage: () => void
  onLogout: () => void
}): React.JSX.Element {
  const { t } = useTranslation("onboarding")
  // Derived from the server on first render: when exactly one provider is
  // already configured, the choice has effectively been made for the user.
  const preselected: ProviderKey | null = providers.github.configured
    ? providers.gitlab.configured
      ? null
      : "github"
    : providers.gitlab.configured
      ? "gitlab"
      : null
  const [selected, setSelected] = React.useState<ProviderKey | null>(
    preselected
  )
  const [checkError, setCheckError] = React.useState<string | null>(null)
  const [checking, setChecking] = React.useState(false)

  if (selected === null) {
    return (
      <OnboardingStepShell activeStep="provider" onLogout={onLogout}>
        <div className="flex flex-col gap-8">
          {oauthError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {oauthError}
            </div>
          ) : null}
          <StepHeading
            title={t("provider.welcome", { name: me.display_name })}
            description={t("provider.welcomeHint")}
          />

          <fieldset>
            <legend className="text-sm font-medium">
              {t("provider.chooseSource")}
            </legend>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("provider.chooseSourceHint")}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <ProviderChoice
                name={t("provider.github")}
                maturity={t("provider.beta")}
                description={t("provider.githubDesc")}
                icon={RiGithubFill}
                configured={providers.github.configured}
                onSelect={() => setSelected("github")}
              />
              <ProviderChoice
                name={t("provider.gitlab")}
                maturity={t("provider.beta")}
                description={t("provider.gitlabDesc")}
                icon={RiGitlabFill}
                iconClassName="text-[#fc6d26]"
                configured={providers.gitlab.configured}
                onSelect={() => setSelected("gitlab")}
              />
              <ProviderChoice
                name={t("provider.imageName")}
                maturity={t("provider.beta")}
                description={t("provider.imageDesc")}
                icon={RiBox3Line}
                status={t("provider.noGitRequired")}
                onSelect={onUseImage}
              />
            </div>
          </fieldset>
        </div>

        <StepFooter hint={t("provider.pickHint")}>
          <EncryptionNote />
        </StepFooter>
      </OnboardingStepShell>
    )
  }

  const provider = providers[selected]
  const back = (): void => setSelected(null)

  if (!provider.configured) {
    return (
      <OnboardingStepShell
        activeStep="provider"
        onBack={back}
        onLogout={onLogout}
      >
        <div className="flex flex-col gap-8">
          {oauthError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {oauthError}
            </div>
          ) : null}
          <StepHeading
            title={
              selected === "github"
                ? t("provider.setupGithub")
                : t("provider.setupGitlab")
            }
            description={t("provider.setupHint")}
          />
          {me.is_instance_admin ? (
            selected === "github" ? (
              <GitHubSetupStep onConfigured={onRefreshStatus} />
            ) : (
              <GitLabSetupStep onConfigured={onRefreshStatus} />
            )
          ) : (
            <WaitingForAdmin
              onRefresh={onRefreshStatus}
              refreshing={refreshing}
            />
          )}
        </div>

        <StepFooter
          hint={
            me.is_instance_admin
              ? t("provider.adminHint")
              : t("provider.waitingHint")
          }
        >
          <EncryptionNote />
        </StepFooter>
      </OnboardingStepShell>
    )
  }

  const href =
    selected === "github"
      ? resolveApiHref(providers.github.install_url, RETURN_TO)
      : gitlabConnectUrl({ returnTo: RETURN_TO })

  const handleCheckAgain = async (): Promise<void> => {
    setCheckError(null)
    setChecking(true)
    try {
      if (selected === "github") {
        await apiFetch("/github/installations/reconnect", { method: "POST" })
      }
      const refreshed = await onRefreshStatus()
      if (!refreshed[selected].connected) {
        throw new Error(t("provider.configuredNotConnected"))
      }
    } catch (error) {
      setCheckError(
        error instanceof Error
          ? error.message
          : t("provider.verifyFailed")
      )
    } finally {
      setChecking(false)
    }
  }

  return (
    <OnboardingStepShell
      activeStep="provider"
      onBack={back}
      onLogout={onLogout}
    >
      <div className="flex flex-col gap-8">
        {oauthError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {oauthError}
          </div>
        ) : null}
        <StepHeading
          title={
            selected === "github"
              ? t("provider.connectGithub")
              : t("provider.connectGitlab")
          }
          description={
            selected === "github"
              ? t("provider.connectGithubHint")
              : t("provider.connectGitlabHint")
          }
        />

        <div className="flex flex-col gap-3">
          {/* A real navigation: the API sets a signed state cookie, then 302s
              to the provider. Going through fetch would silently follow it. */}
          <Button asChild size="sm" className="w-fit gap-2" disabled={!href}>
            <a href={href ?? "#"}>
              {selected === "github"
                ? t("provider.installGithub")
                : t("provider.authorizeGitlab")}
              <RiArrowRightLine className="size-4" />
            </a>
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("provider.redirectHint", {
              host: selected === "github" ? "github.com" : "gitlab.com",
            })}
          </p>
        </div>
      </div>

      <StepFooter hint={t("provider.alreadyInstalled")}>
        {checkError ? (
          <p className="text-sm text-destructive" role="alert">
            {checkError}
          </p>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit gap-2"
          onClick={() => void handleCheckAgain()}
          loading={checking || refreshing}
        >
          {!checking && !refreshing && <RiRefreshLine className="size-3.5" />}
          {checking || refreshing
            ? t("provider.checking")
            : t("provider.checkAgain")}
        </Button>
        <EncryptionNote />
      </StepFooter>
    </OnboardingStepShell>
  )
}

function GitHubSetupStep({
  onConfigured,
}: {
  onConfigured: () => void | Promise<GitProviderStatus>
}): React.JSX.Element {
  const createApp = useCreateGitHubAppFlow(RETURN_TO)

  return (
    <div className="rounded-2xl bg-panel p-5">
      <GitHubAppSetupCard
        isPending={createApp.isPending}
        onCreate={() => void createApp.start()}
        onImported={onConfigured}
        error={createApp.error}
      />
    </div>
  )
}

function GitLabSetupStep({
  onConfigured,
}: {
  onConfigured: () => void | Promise<GitProviderStatus>
}): React.JSX.Element {
  const { data: config } = useGitLabConfig()
  const save = useSaveGitLabConfig()

  return (
    <div className="flex flex-col gap-3">
      <GitLabConfigForm
        onSave={async (values) => {
          await save.mutateAsync(values)
          onConfigured()
        }}
        pending={save.isPending}
      />
      <GitLabSetupHelp callbackUrl={config?.callback_url} />
    </div>
  )
}

function WaitingForAdmin({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void | Promise<GitProviderStatus>
  refreshing: boolean
}): React.JSX.Element {
  const { t } = useTranslation("onboarding")
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl bg-panel p-5">
      <p className="text-sm">{t("provider.waitingAdmin")}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("provider.waitingAdminHint")}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={onRefresh}
        loading={refreshing}
      >
        {!refreshing && <RiRefreshLine className="size-3.5" />}
        {refreshing ? t("provider.checking") : t("provider.checkAgain")}
      </Button>
    </div>
  )
}

function ProviderChoice({
  name,
  maturity,
  description,
  icon: Icon,
  iconClassName,
  configured,
  status,
  onSelect,
}: {
  name: string
  maturity: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  iconClassName?: string
  configured?: boolean
  status?: string
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation("onboarding")
  return (
    <ChoiceCard selected={false} className="items-start gap-3 p-0">
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 text-muted-foreground",
            iconClassName
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-sm font-medium">
            {name}
            <span className="rounded-full border border-border px-1.5 py-0.5 font-sans text-[9px] tracking-wide text-muted-foreground uppercase">
              {maturity}
            </span>
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            {description}
          </span>
          <span className="mt-1.5 block text-xs text-muted-foreground">
            {status ??
              (configured
                ? t("provider.readyToConnect")
                : t("provider.needsSetup"))}
          </span>
        </span>
        <RiArrowRightLine
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
      </button>
    </ChoiceCard>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — Name the workspace
// ---------------------------------------------------------------------------

/** Mirrors slugifyOrganizationName on the API so the preview does not lie. */
function previewSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug || "workspace"
}

function ProjectStep({
  me,
  source,
  onLogout,
}: {
  me: Me
  source: OnboardingDeploymentSource
  onLogout: () => void
}): React.JSX.Element {
  const { t } = useTranslation("onboarding")
  const router = useRouter()
  const organization = me.default_organization
  const rename = useRenameOrganization()
  const [name, setName] = React.useState(organization?.name ?? "")

  const goToDashboard = React.useCallback(
    async (slug: string | undefined): Promise<void> => {
      rememberOnboardingDeploymentSource(me.id, source)
      await router.navigate({
        href: onboardingDashboardHref(slug, source),
      })
    },
    [me.id, router, source]
  )

  const trimmed = name.trim()
  const unchanged = trimmed === (organization?.name ?? "")

  // Both paths end in a navigation, so the pending flag has to cover it. The
  // no-rename path has no mutation at all: without this it navigates with zero
  // feedback.
  const submit = usePendingAction(async () => {
    if (!organization || unchanged) {
      await goToDashboard(organization?.slug)
      return
    }
    const result = await rename.mutateAsync({
      slug: organization.slug,
      name: trimmed,
      reslug: true,
    })
    await goToDashboard(result.organization.slug)
  })
  const skip = usePendingAction(() => goToDashboard(organization?.slug))
  const busy = submit.pending || skip.pending
  const canSubmit = trimmed.length > 0 && !busy

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    try {
      await submit.run()
    } catch {
      // rename.error carries the message.
    }
  }

  return (
    <OnboardingStepShell activeStep="project" onLogout={onLogout}>
      <form
        className="flex flex-col"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <div className="flex flex-col gap-8">
          <StepHeading
            title={t("project.title")}
            description={t("project.subtitle")}
          />

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium" htmlFor="workspace-name">
              {t("project.name")}
            </label>
            <Input
              id="workspace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Acme"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              {t("project.url")}{" "}
              <code className="font-mono">
                /orgs/
                {unchanged
                  ? (organization?.slug ?? "workspace")
                  : previewSlug(trimmed)}
              </code>
            </p>
            {rename.error ? (
              <p className="text-sm text-destructive" role="alert">
                {rename.error.message}
              </p>
            ) : null}
          </div>

          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <RiCheckLine aria-hidden className="size-3.5" />
            {source === "image"
              ? t("project.imageSelected")
              : source === "gitlab"
                ? t("project.gitlabConnected")
                : t("project.githubConnected")}
          </p>
        </div>

        <StepFooter hint={t("project.renameHint")}>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              loading={submit.pending}
              disabled={!canSubmit}
            >
              {submit.pending ? t("project.saving") : t("project.continue")}
              {!submit.pending && <RiArrowRightLine className="size-4" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void skip.run()}
              loading={skip.pending}
              disabled={submit.pending}
            >
              {t("project.skip")}
            </Button>
          </div>
        </StepFooter>
      </form>
    </OnboardingStepShell>
  )
}

function EncryptionNote(): React.JSX.Element {
  const { t } = useTranslation("onboarding")
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <RiLock2Line aria-hidden className="size-3.5" />
      {t("provider.encrypted")}
    </p>
  )
}
