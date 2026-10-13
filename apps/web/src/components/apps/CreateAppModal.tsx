// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  RiAddLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiGitBranchLine,
  RiGithubFill,
  RiGitlabFill,
  RiInformationLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Input } from "@workspace/ui/components/input"
import { Switch } from "@workspace/ui/components/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useTranslation } from "react-i18next"
import i18n from "../../lib/i18n"
import { cn } from "@workspace/ui/lib/utils"
import { PLANS } from "@ploydok/shared"
import { useCreateApp } from "../../lib/apps"
import { apiFetch } from "../../lib/api"
import {
  useCreateDatabase,
  useDatabases,
  useLinkDatabase,
} from "../../lib/databases"
import {
  DEFAULT_DATABASE_ENV_PREFIX,
  databaseEnvImportOmittedKeys,
  databaseEnvKeys,
  databaseEnvKeysForPrefix,
} from "../../lib/database-env"
import { useGitHubBranches } from "../../lib/github"
import { useGitLabBranches } from "../../lib/gitlab"
import {
  getGitLabSourceAvailability,
  useGitProviderStatus,
} from "../../lib/git-providers"
import {
  detectedEnvFiles,
  importEnvFileVars,
  useStackClassification,
} from "../../lib/stack-classifier-hook"
import { useRegistryCredentials } from "../../lib/registry-credentials"
import { RepoSelector } from "./RepoSelector"
import { GitLabRepoSelector } from "./GitLabRepoSelector"
import { PlanSelector } from "./PlanSelector"
import type { ApiError } from "../../lib/api"
import type { Database, DbKind, DbPlan } from "../../lib/databases"
import type { PlanSelectorValue } from "./PlanSelector"
import type {
  AppConfig,
  BuildMethod,
  GitBranch,
  GitProviderKind,
  GitRepo,
  ImagePullPolicy,
  ProbeResults,
  StackClassification,
} from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateAppModalProps {
  open: boolean
  initialSource?: SourceKind | undefined
  organizationId?: string
  onClose: () => void
  onCreated?: (appId: string) => void | Promise<void>
}

type SourceKind = GitProviderKind
type StepId = "source" | "build" | "env" | "database" | "resources"

interface InitialEnvVar {
  id: string
  key: string
  value: string
  phase: "runtime" | "build" | "both"
}

type DatabaseMode = "none" | "existing" | "new"

interface DatabaseSelection {
  mode: DatabaseMode
  existingDatabaseId: string
  newDatabaseName: string
  newDatabaseKind: DbKind
  newDatabasePlan: DbPlan
  envPrefix: string
}

export interface FormState {
  name: string
  source: SourceKind
  selectedRepo: GitRepo | null
  branch: string
  imageRef: string
  imagePullPolicy: ImagePullPolicy
  registryCredentialId: string
  trackLatest: boolean
  buildMethod: BuildMethod
  buildMethodTouched: boolean
  rootDir: string
  dockerfilePath: string
  installCommand: string
  buildCommand: string
  startCommand: string
  staticOutputDir: string
  staticSpaFallback: boolean
  watchPaths: string
  healthcheckPath: string
  healthcheckPort: string
  laravelSeedOnFirstDeploy: boolean
  initialEnvVars: Array<InitialEnvVar>
  database: DatabaseSelection
  plan: PlanSelectorValue
  domainSuffix: string
  createRequestId: string
}

const INITIAL_FORM: FormState = {
  name: "",
  source: "github",
  selectedRepo: null,
  branch: "",
  imageRef: "",
  imagePullPolicy: "always",
  registryCredentialId: "",
  trackLatest: false,
  buildMethod: "auto",
  buildMethodTouched: false,
  rootDir: "",
  dockerfilePath: "",
  installCommand: "",
  buildCommand: "",
  startCommand: "",
  staticOutputDir: "dist",
  staticSpaFallback: true,
  watchPaths: "",
  healthcheckPath: "/",
  healthcheckPort: "",
  laravelSeedOnFirstDeploy: false,
  initialEnvVars: [],
  database: {
    mode: "none",
    existingDatabaseId: "",
    newDatabaseName: "",
    newDatabaseKind: "postgres",
    newDatabasePlan: "small",
    envPrefix: DEFAULT_DATABASE_ENV_PREFIX,
  },
  plan: { plan: "small" },
  domainSuffix: "",
  createRequestId: "",
}

export function initialForm(source: SourceKind | undefined): FormState {
  return {
    ...INITIAL_FORM,
    source: source ?? INITIAL_FORM.source,
    initialEnvVars: [],
    database: { ...INITIAL_FORM.database },
    plan: { ...INITIAL_FORM.plan },
  }
}

export function repoDerivedDefaults(): Partial<FormState> {
  return {
    buildMethod: "auto",
    buildMethodTouched: false,
    rootDir: "",
    dockerfilePath: "",
    installCommand: "",
    buildCommand: "",
    startCommand: "",
    staticOutputDir: "dist",
    staticSpaFallback: true,
    watchPaths: "",
    healthcheckPath: "/",
    healthcheckPort: "",
    laravelSeedOnFirstDeploy: false,
    initialEnvVars: [],
    database: { ...INITIAL_FORM.database },
  }
}

function formatBranchOption(branch: GitBranch): string {
  const shortSha = branch.commitSha ? branch.commitSha.slice(0, 8) : ""
  return shortSha ? `${branch.name} · ${shortSha}` : branch.name
}

interface DefaultDomainConfig {
  domainBase: string
  publicScheme: "http" | "https"
  publicPort: number | null
}

function useDefaultDomainConfig(enabled: boolean) {
  return useQuery({
    queryKey: ["apps", "default-domain-config"],
    queryFn: () => apiFetch<DefaultDomainConfig>("/apps/default-domain-config"),
    enabled,
    staleTime: 60_000,
  })
}

function randomDomainSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = new Uint8Array(8)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}

function randomCreateRequestId(): string {
  return `create-${Date.now().toString(36)}-${randomDomainSuffix()}${randomDomainSuffix()}`
}

function previewSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "app"
  )
}

function buildGeneratedDomain(
  form: FormState,
  config: DefaultDomainConfig | undefined
): string {
  if (!config?.domainBase) return ""
  const suffix = form.domainSuffix || "preview"
  const maxSlugLength = Math.max(1, 63 - suffix.length - 1)
  const label = `${previewSlug(form.name).slice(0, maxSlugLength)}-${suffix}`
  return `${label}.${config.domainBase}`
}

function buildGeneratedPublicUrl(
  domain: string,
  config: DefaultDomainConfig | undefined
): string {
  if (!domain || !config) return ""
  const port =
    config.publicPort &&
    !(
      (config.publicScheme === "http" && config.publicPort === 80) ||
      (config.publicScheme === "https" && config.publicPort === 443)
    )
      ? `:${config.publicPort}`
      : ""
  return `${config.publicScheme}://${domain}${port}`
}

// ---------------------------------------------------------------------------
// CreateAppModal
// ---------------------------------------------------------------------------

export function CreateAppModal({
  open,
  initialSource,
  organizationId,
  onClose,
  onCreated,
}: CreateAppModalProps): React.JSX.Element | null {
  const { t } = useTranslation("apps")
  const [stepIdx, setStepIdx] = React.useState(0)
  const [form, setForm] = React.useState<FormState>(() =>
    initialForm(initialSource)
  )
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [branchDialogOpen, setBranchDialogOpen] = React.useState(false)
  const [pendingBranch, setPendingBranch] = React.useState("")
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [submitInFlight, setSubmitInFlight] = React.useState(false)
  const submitInFlightRef = React.useRef(false)
  const createApp = useCreateApp()
  const createDatabase = useCreateDatabase()
  const linkDatabase = useLinkDatabase()
  const defaultDomainConfig = useDefaultDomainConfig(open)
  const providerStatus = useGitProviderStatus()
  const gitLabAvailability = getGitLabSourceAvailability(providerStatus.data, {
    loading: providerStatus.isLoading,
    failed: providerStatus.isError,
  })

  const steps: Array<{ id: StepId; label: string; hint: string }> =
    form.source === "image"
      ? [
          {
            id: "source",
            label: t("create.steps.source"),
            hint: t("create.hints.sourceImage"),
          },
          {
            id: "database",
            label: t("create.steps.database"),
            hint: t("create.hints.database"),
          },
          {
            id: "env",
            label: t("create.steps.env"),
            hint: t("create.hints.env"),
          },
          {
            id: "resources",
            label: t("create.steps.resources"),
            hint: t("create.hints.resources"),
          },
        ]
      : [
          {
            id: "source",
            label: t("create.steps.source"),
            hint: t("create.hints.sourceGit"),
          },
          {
            id: "build",
            label: t("create.steps.build"),
            hint: t("create.hints.build"),
          },
          {
            id: "database",
            label: t("create.steps.database"),
            hint: t("create.hints.database"),
          },
          {
            id: "env",
            label: t("create.steps.env"),
            hint: t("create.hints.env"),
          },
          {
            id: "resources",
            label: t("create.steps.resources"),
            hint: t("create.hints.resources"),
          },
        ]

  const currentStep = steps[stepIdx]?.id ?? "source"
  const totalSteps = steps.length

  const {
    data: ghBranches,
    isLoading: ghBranchesLoading,
    error: ghBranchesError,
  } = useGitHubBranches(
    form.source === "github" ? form.selectedRepo?.fullName : undefined
  )
  const {
    data: glBranches,
    isLoading: glBranchesLoading,
    error: glBranchesError,
  } = useGitLabBranches(
    form.source === "gitlab" ? form.selectedRepo?.fullName : undefined
  )

  const classifierSource =
    form.source === "github" || form.source === "gitlab"
      ? form.source
      : undefined
  const classifier = useStackClassification(
    classifierSource,
    classifierSource ? form.selectedRepo?.fullName : undefined,
    form.branch || undefined,
    form.rootDir || undefined
  )
  const classification = classifier.data ?? null
  const recommendedBuild = classification?.recommendedBuild
  const hasDockerfile =
    recommendedBuild === undefined ? null : recommendedBuild === "dockerfile"
  const detectionLoading = classifier.isFetching
  const { data: databases, isLoading: databasesLoading } = useDatabases(
    organizationId,
    { enabled: open && (currentStep === "database" || currentStep === "env") }
  )

  const branches: Array<GitBranch> =
    form.source === "github"
      ? (ghBranches?.branches ?? [])
      : form.source === "gitlab"
        ? (glBranches?.branches ?? [])
        : []
  // The GitHub App is installed nowhere: the repo picker still lists cached
  // repos, but no branch can be read for any of them.
  const branchesNeedInstall =
    form.source === "github"
      ? (ghBranches?.needsInstall ?? false)
      : form.source === "gitlab"
        ? (glBranches?.needsInstall ?? false)
        : false
  const branchesLoading =
    form.source === "github"
      ? ghBranchesLoading
      : form.source === "gitlab"
        ? glBranchesLoading
        : false
  // Without this, a failed branch fetch leaves an empty picker and a disabled
  // "Continuer" with nothing on screen explaining why.
  const branchesError: ApiError | null =
    form.source === "github"
      ? ghBranchesError
      : form.source === "gitlab"
        ? glBranchesError
        : null
  const generatedDomain = buildGeneratedDomain(form, defaultDomainConfig.data)
  const generatedPublicUrl = buildGeneratedPublicUrl(
    generatedDomain,
    defaultDomainConfig.data
  )
  const isSubmitting =
    submitInFlight ||
    createApp.isPending ||
    createDatabase.isPending ||
    linkDatabase.isPending
  const requestClose = React.useCallback(() => {
    if (submitInFlightRef.current) return
    onClose()
  }, [onClose])

  React.useEffect(() => {
    if (!open) {
      setStepIdx(0)
      setForm(initialForm(initialSource))
      setShowAdvanced(false)
      setBranchDialogOpen(false)
      setPendingBranch("")
      setSubmitError(null)
      setSubmitInFlight(false)
      submitInFlightRef.current = false
    }
  }, [open, initialSource])

  React.useEffect(() => {
    if (!open) return
    setForm((prev) => ({
      ...prev,
      domainSuffix: prev.domainSuffix || randomDomainSuffix(),
      createRequestId: prev.createRequestId || randomCreateRequestId(),
    }))
  }, [open])

  React.useEffect(() => {
    if (!branchDialogOpen || branches.length === 0) return
    setPendingBranch((current) => {
      if (branches.some((candidate) => candidate.name === current)) {
        return current
      }
      const repoDefault = form.selectedRepo?.defaultBranch
      return (
        branches.find((candidate) => candidate.name === repoDefault)?.name ??
        branches[0].name
      )
    })
  }, [branchDialogOpen, branches, form.selectedRepo?.defaultBranch])

  React.useEffect(() => {
    if (recommendedBuild === undefined) return
    setForm((prev) => {
      if (prev.buildMethodTouched) return prev
      const next: BuildMethod =
        recommendedBuild === "dockerfile"
          ? "docker"
          : recommendedBuild === "static"
            ? "static"
            : "nixpacks"
      if (prev.buildMethod === next) return prev
      return { ...prev, buildMethod: next }
    })
  }, [recommendedBuild])

  React.useEffect(() => {
    if (classification?.stack !== "symfony") return
    setForm((prev) => {
      const existing = new Set(prev.initialEnvVars.map((item) => item.key))
      const additions: Array<InitialEnvVar> = []
      if (!existing.has("APP_ENV")) {
        additions.push({
          id: "suggested-app-env",
          key: "APP_ENV",
          value: "prod",
          phase: "runtime",
        })
      }
      if (!existing.has("APP_DEBUG")) {
        additions.push({
          id: "suggested-app-debug",
          key: "APP_DEBUG",
          value: "0",
          phase: "runtime",
        })
      }
      if (additions.length === 0) return prev
      return { ...prev, initialEnvVars: [...prev.initialEnvVars, ...additions] }
    })
  }, [classification?.stack])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !branchDialogOpen) requestClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, requestClose, branchDialogOpen])

  if (!open) return null

  const setField = <TKey extends keyof FormState>(
    key: TKey,
    value: FormState[TKey]
  ): void => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSourceChange = (source: SourceKind): void => {
    setForm((prev) => ({
      ...prev,
      source,
      selectedRepo: null,
      branch: "",
      ...repoDerivedDefaults(),
      domainSuffix: prev.domainSuffix || randomDomainSuffix(),
    }))
    setBranchDialogOpen(false)
    setPendingBranch("")
    if (stepIdx > 0) setStepIdx(0)
  }

  const handleRepoSelect = (repo: GitRepo): void => {
    const sameRepo = form.selectedRepo?.fullName === repo.fullName
    setForm((prev) => ({
      ...prev,
      selectedRepo: repo,
      branch: sameRepo ? prev.branch : "",
      name: prev.name || (repo.fullName.split("/").at(-1) ?? ""),
      ...(sameRepo ? {} : repoDerivedDefaults()),
    }))
    if (form.source === "github" || form.source === "gitlab") {
      setPendingBranch(sameRepo ? form.branch : repo.defaultBranch)
      setBranchDialogOpen(true)
    }
  }

  const openBranchDialog = (): void => {
    setPendingBranch(form.branch || form.selectedRepo?.defaultBranch || "")
    setBranchDialogOpen(true)
  }

  const confirmBranch = (): void => {
    if (!branches.some((candidate) => candidate.name === pendingBranch)) return
    setForm((prev) => ({
      ...prev,
      branch: pendingBranch,
      ...(prev.branch === pendingBranch ? {} : repoDerivedDefaults()),
    }))
    setBranchDialogOpen(false)
  }

  const canGoNext = (): boolean => {
    if (currentStep === "source") {
      if (form.name.trim().length === 0) return false
      if (form.source === "image") return form.imageRef.trim().length > 0
      return form.selectedRepo !== null && form.branch.length > 0
    }
    if (currentStep === "env")
      return validateInitialEnvVars(form.initialEnvVars)
    if (currentStep === "build") {
      if (detectionLoading) return false
      if (
        classification?.requiresExplicitBuildChoice &&
        !form.buildMethodTouched
      ) {
        return false
      }
    }
    if (currentStep === "database") {
      if (!/^[A-Z0-9_]+$/.test(form.database.envPrefix)) return false
      if (form.database.mode === "existing") {
        return form.database.existingDatabaseId.length > 0
      }
      if (form.database.mode === "new") {
        return /^[a-z0-9-]+$/.test(form.database.newDatabaseName.trim())
      }
    }
    return true
  }

  const handleRootDirChange = (rootDir: string): void => {
    setForm((prev) =>
      prev.rootDir === rootDir
        ? prev
        : {
            ...prev,
            ...repoDerivedDefaults(),
            rootDir,
          }
    )
  }

  const handleSubmit = async (): Promise<void> => {
    if (submitInFlightRef.current) return
    submitInFlightRef.current = true
    setSubmitInFlight(true)
    setSubmitError(null)
    try {
      const requestId = form.createRequestId || randomCreateRequestId()
      const body = buildCreateAppBody(form, organizationId, generatedDomain)
      body.idempotencyKey = `${requestId}:app`
      const databaseId = await resolveDatabaseForCreate({
        form,
        organizationId,
        createDatabase: createDatabase.mutateAsync,
        idempotencyKey: `${requestId}:database`,
      })
      if (databaseId) {
        body.initialDatabaseLink = {
          databaseId,
          envPrefix: form.database.envPrefix,
        }
      }
      const created = await createApp.mutateAsync(body as Partial<AppConfig>)
      const appId = readCreatedAppId(created)
      if (databaseId && appId && !body.initialDatabaseLink) {
        await linkDatabase.mutateAsync({
          appId,
          databaseId,
          env_prefix: form.database.envPrefix,
        })
      }
      if (appId && onCreated) {
        await onCreated(appId)
        return
      }
      onClose()
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : t("create.failed")
      )
    } finally {
      submitInFlightRef.current = false
      setSubmitInFlight(false)
    }
  }

  const isLast = stepIdx === totalSteps - 1

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={requestClose}
        aria-hidden="true"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-app-title"
        className={cn(
          "fixed inset-x-2 top-1/2 z-50 -translate-y-1/2",
          "sm:inset-x-auto sm:left-1/2 sm:w-full sm:max-w-[min(94vw,84rem)] sm:-translate-x-1/2",
          "rounded-2xl border border-border bg-background shadow-2xl",
          "flex h-[92vh] flex-col overflow-hidden sm:h-[88vh]",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        )}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <span className="text-sm font-semibold">+</span>
            </div>
            <div>
              <h2
                id="create-app-title"
                className="text-base leading-none font-semibold"
              >
                {t("create.newApp")}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("create.stepOf", {
                  current: stepIdx + 1,
                  total: totalSteps,
                })}{" "}
                · {steps[stepIdx]?.hint}
              </p>
            </div>
          </div>
          <button
            onClick={requestClose}
            disabled={isSubmitting}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t("create.closeWindow")}
          >
            <RiCloseLine className="size-5" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 md:grid-cols-[220px_1fr]">
          <aside className="hidden min-h-0 overflow-y-auto border-r border-border bg-muted/30 p-4 md:block">
            <ol className="space-y-1">
              {steps.map((s, idx) => {
                const state =
                  idx < stepIdx ? "done" : idx === stepIdx ? "current" : "todo"
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (idx <= stepIdx) setStepIdx(idx)
                      }}
                      disabled={idx > stepIdx || isSubmitting}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors",
                        state === "current" &&
                          "bg-background shadow-sm ring-1 ring-border",
                        state === "done" &&
                          "cursor-pointer hover:bg-background/60",
                        state === "todo" && "cursor-not-allowed opacity-60"
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                          state === "current" &&
                            "border-primary bg-primary text-primary-foreground",
                          state === "done" &&
                            "border-primary/40 bg-primary/10 text-primary",
                          state === "todo" &&
                            "border-border text-muted-foreground"
                        )}
                      >
                        {state === "done" ? (
                          <RiCheckLine className="size-3" />
                        ) : (
                          idx + 1
                        )}
                      </span>
                      <span className="flex flex-col">
                        <span className="text-sm leading-none font-medium">
                          {s.label}
                        </span>
                        <span className="mt-1 text-[11px] text-muted-foreground">
                          {s.hint}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>

            <div className="my-4 h-px bg-border" />

            <SummaryCard form={form} />
          </aside>

          <div className="flex min-h-0 flex-col">
            <div
              key={currentStep}
              className="min-h-0 flex-1 overflow-y-auto p-4 motion-safe:animate-in motion-safe:duration-200 motion-safe:fade-in-0 motion-safe:slide-in-from-right-2 sm:p-6"
            >
              {currentStep === "source" && (
                <SourceStep
                  form={form}
                  setField={setField}
                  onSourceChange={handleSourceChange}
                  onRepoSelect={handleRepoSelect}
                  branches={branches}
                  branchesLoading={branchesLoading}
                  branchesError={branchesError}
                  branchesNeedInstall={branchesNeedInstall}
                  generatedPublicUrl={generatedPublicUrl}
                  onOpenBranchDialog={openBranchDialog}
                  gitLabAvailability={gitLabAvailability}
                />
              )}
              {currentStep === "build" && (
                <BuildStep
                  form={form}
                  setField={setField}
                  showAdvanced={showAdvanced}
                  onToggleAdvanced={() => setShowAdvanced((v) => !v)}
                  hasDockerfile={hasDockerfile}
                  detectionLoading={detectionLoading}
                  classification={classification}
                  onRootDirChange={handleRootDirChange}
                />
              )}
              {currentStep === "resources" && (
                <ResourcesStep
                  form={form}
                  classification={classification}
                  value={form.plan}
                  onChange={(v) => setField("plan", v)}
                />
              )}
              {currentStep === "env" && (
                <EnvStep
                  vars={form.initialEnvVars}
                  onChange={(vars) => setField("initialEnvVars", vars)}
                  classification={classification}
                  probes={classifier.probes}
                  source={form.source}
                  repoFullName={form.selectedRepo?.fullName}
                  branch={form.branch}
                  rootDir={form.rootDir}
                  database={form.database}
                  databases={databases ?? []}
                />
              )}
              {currentStep === "database" && (
                <DatabaseStep
                  value={form.database}
                  onChange={(database) => setField("database", database)}
                  databases={databases ?? []}
                  isLoading={databasesLoading}
                />
              )}

              {submitError && (
                <div
                  role="alert"
                  className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                >
                  {submitError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/20 px-4 py-3 sm:gap-3 sm:px-6 sm:py-4">
              <Button
                variant="ghost"
                size="sm"
                onClick={
                  stepIdx === 0
                    ? requestClose
                    : () => setStepIdx((s) => Math.max(0, s - 1))
                }
                disabled={isSubmitting}
              >
                {stepIdx === 0 ? t("create.cancel") : t("common:previous")}
              </Button>
              <div className="flex items-center gap-3">
                <span className="hidden text-[11px] text-muted-foreground sm:inline">
                  {stepIdx + 1} / {totalSteps}
                </span>
                {!isLast ? (
                  <Button
                    size="sm"
                    onClick={() =>
                      setStepIdx((s) => Math.min(totalSteps - 1, s + 1))
                    }
                    disabled={!canGoNext()}
                    className="gap-1"
                  >
                    {t("create.continue")}
                    <RiArrowRightSLine className="size-4" />
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => void handleSubmit()}
                    loading={isSubmitting}
                    disabled={!canGoNext()}
                  >
                    {isSubmitting ? t("create.creating") : t("create.submit")}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <BranchSelectionDialog
        open={branchDialogOpen}
        providerLabel={form.source === "gitlab" ? "GitLab" : "GitHub"}
        repo={
          form.source === "github" || form.source === "gitlab"
            ? form.selectedRepo
            : null
        }
        branches={branches}
        value={pendingBranch}
        isLoading={branchesLoading}
        error={branchesError}
        needsInstall={branchesNeedInstall}
        onValueChange={setPendingBranch}
        onConfirm={confirmBranch}
        onOpenChange={setBranchDialogOpen}
      />
    </>
  )
}

interface BranchSelectionDialogProps {
  open: boolean
  providerLabel: "GitHub" | "GitLab"
  repo: GitRepo | null
  branches: Array<GitBranch>
  value: string
  isLoading: boolean
  error: ApiError | null
  needsInstall: boolean
  onValueChange: (branch: string) => void
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}

export function BranchSelectionDialog({
  open,
  providerLabel,
  repo,
  branches,
  value,
  isLoading,
  error,
  needsInstall,
  onValueChange,
  onConfirm,
  onOpenChange,
}: BranchSelectionDialogProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [search, setSearch] = React.useState("")

  React.useEffect(() => {
    if (open) setSearch("")
  }, [open, repo?.fullName])

  const normalizedSearch = search.trim().toLowerCase()
  const visibleBranches = normalizedSearch
    ? branches.filter((branch) =>
        branch.name.toLowerCase().includes(normalizedSearch)
      )
    : branches
  const canConfirm = branches.some((branch) => branch.name === value)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(42rem,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RiGitBranchLine className="size-5 text-primary" />
            {t("create.chooseBranch")}
          </DialogTitle>
          <DialogDescription>
            {repo ? (
              <>
                {t("create.selectBranchFor")}{" "}
                <strong className="font-medium text-foreground">
                  {repo.fullName}
                </strong>
                .
              </>
            ) : (
              t("create.selectProjectFirst", { provider: providerLabel })
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-3">
          {!isLoading && !error && !needsInstall && branches.length > 0 && (
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("create.searchBranch")}
              aria-label={t("create.searchBranchAria")}
              autoFocus
            />
          )}

          {isLoading ? (
            <div className="space-y-2" aria-label={t("create.loadingBranches")}>
              {[0, 1, 2, 3].map((item) => (
                <div
                  key={item}
                  className="h-11 w-full skeleton-surface rounded-md"
                />
              ))}
            </div>
          ) : error ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {repo
                ? t("create.loadBranchesFailedFor", {
                    repo: repo.fullName,
                    message: error.message,
                  })
                : `${t("create.loadBranchesFailed")} : ${error.message}`}
            </p>
          ) : needsInstall ? (
            <p
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
              role="alert"
            >
              {t("create.githubAppRequired")}{" "}
              <a
                href="/settings/git-providers/github"
                className="font-medium underline underline-offset-2"
              >
                {t("create.installGitHubApp")}
              </a>
              .
            </p>
          ) : branches.length === 0 ? (
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground"
              role="status"
            >
              {t("create.noBranches")}
            </p>
          ) : visibleBranches.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("create.noBranchMatch", { query: search.trim() })}
            </p>
          ) : (
            <ul
              className="scrollbar-thin max-h-[24rem] divide-y divide-border overflow-y-auto rounded-lg border border-border"
              role="listbox"
              aria-label={t("create.branchesAria", { provider: providerLabel })}
            >
              {visibleBranches.map((branch) => {
                const selected = branch.name === value
                return (
                  <li key={branch.name} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:-outline-offset-2 focus-visible:outline-none",
                        selected && "bg-primary/10"
                      )}
                      onClick={() => onValueChange(branch.name)}
                    >
                      <RiGitBranchLine className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {branch.name}
                      </span>
                      {branch.commitSha && (
                        <code className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {branch.commitSha.slice(0, 8)}
                        </code>
                      )}
                      {selected && (
                        <RiCheckLine className="size-4 shrink-0 text-primary" />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("create.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={!canConfirm}>
            {t("create.chooseThisBranch")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Sidebar — live summary
// ---------------------------------------------------------------------------

function SummaryCard({ form }: { form: FormState }): React.JSX.Element {
  const { t } = useTranslation("apps")
  const sourceLabel: Record<SourceKind, string> = {
    github: t("create.github"),
    gitlab: t("create.gitlab"),
    image: t("create.ociImage"),
  }
  const envCount = form.initialEnvVars.filter((item) => item.key.trim()).length
  const databaseValue =
    form.database.mode === "none"
      ? "—"
      : form.database.mode === "existing"
        ? t("create.existingValue")
        : form.database.newDatabaseName || t("create.newValue")
  const buildValue =
    form.buildMethod === "auto"
      ? t("create.auto")
      : form.buildMethod === "docker"
        ? t("create.dockerfile")
        : form.buildMethod === "static"
          ? t("create.staticSite")
          : t("create.nixpacks")

  return (
    <div className="space-y-2.5">
      <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {t("create.summaryTitle")}
      </p>
      <SummaryRow
        label={t("create.name")}
        value={form.name || "—"}
        mono={!!form.name}
      />
      <SummaryRow label={t("create.source")} value={sourceLabel[form.source]} />
      {form.source !== "image" && (
        <>
          <SummaryRow
            label={t("create.repo")}
            value={form.selectedRepo?.fullName ?? "—"}
            mono={!!form.selectedRepo}
            truncate
          />
          <SummaryRow
            label={t("create.branch")}
            value={form.branch || "—"}
            mono={!!form.branch}
          />
          <SummaryRow label={t("create.build")} value={buildValue} />
          {form.buildMethod === "static" && (
            <SummaryRow
              label={t("create.output")}
              value={form.staticOutputDir || "dist"}
              mono
            />
          )}
          {form.laravelSeedOnFirstDeploy && (
            <SummaryRow
              label={t("create.laravelRuntime")}
              value={t("create.firstDeploy")}
            />
          )}
          <SummaryRow
            label={t("create.steps.env")}
            value={t("create.varsCount", { count: envCount })}
          />
          <SummaryRow
            label={t("create.steps.database")}
            value={databaseValue}
          />
        </>
      )}
      {form.source === "image" && (
        <SummaryRow
          label={t("create.image")}
          value={form.imageRef || "—"}
          mono={!!form.imageRef}
          truncate
        />
      )}
      {form.source === "image" && (
        <SummaryRow
          label={t("create.steps.env")}
          value={t("create.varsCount", { count: envCount })}
        />
      )}
      {form.source === "image" && (
        <SummaryRow
          label={t("create.steps.database")}
          value={databaseValue}
        />
      )}
      <SummaryRow label={t("create.plan")} value={form.plan.plan} />
    </div>
  )
}

function SummaryRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string
  value: string
  mono?: boolean
  truncate?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right",
          mono && "font-mono text-[11px]",
          truncate && "truncate"
        )}
        title={truncate ? value : undefined}
      >
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 1 — Source (name + provider + repo/image + branch)
// ---------------------------------------------------------------------------

interface SourceStepProps {
  form: FormState
  setField: <TKey extends keyof FormState>(
    key: TKey,
    value: FormState[TKey]
  ) => void
  onSourceChange: (s: SourceKind) => void
  onRepoSelect: (repo: GitRepo) => void
  branches: Array<GitBranch>
  branchesLoading: boolean
  branchesError: ApiError | null
  branchesNeedInstall: boolean
  generatedPublicUrl: string
  onOpenBranchDialog: () => void
  gitLabAvailability: { enabled: boolean; reason: string | null }
}

function SourceStep({
  form,
  setField,
  onSourceChange,
  onRepoSelect,
  branches,
  branchesLoading,
  branchesError,
  branchesNeedInstall,
  generatedPublicUrl,
  onOpenBranchDialog,
  gitLabAvailability,
}: SourceStepProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const slug = form.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <label htmlFor="app-name" className="text-sm font-medium">
          {t("create.appName")}
        </label>
        <Input
          id="app-name"
          type="text"
          placeholder={t("create.namePlaceholder")}
          value={form.name}
          onChange={(e) => setField("name", e.target.value)}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          {slug ? (
            <>
              {t("create.internalUrl")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                {slug}
              </code>
            </>
          ) : (
            t("create.slugHint")
          )}
        </p>
      </section>

      <section className="space-y-2">
        <label htmlFor="app-public-url" className="text-sm font-medium">
          {t("create.publicUrl")}
        </label>
        <Input
          id="app-public-url"
          type="text"
          value={generatedPublicUrl || "…"}
          readOnly
          className="font-mono text-xs"
        />
      </section>

      <section className="space-y-2">
        <p className="text-sm font-medium">{t("create.source")}</p>
        <ProviderTabs
          source={form.source}
          onChange={onSourceChange}
          gitLabAvailability={gitLabAvailability}
        />
      </section>

      {form.source === "github" && (
        <GitSection
          providerLabel="GitHub"
          selectedRepo={form.selectedRepo}
          branch={form.branch}
          onBranchChange={(v) => setField("branch", v)}
          branches={branches}
          branchesLoading={branchesLoading}
          branchesError={branchesError}
          branchesNeedInstall={branchesNeedInstall}
          onOpenBranchDialog={onOpenBranchDialog}
        >
          <RepoSelector selected={form.selectedRepo} onSelect={onRepoSelect} />
        </GitSection>
      )}

      {form.source === "gitlab" && (
        <GitSection
          providerLabel="GitLab"
          selectedRepo={form.selectedRepo}
          branch={form.branch}
          onBranchChange={(v) => setField("branch", v)}
          branches={branches}
          branchesLoading={branchesLoading}
          branchesError={branchesError}
          branchesNeedInstall={branchesNeedInstall}
          onOpenBranchDialog={onOpenBranchDialog}
        >
          <GitLabRepoSelector
            selected={form.selectedRepo}
            onSelect={onRepoSelect}
            enabled={gitLabAvailability.enabled}
            unavailableReason={gitLabAvailability.reason}
          />
        </GitSection>
      )}

      {form.source === "image" && (
        <ImageSection
          imageRef={form.imageRef}
          onImageRefChange={(v) => setField("imageRef", v)}
          imagePullPolicy={form.imagePullPolicy}
          onImagePullPolicyChange={(v) => setField("imagePullPolicy", v)}
          registryCredentialId={form.registryCredentialId}
          onRegistryCredentialIdChange={(v) =>
            setField("registryCredentialId", v)
          }
          trackLatest={form.trackLatest}
          onTrackLatestChange={(v) => setField("trackLatest", v)}
        />
      )}
    </div>
  )
}

function ProviderTabs({
  source,
  onChange,
  gitLabAvailability,
}: {
  source: SourceKind
  onChange: (s: SourceKind) => void
  gitLabAvailability: { enabled: boolean; reason: string | null }
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [unavailableHintOpen, setUnavailableHintOpen] = React.useState(false)
  const tabs: Array<{
    id: SourceKind
    label: string
    hint: string
    maturity: "Beta"
    icon: React.JSX.Element
    disabled?: boolean
  }> = [
    {
      id: "github",
      label: t("create.github"),
      hint: t("create.autoDeployHint"),
      maturity: "Beta",
      icon: <RiGithubFill className="size-5" />,
    },
    {
      id: "gitlab",
      label: t("create.gitlab"),
      hint: t("create.autoDeployHint"),
      maturity: "Beta",
      icon: <RiGitlabFill className="size-5 text-[#FC6D26]" />,
      disabled: !gitLabAvailability.enabled,
    },
    {
      id: "image",
      label: t("create.image"),
      hint: t("create.dockerOci"),
      maturity: "Beta",
      icon: <DockerIcon className="size-5 text-[#1D63ED]" />,
    },
  ]

  return (
    <TooltipProvider delayDuration={200}>
      <div
        role="tablist"
        aria-label={t("create.source")}
        className="grid gap-2 sm:grid-cols-3"
      >
        {tabs.map((tab) => {
          const active = source === tab.id && !tab.disabled
          const disabled = Boolean(tab.disabled)
          const button = (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-disabled={disabled}
              onFocus={() => {
                if (disabled) setUnavailableHintOpen(true)
              }}
              onClick={(event) => {
                if (disabled) {
                  event.preventDefault()
                  setUnavailableHintOpen(true)
                } else onChange(tab.id)
              }}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg border p-3 text-left transition-all",
                disabled
                  ? "cursor-not-allowed border-border bg-muted/30 opacity-60"
                  : active
                    ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
                    : "border-border bg-card hover:border-primary/30 hover:bg-muted/40"
              )}
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-md border",
                  active
                    ? "border-primary/30 bg-background"
                    : "border-border bg-muted/40"
                )}
              >
                {tab.icon}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="text-sm leading-none font-medium">
                  {tab.label}
                </span>
                <span className="mt-1 truncate text-[11px] text-muted-foreground">
                  {tab.hint}
                </span>
              </span>
              <span className="ml-auto shrink-0 rounded-full border border-border bg-background px-1.5 py-0.5 font-sans text-[9px] tracking-wide text-muted-foreground uppercase">
                {tab.maturity}
              </span>
              {active ? (
                <RiCheckLine className="size-4 shrink-0 text-primary" />
              ) : null}
            </button>
          )
          return disabled && gitLabAvailability.reason ? (
            <Tooltip
              key={tab.id}
              open={unavailableHintOpen}
              onOpenChange={setUnavailableHintOpen}
            >
              <TooltipTrigger asChild>{button}</TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {gitLabAvailability.reason}
              </TooltipContent>
            </Tooltip>
          ) : (
            button
          )
        })}
      </div>
    </TooltipProvider>
  )
}

function GitSection({
  providerLabel,
  selectedRepo,
  branch,
  onBranchChange,
  branches,
  branchesLoading,
  branchesError,
  branchesNeedInstall,
  onOpenBranchDialog,
  children,
}: {
  providerLabel: string
  selectedRepo: GitRepo | null
  branch: string
  onBranchChange: (v: string) => void
  branches: Array<GitBranch>
  branchesLoading: boolean
  branchesError: ApiError | null
  branchesNeedInstall: boolean
  onOpenBranchDialog?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const selectedBranch = branches.find((b) => b.name === branch)
  const selectedCommitSha = selectedBranch?.commitSha ?? ""

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t("create.repoLabel", { provider: providerLabel })}
        </p>
        {children}
      </div>

      {selectedRepo && (
        <div className="space-y-1.5">
          {onOpenBranchDialog ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <RiGitBranchLine className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {t("create.branch")}
                  </p>
                  <p className="truncate text-sm font-medium">
                    {branch || t("create.noBranchSelected")}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onOpenBranchDialog}
              >
                {branch ? t("create.change") : t("create.choose")}
              </Button>
            </div>
          ) : branchesLoading ? (
            <div className="h-9 w-full skeleton-surface rounded-md" />
          ) : branchesError ? (
            <p
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {t("create.loadBranchesFailedFor", {
                repo: selectedRepo.fullName,
                message: branchesError.message,
              })}
            </p>
          ) : branchesNeedInstall ? (
            <p
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-foreground"
              role="alert"
            >
              {t("create.githubAppNotInstalled")}{" "}
              <a
                href="/settings/git-providers/github"
                className="font-medium underline underline-offset-2"
              >
                {t("create.installGitHubApp")}
              </a>
              .
            </p>
          ) : branches.length === 0 ? (
            <p
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              role="status"
            >
              {t("create.noBranchesFor", { repo: selectedRepo.fullName })}
            </p>
          ) : (
            <Select value={branch} onValueChange={onBranchChange}>
              <SelectTrigger id="branch-select">
                <SelectValue placeholder={t("create.selectBranch")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {branches.map((b) => (
                    <SelectItem key={b.name} value={b.name}>
                      {formatBranchOption(b)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          {selectedCommitSha && (
            <p className="text-xs text-muted-foreground">
              {t("create.currentCommit")}{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                {selectedCommitSha.slice(0, 12)}
              </code>
            </p>
          )}
        </div>
      )}
    </div>
  )
}

interface ImageSectionProps {
  imageRef: string
  onImageRefChange: (v: string) => void
  imagePullPolicy: ImagePullPolicy
  onImagePullPolicyChange: (v: ImagePullPolicy) => void
  registryCredentialId: string
  onRegistryCredentialIdChange: (v: string) => void
  trackLatest: boolean
  onTrackLatestChange: (v: boolean) => void
}

function ImageSection({
  imageRef,
  onImageRefChange,
  imagePullPolicy,
  onImagePullPolicyChange,
  registryCredentialId,
  onRegistryCredentialIdChange,
  trackLatest,
  onTrackLatestChange,
}: ImageSectionProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { data: credentials, isLoading } = useRegistryCredentials()

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="image-ref" className="text-sm font-medium">
          {t("create.imageRef")}
        </label>
        <Input
          id="image-ref"
          type="text"
          placeholder={t("create.imagePlaceholder")}
          value={imageRef}
          onChange={(e) => onImageRefChange(e.target.value)}
          className="font-mono"
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          {t("create.imageExamples")}{" "}
          <code className="font-mono text-[11px]">nginx:alpine</code>
          , <code className="font-mono text-[11px]">ghcr.io/org/app:v1</code>.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="registry-cred" className="text-sm font-medium">
          {t("create.registryCredentials")}
        </label>
        <Select
          value={registryCredentialId || "public"}
          onValueChange={(value) =>
            onRegistryCredentialIdChange(value === "public" ? "" : value)
          }
          disabled={isLoading}
        >
          <SelectTrigger id="registry-cred">
            <SelectValue placeholder={t("create.publicAnonymous")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="public">{t("create.publicAnonymous")}</SelectItem>
              {(credentials ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label} ({c.registryHost})
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {t("create.manageCredentials")}{" "}
          <a className="underline underline-offset-2" href="/settings/registry">
            {t("create.settingsRegistry")}
          </a>
          .
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("create.pullPolicy")}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <ChoiceCard
            active={imagePullPolicy === "always"}
            onSelect={() => onImagePullPolicyChange("always")}
            label={t("create.pullAlways")}
            hint={t("create.pullAlwaysHint")}
          />
          <ChoiceCard
            active={imagePullPolicy === "if_not_present"}
            onSelect={() => onImagePullPolicyChange("if_not_present")}
            label={t("create.pullIfNotPresent")}
            hint={t("create.pullIfNotPresentHint")}
          />
        </div>
      </fieldset>

      <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/30 p-3">
        <div className="space-y-1">
          <label htmlFor="create-track-latest" className="text-sm font-medium">
            {t("create.trackLatest")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("create.trackLatestHint")}
          </p>
        </div>
        <Switch
          id="create-track-latest"
          checked={trackLatest}
          onCheckedChange={onTrackLatestChange}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 2 — Build
// ---------------------------------------------------------------------------

interface BuildStepProps {
  form: FormState
  setField: <TKey extends keyof FormState>(
    key: TKey,
    value: FormState[TKey]
  ) => void
  showAdvanced: boolean
  onToggleAdvanced: () => void
  hasDockerfile: boolean | null
  detectionLoading: boolean
  classification: StackClassification | null
  onRootDirChange: (rootDir: string) => void
}

function BuildStep({
  form,
  setField,
  showAdvanced,
  onToggleAdvanced,
  hasDockerfile,
  detectionLoading,
  classification,
  onRootDirChange,
}: BuildStepProps): React.JSX.Element {
  const { t } = useTranslation("apps")
  const selectMethod = (method: BuildMethod): void => {
    setField("buildMethod", method)
    setField("buildMethodTouched", true)
  }

  const isStaticBuild = form.buildMethod === "static"

  const nixpacksHint = ((): string => {
    if (hasDockerfile !== false) return t("create.nixpacksForce")
    if (!classification) return t("create.nixpacksDefault")
    switch (classification.stack) {
      case "laravel":
        return t("create.nixpacksLaravel")
      case "symfony":
      case "php":
        return t("create.nixpacksPhp")
      case "next":
        return t("create.nixpacksNext")
      case "hono":
        return t("create.nixpacksHono")
      case "node":
      case "bun":
        return t("create.nixpacksNode")
      case "django":
      case "flask":
      case "fastapi":
      case "python":
        return t("create.nixpacksPython")
      case "compose":
        return t("create.nixpacksCompose")
      default:
        return t("create.nixpacksDefault")
    }
  })()

  return (
    <div className="space-y-5">
      {classification && classification.stack !== "unknown" && (
        <DetectedPanel classification={classification} />
      )}

      {classification?.stack === "laravel" && (
        <LaravelRuntimePanel
          seedOnFirstDeploy={form.laravelSeedOnFirstDeploy}
          onSeedOnFirstDeployChange={(value) =>
            setField("laravelSeedOnFirstDeploy", value)
          }
        />
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{t("create.buildMethod")}</p>
          {detectionLoading && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <span className="size-1.5 animate-pulse rounded-full bg-primary" />
              {t("create.detecting")}
            </span>
          )}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <BuildMethodCard
            label={t("create.dockerfile")}
            hint={
              hasDockerfile === true
                ? t("create.dockerfileHintRoot")
                : hasDockerfile === false
                  ? t("create.noDockerfile")
                  : t("create.dockerfileGeneric")
            }
            active={form.buildMethod === "docker"}
            detected={hasDockerfile === true}
            onSelect={() => selectMethod("docker")}
          />
          <BuildMethodCard
            label={t("create.nixpacks")}
            hint={nixpacksHint}
            active={form.buildMethod === "nixpacks"}
            detected={hasDockerfile === false}
            onSelect={() => selectMethod("nixpacks")}
          />
          <BuildMethodCard
            label={t("create.staticSite")}
            hint={t("create.staticSiteHint")}
            active={form.buildMethod === "static"}
            detected={classification?.recommendedBuild === "static"}
            onSelect={() => selectMethod("static")}
          />
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <ConfigField
          id="root-dir"
          label={t("create.rootDir")}
          placeholder="./"
          value={form.rootDir}
          onChange={onRootDirChange}
        />
        <ConfigField
          id="dockerfile-path"
          label={t("create.dockerfile")}
          placeholder="Dockerfile"
          value={form.dockerfilePath}
          onChange={(v) => setField("dockerfilePath", v)}
        />
      </div>

      {isStaticBuild && (
        <section className="space-y-3">
          <ConfigField
            id="static-output-dir"
            label={t("create.outputDir")}
            placeholder="dist"
            value={form.staticOutputDir}
            onChange={(v) => setField("staticOutputDir", v)}
          />
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background p-3 transition-colors hover:bg-muted/30">
            <input
              type="checkbox"
              checked={form.staticSpaFallback}
              onChange={(e) => setField("staticSpaFallback", e.target.checked)}
              className="mt-0.5 size-4 rounded border-input text-primary focus:ring-2 focus:ring-ring"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">
                {t("create.spaFallback")}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t("create.spaFallbackHint", { file: "index.html" })}
              </span>
            </span>
          </label>
        </section>
      )}

      <button
        type="button"
        onClick={onToggleAdvanced}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <RiArrowRightSLine
          className={cn(
            "size-3.5 transition-transform duration-150",
            showAdvanced && "rotate-90"
          )}
        />
        {t("create.advancedOptions")}
      </button>

      {showAdvanced && (
        <div className="space-y-3 rounded-lg border border-dashed border-panel-border bg-panel-inset p-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <ConfigField
              id="install-cmd"
              label={t("create.installCommand")}
              placeholder="npm install"
              value={form.installCommand}
              onChange={(v) => setField("installCommand", v)}
            />
            <ConfigField
              id="build-cmd"
              label={t("create.buildCommand")}
              placeholder="npm run build"
              value={form.buildCommand}
              onChange={(v) => setField("buildCommand", v)}
            />
            {!isStaticBuild && (
              <ConfigField
                id="start-cmd"
                label={t("create.startCommand")}
                placeholder="node dist/index.js"
                value={form.startCommand}
                onChange={(v) => setField("startCommand", v)}
              />
            )}
            <ConfigField
              id="watch-paths"
              label={t("create.watchPathsComma")}
              placeholder="src/,package.json"
              value={form.watchPaths}
              onChange={(v) => setField("watchPaths", v)}
            />
          </div>

          {!isStaticBuild && (
            <div className="space-y-2 border-t border-border/60 pt-3">
              <p className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                {t("create.healthcheck")}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <ConfigField
                  id="healthcheck-path"
                  label={t("create.path")}
                  placeholder="/health"
                  value={form.healthcheckPath}
                  onChange={(v) => setField("healthcheckPath", v)}
                />
                <div className="space-y-1">
                  <label
                    htmlFor="healthcheck-port"
                    className="block text-xs font-medium"
                  >
                    {t("create.port")}
                  </label>
                  <Input
                    id="healthcheck-port"
                    type="number"
                    min={1}
                    max={65535}
                    placeholder="3000"
                    value={form.healthcheckPort}
                    onChange={(e) =>
                      setField("healthcheckPort", e.target.value)
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Step 3 — Resources
// ---------------------------------------------------------------------------

function ResourcesStep({
  form,
  classification,
  value,
  onChange,
}: {
  form: FormState
  classification: StackClassification | null
  value: PlanSelectorValue
  onChange: (v: PlanSelectorValue) => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const envCount = form.initialEnvVars.filter((item) => item.key.trim()).length
  const dbVars =
    form.database.mode === "none"
      ? []
      : databaseEnvKeys(form.database.envPrefix)
  const sourceValue =
    form.source === "image"
      ? form.imageRef || "—"
      : (form.selectedRepo?.fullName ?? "—")
  const buildValue =
    form.source === "image"
      ? t("create.ociImage")
      : form.buildMethod === "docker"
        ? t("create.dockerfile")
        : form.buildMethod === "static"
          ? t("create.staticSite")
          : form.buildMethod
  const databaseValue =
    form.database.mode === "none"
      ? t("create.noneValue")
      : form.database.mode === "existing"
        ? t("create.existingDatabaseValue")
        : t("create.newDatabaseValue", {
            name: form.database.newDatabaseName || t("create.newDatabaseFallback"),
            kind: form.database.newDatabaseKind,
          })
  const selectedLimits =
    value.plan === "custom"
      ? {
          cpu: value.cpuLimit,
          memMB: value.memLimitMB,
          pids: value.pidsLimit,
        }
      : PLANS[value.plan]

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <RiInformationLine className="mt-0.5 size-4 shrink-0 text-primary" />
        <p>{t("create.planHint")}</p>
      </div>

      <section className="rounded-2xl bg-panel">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">{t("create.summary")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("create.reviewHint")}
          </p>
        </div>
        <div className="grid gap-0 sm:grid-cols-2 xl:grid-cols-4">
          <ReviewTile label={t("create.name")} value={form.name || "—"} mono />
          <ReviewTile label={t("create.source")} value={sourceValue} mono />
          <ReviewTile
            label={t("create.branch")}
            value={form.branch || "—"}
            mono
          />
          <ReviewTile
            label={t("create.stack")}
            value={classification?.framework ?? classification?.stack ?? "—"}
          />
          <ReviewTile label={t("create.build")} value={buildValue} />
          <ReviewTile
            label={t("create.healthcheck")}
            value={
              form.buildMethod === "static"
                ? t("create.staticLabel")
                : `${form.healthcheckPath || "/"}${form.healthcheckPort ? `:${form.healthcheckPort}` : ""}`
            }
            mono
          />
          <ReviewTile
            label={t("create.steps.database")}
            value={databaseValue}
          />
          <ReviewTile
            label={t("create.envPrefix")}
            value={form.database.envPrefix}
            mono
          />
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-2xl bg-panel p-4">
          <h3 className="text-sm font-semibold">{t("create.variables")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("create.manualVars", { count: envCount })}
            {dbVars.length > 0 ? t("create.plusDbVars", { count: dbVars.length }) : ""}
            .
          </p>
          <div className="mt-3 flex flex-wrap gap-1">
            {form.initialEnvVars
              .filter((item) => item.key.trim())
              .slice(0, 12)
              .map((item) => (
                <code
                  key={item.id}
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {item.key}
                </code>
              ))}
            {dbVars.map((key) => (
              <code
                key={key}
                className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary"
              >
                {key}
              </code>
            ))}
            {envCount + dbVars.length === 0 && (
              <span className="text-xs text-muted-foreground">
                {t("create.noVariables")}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-2xl bg-panel p-4">
          <h3 className="text-sm font-semibold">
            {t("create.selectedResources")}
          </h3>
          <div className="mt-3 grid gap-2 text-sm">
            <ReviewLine label={t("create.plan")} value={value.plan} />
            <ReviewLine
              label="CPU"
              value={
                selectedLimits?.cpu === undefined
                  ? "—"
                  : t("create.cpuValue", { count: selectedLimits.cpu })
              }
            />
            <ReviewLine
              label={t("create.memory")}
              value={
                selectedLimits?.memMB === undefined
                  ? "—"
                  : t("create.memoryValue", { count: selectedLimits.memMB })
              }
            />
            <ReviewLine
              label="PIDs"
              value={
                selectedLimits?.pids === undefined
                  ? "—"
                  : `${selectedLimits.pids}`
              }
            />
          </div>
        </div>
      </section>

      <PlanSelector value={value} onChange={onChange} />
    </div>
  )
}

function ReviewTile({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="min-w-0 border-b border-border px-4 py-3 xl:border-r xl:border-b-0 xl:last:border-r-0">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate text-sm text-foreground",
          mono && "font-mono text-xs"
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  )
}

function ReviewLine({
  label,
  value,
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-xs">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function DetectedPanel({
  classification,
}: {
  classification: StackClassification
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const labelByConfidence: Record<StackClassification["confidence"], string> = {
    high: t("create.detected"),
    medium: t("create.probable"),
    low: t("create.estimate"),
  }
  return (
    <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-primary/15 px-1.5 py-0.5 font-sans text-[9px] font-semibold tracking-wide text-primary uppercase">
          {labelByConfidence[classification.confidence]}
        </span>
        <span className="text-sm font-medium">
          {classification.framework ?? classification.stack}
        </span>
      </div>
      {classification.signals.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {classification.signals.map((s) => (
            <span
              key={s}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {s}
            </span>
          ))}
        </div>
      )}
      {classification.warnings.length > 0 && (
        <ul className="space-y-0.5">
          {classification.warnings.map((w) => (
            <li
              key={w}
              className="text-[11px] text-amber-600 dark:text-amber-400"
            >
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LaravelRuntimePanel({
  seedOnFirstDeploy,
  onSeedOnFirstDeployChange,
}: {
  seedOnFirstDeploy: boolean
  onSeedOnFirstDeployChange: (value: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <section className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("create.laravelRuntime")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("create.laravelSqliteHint")}
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-sans text-[9px] font-semibold tracking-wide text-primary uppercase">
          SQLite
        </span>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background p-3 transition-colors hover:bg-muted/30">
        <input
          type="checkbox"
          checked={seedOnFirstDeploy}
          onChange={(e) => onSeedOnFirstDeployChange(e.target.checked)}
          className="mt-0.5 size-4 rounded border-input text-primary focus:ring-2 focus:ring-ring"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">
            {t("create.laravelSeed")}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t("create.laravelSeedBody")}
          </span>
        </span>
      </label>
    </section>
  )
}

function validateInitialEnvVars(vars: Array<InitialEnvVar>): boolean {
  const seen = new Set<string>()
  for (const item of vars) {
    const key = item.key.trim()
    const value = item.value
    if (!key && !value) continue
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) return false
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

function normalizePostgresUrlForDisplay(connString: string): string {
  const url = new URL(connString)
  if (!url.searchParams.has("serverVersion")) {
    url.searchParams.set("serverVersion", "16")
  }
  if (!url.searchParams.has("charset")) {
    url.searchParams.set("charset", "utf8")
  }
  return url.toString()
}

function parseDatabaseConnectionVars(
  kind: DbKind,
  connString: string,
  prefix: string
): Record<string, string> {
  const normalizedConnString =
    kind === "postgres"
      ? normalizePostgresUrlForDisplay(connString)
      : connString
  const url = new URL(normalizedConnString)
  const vars: Record<string, string> = {}

  vars[`${prefix}_URL`] = normalizedConnString
  vars[`${prefix}_HOST`] = url.hostname
  vars[`${prefix}_PORT`] =
    url.port ||
    (kind === "postgres" ? "5432" : kind === "redis" ? "6379" : "3306")

  if (kind !== "redis") {
    vars[`${prefix}_USER`] = decodeURIComponent(url.username)
    vars[`${prefix}_NAME`] = url.pathname.replace(/^\//, "").split("?")[0] ?? ""
  }
  vars[`${prefix}_PASSWORD`] = decodeURIComponent(url.password)

  return vars
}

function readCreatedAppId(created: unknown): string | null {
  if (
    created &&
    typeof created === "object" &&
    "id" in created &&
    typeof created.id === "string"
  ) {
    return created.id
  }
  const maybeApp =
    created && typeof created === "object" && "app" in created
      ? created.app
      : null
  if (
    maybeApp &&
    typeof maybeApp === "object" &&
    "id" in maybeApp &&
    typeof maybeApp.id === "string"
  ) {
    return maybeApp.id
  }
  return null
}

async function waitForDatabaseRunning(databaseId: string): Promise<Database> {
  const deadline = Date.now() + 120_000
  let last: Database | null = null

  while (Date.now() < deadline) {
    const database = await apiFetch<Database>(`/databases/${databaseId}`)
    last = database
    if (
      database.status === "running" &&
      database.health_status !== "unhealthy"
    ) {
      return database
    }
    if (database.status === "failed") {
      throw new Error(i18n.t("apps:create.dbCreationFailed"))
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }

  throw new Error(
    last
      ? i18n.t("apps:create.dbNotRunningYet", { status: last.status })
      : i18n.t("apps:create.dbReadinessTimeout")
  )
}

async function resolveDatabaseForCreate({
  form,
  organizationId,
  createDatabase,
  idempotencyKey,
}: {
  form: FormState
  organizationId?: string
  createDatabase: (input: {
    organizationId?: string
    projectId: string
    kind: DbKind
    name: string
    plan: DbPlan
    idempotencyKey?: string
  }) => Promise<{ id: string }>
  idempotencyKey?: string
}): Promise<string | null> {
  if (form.database.mode === "none") return null

  if (form.database.mode === "existing") {
    const id = form.database.existingDatabaseId
    const database = await apiFetch<Database>(`/databases/${id}`)
    if (database.status !== "running") {
      throw new Error(i18n.t("apps:create.dbMustBeRunning"))
    }
    return id
  }

  if (!organizationId) {
    throw new Error(i18n.t("apps:create.orgIdRequired"))
  }

  const created = await createDatabase({
    organizationId,
    projectId: organizationId,
    kind: form.database.newDatabaseKind,
    name: form.database.newDatabaseName.trim(),
    plan: form.database.newDatabasePlan,
    idempotencyKey,
  })
  await waitForDatabaseRunning(created.id)
  return created.id
}

function DatabaseStep({
  value,
  onChange,
  databases,
  isLoading,
}: {
  value: DatabaseSelection
  onChange: (value: DatabaseSelection) => void
  databases: Array<Database>
  isLoading: boolean
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const runningDatabases = databases.filter((db) => db.status === "running")

  const update = (patch: Partial<DatabaseSelection>): void => {
    onChange({ ...value, ...patch })
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("create.steps.database")}</p>
        <p className="text-xs text-muted-foreground">{t("create.linkDbHint")}</p>
        <Select
          value={value.mode}
          onValueChange={(mode) => update({ mode: mode as DatabaseMode })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="none">{t("create.noDatabase")}</SelectItem>
              <SelectItem value="existing">{t("create.linkExisting")}</SelectItem>
              <SelectItem value="new">{t("create.createThenLink")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </section>

      {value.mode !== "none" && (
        <section className="flex flex-col gap-2">
          <label htmlFor="database-env-prefix" className="text-sm font-medium">
            {t("create.envPrefixLabel")}
          </label>
          <Input
            id="database-env-prefix"
            value={value.envPrefix}
            onChange={(e) =>
              update({ envPrefix: e.target.value.toUpperCase() })
            }
            placeholder={DEFAULT_DATABASE_ENV_PREFIX}
            aria-invalid={!/^[A-Z0-9_]+$/.test(value.envPrefix)}
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            {t("create.envPrefixHint")}
          </p>
        </section>
      )}

      {value.mode === "existing" && (
        <section className="flex flex-col gap-2">
          <label htmlFor="database-select" className="text-sm font-medium">
            {t("create.existingDatabase")}
          </label>
          {isLoading ? (
            <Skeleton className="h-9 w-full rounded-md" />
          ) : runningDatabases.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {t("create.noRunningDb")}
            </div>
          ) : (
            <Select
              value={value.existingDatabaseId}
              onValueChange={(existingDatabaseId) =>
                update({ existingDatabaseId })
              }
            >
              <SelectTrigger id="database-select">
                <SelectValue placeholder={t("create.chooseRunningDb")} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {runningDatabases.map((db) => (
                    <SelectItem key={db.id} value={db.id}>
                      {db.name} ({db.kind}) · {db.health_status}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </section>
      )}

      {value.mode === "new" && (
        <section className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="database-name" className="text-sm font-medium">
              {t("create.name")}
            </label>
            <Input
              id="database-name"
              value={value.newDatabaseName}
              onChange={(e) =>
                update({
                  newDatabaseName: e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]+/g, "-"),
                })
              }
              placeholder="app-db"
              aria-invalid={
                value.newDatabaseName.length > 0 &&
                !/^[a-z0-9-]+$/.test(value.newDatabaseName)
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="database-kind" className="text-sm font-medium">
              {t("create.dbType")}
            </label>
            <Select
              value={value.newDatabaseKind}
              onValueChange={(newDatabaseKind) =>
                update({ newDatabaseKind: newDatabaseKind as DbKind })
              }
            >
              <SelectTrigger id="database-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="postgres">Postgres</SelectItem>
                  <SelectItem value="mysql">MySQL</SelectItem>
                  <SelectItem value="mariadb">MariaDB</SelectItem>
                  <SelectItem value="redis">Redis</SelectItem>
                  <SelectItem value="mongo">Mongo</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="database-plan" className="text-sm font-medium">
              {t("create.plan")}
            </label>
            <Select
              value={value.newDatabasePlan}
              onValueChange={(newDatabasePlan) =>
                update({ newDatabasePlan: newDatabasePlan as DbPlan })
              }
            >
              <SelectTrigger id="database-plan">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="small">{t("plan.small")}</SelectItem>
                  <SelectItem value="medium">{t("plan.medium")}</SelectItem>
                  <SelectItem value="large">{t("plan.large")}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </section>
      )}
    </div>
  )
}

function EnvStep({
  vars,
  onChange,
  classification,
  probes,
  source,
  repoFullName,
  branch,
  rootDir,
  database,
  databases,
}: {
  vars: Array<InitialEnvVar>
  onChange: (vars: Array<InitialEnvVar>) => void
  classification: StackClassification | null
  probes: ProbeResults | undefined
  source: SourceKind
  repoFullName?: string
  branch: string
  rootDir: string
  database: DatabaseSelection
  databases: Array<Database>
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const envFiles = detectedEnvFiles(probes)
  const selectedDatabase = databases.find(
    (item) => item.id === database.existingDatabaseId
  )
  const databaseKind =
    database.mode === "new"
      ? database.newDatabaseKind
      : database.mode === "existing"
        ? (selectedDatabase?.kind ?? null)
        : null
  const [databaseValues, setDatabaseValues] = React.useState<Record<
    string,
    string
  > | null>(null)
  const [databaseValuesError, setDatabaseValuesError] = React.useState<
    string | null
  >(null)
  const [databaseValuesLoading, setDatabaseValuesLoading] =
    React.useState(false)
  const databaseOverrideKeys =
    database.mode === "none"
      ? new Set<string>()
      : databaseEnvKeysForPrefix(database.envPrefix, databaseKind)
  const databaseImportOmittedKeys =
    database.mode === "none"
      ? new Set<string>()
      : databaseEnvImportOmittedKeys(database.envPrefix, databaseKind)
  const databaseManagedKeys =
    database.mode === "none"
      ? []
      : databaseValues
        ? Object.keys(databaseValues)
        : databaseEnvKeys(database.envPrefix, databaseKind)
  const overriddenEnvVars = vars.filter((item) =>
    databaseOverrideKeys.has(item.key.trim())
  )
  const omittedDatabaseEnvVars = vars.filter((item) =>
    databaseImportOmittedKeys.has(item.key.trim())
  )
  const [selectedEnvFile, setSelectedEnvFile] = React.useState("")
  const [envImportError, setEnvImportError] = React.useState<string | null>(
    null
  )
  const [ignoredDatabaseImportKeys, setIgnoredDatabaseImportKeys] =
    React.useState<Array<string>>([])
  const [isImportingEnv, setIsImportingEnv] = React.useState(false)

  React.useEffect(() => {
    setSelectedEnvFile((current) => {
      if (current && envFiles.includes(current)) return current
      return envFiles[0] ?? ""
    })
  }, [envFiles])

  React.useEffect(() => {
    if (
      database.mode !== "existing" ||
      !database.existingDatabaseId ||
      !selectedDatabase
    ) {
      setDatabaseValues(null)
      setDatabaseValuesError(null)
      setDatabaseValuesLoading(false)
      return
    }

    let cancelled = false
    setDatabaseValuesLoading(true)
    setDatabaseValuesError(null)
    void apiFetch<{ connection_string: string }>(
      `/databases/${database.existingDatabaseId}/reveal`,
      { method: "POST" }
    )
      .then((data) => {
        if (cancelled) return
        setDatabaseValues(
          parseDatabaseConnectionVars(
            selectedDatabase.kind,
            data.connection_string,
            database.envPrefix
          )
        )
      })
      .catch((err: Error) => {
        if (cancelled) return
        setDatabaseValues(null)
        setDatabaseValuesError(err.message)
      })
      .finally(() => {
        if (!cancelled) setDatabaseValuesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [
    database.mode,
    database.existingDatabaseId,
    database.envPrefix,
    selectedDatabase,
  ])

  React.useEffect(() => {
    if (database.mode === "none" || omittedDatabaseEnvVars.length === 0) {
      return
    }
    const omittedKeys = omittedDatabaseEnvVars.map((item) => item.key.trim())
    onChange(
      vars.filter((item) => !databaseImportOmittedKeys.has(item.key.trim()))
    )
    setIgnoredDatabaseImportKeys((prev) =>
      Array.from(new Set([...prev, ...omittedKeys])).sort()
    )
  }, [
    database.mode,
    databaseImportOmittedKeys,
    omittedDatabaseEnvVars,
    onChange,
    vars,
  ])

  const addVar = (): void => {
    onChange([
      ...vars,
      {
        id: `env-${Date.now()}-${vars.length}`,
        key: "",
        value: "",
        phase: "runtime",
      },
    ])
  }

  const updateVar = (
    id: string,
    patch: Partial<Omit<InitialEnvVar, "id">>
  ): void => {
    onChange(
      vars.map((item) => (item.id === id ? { ...item, ...patch } : item))
    )
  }

  const removeVar = (id: string): void => {
    onChange(vars.filter((item) => item.id !== id))
  }

  const importSelectedEnvFile = async (): Promise<void> => {
    if (source === "image" || !repoFullName || !branch || !selectedEnvFile) {
      return
    }

    setIsImportingEnv(true)
    setEnvImportError(null)
    try {
      const imported = await importEnvFileVars({
        source,
        fullName: repoFullName,
        ref: branch,
        path: selectedEnvFile,
        rootDir: rootDir || undefined,
      })
      const ignoredKeys = new Set<string>()
      const next = vars.filter((item) => {
        const key = item.key.trim()
        if (!databaseImportOmittedKeys.has(key)) return true
        ignoredKeys.add(key)
        return false
      })
      const existingByKey = new Map(next.map((item) => [item.key, item]))
      for (const item of imported) {
        if (databaseImportOmittedKeys.has(item.key)) {
          ignoredKeys.add(item.key)
          continue
        }
        const existing = existingByKey.get(item.key)
        if (existing) {
          const index = next.findIndex((row) => row.id === existing.id)
          next[index] = { ...existing, value: item.value }
        } else {
          next.push({
            id: `env-import-${selectedEnvFile}-${item.key}`,
            key: item.key,
            value: item.value,
            phase: "runtime",
          })
        }
      }
      onChange(next)
      setIgnoredDatabaseImportKeys(Array.from(ignoredKeys).sort())
    } catch (err) {
      setEnvImportError(
        err instanceof Error ? err.message : t("create.importFailed")
      )
    } finally {
      setIsImportingEnv(false)
    }
  }

  const keys = vars.map((item) => item.key.trim()).filter(Boolean)
  const duplicateKeys = new Set(
    keys.filter((key, index) => keys.indexOf(key) !== index)
  )

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t("create.envVars")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("create.envCreatedBefore")}
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={addVar}>
            <RiAddLine className="size-4" />
            {t("common:add")}
          </Button>
        </div>

        {classification?.stack === "symfony" && (
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            {t("create.symfonyDetected")}
          </div>
        )}

        {envFiles.length > 0 && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
            <p className="text-xs text-muted-foreground">
              {t("create.detectedEnvFiles")}
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {envFiles.map((path) => (
                <code
                  key={path}
                  className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {path}
                </code>
              ))}
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Select
                value={selectedEnvFile}
                onValueChange={setSelectedEnvFile}
              >
                <SelectTrigger className="min-w-0 flex-1 font-mono">
                  <SelectValue placeholder={t("create.chooseEnvFile")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {envFiles.map((path) => (
                      <SelectItem key={path} value={path}>
                        {path}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  isImportingEnv ||
                  source === "image" ||
                  !repoFullName ||
                  !branch ||
                  !selectedEnvFile
                }
                onClick={() => void importSelectedEnvFile()}
              >
                {isImportingEnv ? t("create.importing") : t("create.importVars")}
              </Button>
            </div>
            {envImportError && (
              <p className="mt-2 text-[11px] text-destructive">
                {envImportError}
              </p>
            )}
          </div>
        )}

        {overriddenEnvVars.length > 0 && (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {t("create.dbOverrideImported", {
              keys: overriddenEnvVars.map((item) => item.key).join(", "),
            })}
          </div>
        )}

        {ignoredDatabaseImportKeys.length > 0 && (
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            {t("create.dbIgnoredFromEnv", {
              keys: ignoredDatabaseImportKeys.join(", "),
            })}
          </div>
        )}

        {databaseValuesError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {t("create.cannotReadDb", { message: databaseValuesError })}
          </div>
        )}

        <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {t("create.phaseHint")}
        </div>
      </section>

      {vars.length === 0 && databaseManagedKeys.length === 0 ? (
        <button
          type="button"
          onClick={addVar}
          className="flex min-h-28 w-full items-center justify-center rounded-lg border border-dashed border-panel-border bg-panel-inset px-4 text-sm text-muted-foreground transition-colors hover:bg-muted/40"
        >
          {t("create.addVariable")}
        </button>
      ) : (
        <div className="space-y-2">
          {databaseManagedKeys.map((key) => {
            const importedConflict = vars.some(
              (item) => item.key.trim() === key
            )
            return (
              <div
                key={`database-managed-${key}`}
                className="grid gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_8rem_2.25rem]"
              >
                <div className="space-y-1">
                  <label className="text-xs font-medium">{t("create.key")}</label>
                  <Input value={key} readOnly className="font-mono" />
                  {importedConflict && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("create.overrideImported")}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">
                    {t("create.value")}
                  </label>
                  <Input
                    value={
                      databaseValuesLoading
                        ? t("common:loading")
                        : (databaseValues?.[key] ??
                          (database.mode === "new"
                            ? t("create.generatedAfterCreate")
                            : t("create.generatedFromLinked")))
                    }
                    readOnly
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium">
                    {t("create.phase")}
                  </label>
                  <Input value={t("create.runtime")} readOnly />
                </div>
                <div className="flex items-end">
                  <span className="rounded-md border border-primary/20 px-2 py-1 text-[11px] text-primary">
                    DB
                  </span>
                </div>
              </div>
            )
          })}
          {vars.map((item) => {
            const key = item.key.trim()
            const invalidKey = key.length > 0 && !/^[A-Z_][A-Z0-9_]*$/.test(key)
            const duplicate = key.length > 0 && duplicateKeys.has(key)
            const databaseOverridden = databaseOverrideKeys.has(key)
            return (
              <div
                key={item.id}
                className={cn(
                  "grid gap-2 rounded-2xl bg-panel p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_8rem_2.25rem]",
                  databaseOverridden && "opacity-60"
                )}
              >
                <div className="space-y-1">
                  <label
                    className="text-xs font-medium"
                    htmlFor={`${item.id}-key`}
                  >
                    {t("create.key")}
                  </label>
                  <Input
                    id={`${item.id}-key`}
                    value={item.key}
                    onChange={(e) =>
                      updateVar(item.id, { key: e.target.value.toUpperCase() })
                    }
                    placeholder="APP_ENV"
                    aria-invalid={invalidKey || duplicate}
                    className={cn(
                      "font-mono",
                      (invalidKey || duplicate) && "border-destructive"
                    )}
                  />
                  {(invalidKey || duplicate) && (
                    <p className="text-[11px] text-destructive">
                      {duplicate
                        ? t("create.duplicateKey")
                        : t("create.keyFormat")}
                    </p>
                  )}
                  {databaseOverridden && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("create.overriddenByDb")}
                    </p>
                  )}
                </div>
                <div className="space-y-1">
                  <label
                    className="text-xs font-medium"
                    htmlFor={`${item.id}-value`}
                  >
                    {t("create.value")}
                  </label>
                  <Input
                    id={`${item.id}-value`}
                    value={item.value}
                    onChange={(e) =>
                      updateVar(item.id, { value: e.target.value })
                    }
                    placeholder="prod"
                    className="font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <label
                    className="text-xs font-medium"
                    htmlFor={`${item.id}-phase`}
                  >
                    {t("create.phase")}
                  </label>
                  <Select
                    value={item.phase}
                    onValueChange={(value) =>
                      updateVar(item.id, {
                        phase: value as InitialEnvVar["phase"],
                      })
                    }
                  >
                    <SelectTrigger id={`${item.id}-phase`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="runtime">
                          {t("create.runtime")}
                        </SelectItem>
                        <SelectItem value="build">{t("create.build")}</SelectItem>
                        <SelectItem value="both">{t("create.both")}</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => removeVar(item.id)}
                    className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                    aria-label={t("create.deleteVar", {
                      name: item.key || t("create.deleteVarFallback"),
                    })}
                  >
                    <RiDeleteBinLine className="size-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function BuildMethodCard({
  label,
  hint,
  active,
  detected,
  onSelect,
}: {
  label: string
  hint: string
  active: boolean
  detected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all",
        active
          ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
          : "border-border bg-card hover:border-primary/30 hover:bg-muted/40"
      )}
    >
      <div className="flex w-full items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        {detected && (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-sans text-[9px] font-medium tracking-wide text-primary uppercase">
            {t("create.detected")}
          </span>
        )}
      </div>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </button>
  )
}

function ChoiceCard({
  active,
  onSelect,
  label,
  hint,
}: {
  active: boolean
  onSelect: () => void
  label: string
  hint: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-all",
        active
          ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/20"
          : "border-border bg-card hover:border-primary/30 hover:bg-muted/40"
      )}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </button>
  )
}

interface ConfigFieldProps {
  id: string
  label: string
  placeholder: string
  value: string
  onChange: (v: string) => void
}

function ConfigField({
  id,
  label,
  placeholder,
  value,
  onChange,
}: ConfigFieldProps): React.JSX.Element {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
      />
    </div>
  )
}

function DockerIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M22.41 9.78a5.6 5.6 0 0 0-1.49-.21 6.6 6.6 0 0 0-1.7.22 5.7 5.7 0 0 0-2.6-3.17l-.51-.3-.34.49a4.78 4.78 0 0 0-.78 1.83 4.5 4.5 0 0 0 .54 3.46 6.5 6.5 0 0 1-2.36.55H1.13l-.07.41a8.6 8.6 0 0 0 .87 5.18 5.5 5.5 0 0 0 5.51 2.93c4.61 0 8.05-2.13 9.66-6 1.07.05 3.42 0 4.62-2.32 0-.05.27-.6.34-.79l.18-.51-.83-.7zM2.6 11.93h2.13a.18.18 0 0 0 .19-.19V9.84a.19.19 0 0 0-.19-.19H2.6a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19zm2.94 0h2.14a.19.19 0 0 0 .19-.19V9.84a.19.19 0 0 0-.19-.19H5.54a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19zm3 0h2.13a.19.19 0 0 0 .19-.19V9.84a.19.19 0 0 0-.19-.19H8.5a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19zm2.97 0h2.13a.19.19 0 0 0 .19-.19V9.84a.19.19 0 0 0-.19-.19h-2.13a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19zM5.54 9.2h2.14a.19.19 0 0 0 .19-.19V7.1a.19.19 0 0 0-.19-.19H5.54a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19zm3 0h2.13a.19.19 0 0 0 .19-.19V7.1a.19.19 0 0 0-.19-.19H8.5a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19zm2.97 0h2.13a.19.19 0 0 0 .19-.19V7.1a.19.19 0 0 0-.19-.19h-2.13a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19zm0-2.74h2.13a.19.19 0 0 0 .19-.19V4.36a.19.19 0 0 0-.19-.19h-2.13a.19.19 0 0 0-.19.19v1.91a.19.19 0 0 0 .19.19zm2.99 5.47h2.14a.19.19 0 0 0 .19-.19V9.84a.19.19 0 0 0-.19-.19h-2.14a.19.19 0 0 0-.19.19v1.9a.19.19 0 0 0 .19.19z" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Build POST /apps body from form state
// ---------------------------------------------------------------------------

export function buildCreateAppBody(
  form: FormState,
  organizationId?: string,
  generatedDomain?: string
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    gitProvider: form.source,
  }

  if (organizationId) {
    body.organizationId = organizationId
  }
  if (generatedDomain) {
    body.domain = generatedDomain
  }

  if (form.source === "image") {
    body.imageRef = form.imageRef.trim()
    body.imagePullPolicy = form.imagePullPolicy
    body.trackLatest = form.trackLatest
    if (form.registryCredentialId) {
      body.registryCredentialId = form.registryCredentialId
    }
  } else if (form.selectedRepo) {
    body.repoFullName = form.selectedRepo.fullName
    body.branch = form.branch

    if (form.source === "github" && form.selectedRepo.installationId) {
      body.installationId = form.selectedRepo.installationId
    }

    if (form.source === "gitlab" && typeof form.selectedRepo.id === "number") {
      body.gitlabProjectId = form.selectedRepo.id
    }

    body.buildMethod = form.buildMethod
    if (form.rootDir) body.rootDir = form.rootDir
    if (form.dockerfilePath) body.dockerfilePath = form.dockerfilePath
    if (form.installCommand) body.installCommand = form.installCommand
    if (form.buildCommand) body.buildCommand = form.buildCommand
    if (form.startCommand) body.startCommand = form.startCommand
    if (form.buildMethod === "static") {
      body.staticOutputDir = form.staticOutputDir.trim() || "dist"
      body.staticSpaFallback = form.staticSpaFallback
    }

    const watchPaths = form.watchPaths
      ? form.watchPaths
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
    if (watchPaths && watchPaths.length > 0) body.watchPaths = watchPaths

    const parsedPort =
      form.healthcheckPort.trim() !== ""
        ? Number.parseInt(form.healthcheckPort.trim(), 10)
        : undefined
    const validPort =
      parsedPort !== undefined &&
      Number.isFinite(parsedPort) &&
      parsedPort >= 1 &&
      parsedPort <= 65535
        ? parsedPort
        : undefined

    if (form.buildMethod !== "static" && form.healthcheckPath) {
      body.healthcheck = {
        path: form.healthcheckPath,
        port: validPort,
        intervalS: 5,
        timeoutS: 3,
        retries: 6,
        startPeriodS: 0,
      }
    }
  }

  const initialSecrets = form.initialEnvVars
    .map((item) => ({
      key: item.key.trim(),
      value: item.value,
      scope: "shared",
      phase: item.phase,
    }))
    .filter((item) => item.key.length > 0)

  if (form.laravelSeedOnFirstDeploy) {
    initialSecrets.push({
      key: "PLOYDOK_LARAVEL_SEED",
      value: "true",
      scope: "shared",
      phase: "runtime",
    })
  }

  if (initialSecrets.length > 0) {
    body.initialSecrets = initialSecrets
  }

  body.plan = form.plan.plan
  if (form.plan.plan === "custom") {
    if (form.plan.cpuLimit !== undefined) body.cpuLimit = form.plan.cpuLimit
    if (form.plan.memLimitMB !== undefined)
      body.memLimitMB = form.plan.memLimitMB
    if (form.plan.pidsLimit !== undefined) body.pidsLimit = form.plan.pidsLimit
  }

  return body
}
