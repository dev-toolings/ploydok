// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"
import { NIXPACKS_SUPPORTED_PHP_VERSIONS_LABEL } from "@ploydok/shared"
import { useUpdateAppSettings } from "../../lib/apps-mutations"
import { getBuildPresets } from "../../lib/build-presets"
import { useStackClassification } from "../../lib/stack-classifier-hook"
import type { Stack } from "@ploydok/shared"
import type { AppDetail, AppSettingsPatch } from "../../lib/apps"

type StringPatchKey = Exclude<
  keyof AppSettingsPatch,
  | "runtimePort"
  | "healthcheckPort"
  | "autoDeployEnabled"
  | "postCommitStatus"
  | "coalescePushes"
  | "deployOnTag"
  | "tagPattern"
  | "hooksPreDeploy"
  | "hooksPostDeploy"
  | "hooksTimeoutS"
  | "staticSpaFallback"
>

interface FieldOption {
  value: string
  label: string
}

interface FieldDef {
  key: StringPatchKey
  label: string
  placeholder: string
  hint?: string
  mono?: boolean
  options?: Array<FieldOption>
}

interface BuildRuntimePlaceholders {
  branch: string
  rootDir: string
  buildMethod: string
  dockerfilePath: string
  nixpacksConfigPath: string
  nodeVersion: string
  installCommand: string
  buildCommand: string
  startCommand: string
  staticOutputDir: string
  healthcheckPath: string
  runtimePort: string
  healthcheckPort: string
}

const BUILD_METHOD_OPTIONS: Array<FieldOption> = [
  { value: "auto", label: "Auto-detect" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "nixpacks", label: "Nixpacks" },
  { value: "static", label: "Static site" },
]

const PHP_STACKS = new Set<Stack>(["laravel", "symfony", "php"])

function getBuildRuntimePlaceholders(
  stack: Stack | undefined,
  buildMethod: string | undefined,
  frameworkPreset?: string | null
): BuildRuntimePlaceholders {
  const presets = getBuildPresets()
  const preset =
    presets.find((candidate) => candidate.id === frameworkPreset) ??
    presets.find((candidate) =>
      buildMethod === "static"
        ? candidate.id === "static"
        : candidate.stack === stack || candidate.id === stack
    )
  const defaults = preset?.defaults
  const empty = ""
  return {
    branch: "main",
    rootDir: "/",
    buildMethod: buildMethod ?? defaults?.buildMethod ?? "auto",
    dockerfilePath: "Dockerfile",
    nixpacksConfigPath: "nixpacks.toml",
    nodeVersion: "22",
    installCommand: defaults?.installCommand ?? empty,
    buildCommand: defaults?.buildCommand ?? empty,
    startCommand: defaults?.startCommand ?? empty,
    staticOutputDir: defaults?.outputDirectory ?? empty,
    healthcheckPath: defaults?.healthcheck.path ?? "/",
    runtimePort:
      defaults?.port === null || defaults?.port === undefined
        ? empty
        : String(defaults.port),
    healthcheckPort:
      defaults?.healthcheck.port === null ||
      defaults?.healthcheck.port === undefined
        ? empty
        : String(defaults.healthcheck.port),
  }
}

function buildFields(
  placeholders: BuildRuntimePlaceholders,
  isStatic: boolean
): Array<FieldDef> {
  const base: Array<FieldDef> = [
    { key: "branch", label: "Branch", placeholder: placeholders.branch },
    {
      key: "rootDir",
      label: "Root directory",
      placeholder: placeholders.rootDir,
      mono: true,
    },
    {
      key: "buildMethod",
      label: "Build method",
      placeholder: placeholders.buildMethod,
      hint: "auto · dockerfile · nixpacks · static",
      mono: true,
      options: BUILD_METHOD_OPTIONS,
    },
  ]

  if (isStatic) {
    return [
      ...base,
      {
        key: "nodeVersion",
        label: "Node version",
        placeholder: placeholders.nodeVersion,
        mono: true,
      },
      {
        key: "installCommand",
        label: "Install command",
        placeholder: placeholders.installCommand,
        mono: true,
      },
      {
        key: "buildCommand",
        label: "Build command",
        placeholder: placeholders.buildCommand,
        mono: true,
      },
      {
        key: "staticOutputDir",
        label: "Output directory",
        placeholder: placeholders.staticOutputDir,
        mono: true,
      },
    ]
  }

  return [
    ...base,
    {
      key: "dockerfilePath",
      label: "Dockerfile path",
      placeholder: placeholders.dockerfilePath,
      mono: true,
    },
    {
      key: "nixpacksConfigPath",
      label: "Nixpacks config",
      placeholder: placeholders.nixpacksConfigPath,
      mono: true,
    },
    {
      key: "nodeVersion",
      label: "Node version",
      placeholder: placeholders.nodeVersion,
      mono: true,
    },
    {
      key: "installCommand",
      label: "Install command",
      placeholder: placeholders.installCommand,
      mono: true,
    },
    {
      key: "buildCommand",
      label: "Build command",
      placeholder: placeholders.buildCommand,
      mono: true,
    },
    {
      key: "startCommand",
      label: "Start command",
      placeholder: placeholders.startCommand,
      mono: true,
    },
    {
      key: "healthcheckPath",
      label: "Healthcheck path",
      placeholder: placeholders.healthcheckPath,
      mono: true,
    },
  ]
}

export function AppBuildRuntimeSettings({
  app,
}: {
  app: AppDetail
}): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const update = useUpdateAppSettings(app.id)
  const repoSource = getRepoSource(app.gitProvider)
  const stackClassification = useStackClassification(
    repoSource,
    app.repoFullName,
    app.branch || undefined,
    app.rootDir || undefined
  )
  const placeholders = React.useMemo(
    () =>
      getBuildRuntimePlaceholders(
        stackClassification.data?.stack,
        app.buildMethod,
        app.frameworkPreset
      ),
    [app.buildMethod, app.frameworkPreset, stackClassification.data?.stack]
  )
  const detectedStack = stackClassification.data?.stack
  const [editing, setEditing] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [formData, setFormData] = React.useState<AppSettingsPatch>(() =>
    formDataFromApp(app)
  )
  const selectedBuildMethod = formData.buildMethod ?? app.buildMethod
  const isStatic = selectedBuildMethod === "static"
  const fields = React.useMemo(
    () => buildFields(placeholders, isStatic),
    [isStatic, placeholders]
  )
  const showPhpNixpacksSupport =
    Boolean(detectedStack && PHP_STACKS.has(detectedStack)) &&
    (selectedBuildMethod === "auto" ||
      selectedBuildMethod === "nixpacks" ||
      selectedBuildMethod == null)

  React.useEffect(() => {
    setFormData(formDataFromApp(app))
  }, [app])

  const resetForm = (): void => {
    setFormData(formDataFromApp(app))
  }

  const handleCancel = (): void => {
    setEditing(false)
    setFormError(null)
    resetForm()
  }

  const handleSave = async (): Promise<void> => {
    setFormError(null)
    try {
      await update.mutateAsync(formData)
      setEditing(false)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("build.saveFailed"))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("build.title")}</CardTitle>
        <CardDescription>{t("build.description")}</CardDescription>
        <CardAction>
          {!editing ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              {t("common:edit")}
            </Button>
          ) : null}
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {showPhpNixpacksSupport ? (
          <Alert className="md:col-span-2 xl:col-span-3">
            <AlertTitle>{t("build.phpSupport")}</AlertTitle>
            <AlertDescription>
              {t("build.phpSupportBody", {
                versions: NIXPACKS_SUPPORTED_PHP_VERSIONS_LABEL,
              })}
            </AlertDescription>
          </Alert>
        ) : null}

        {fields.map((field) => (
          <SettingsField
            key={field.key}
            field={field}
            value={String(formData[field.key] ?? "")}
            editing={editing}
            onChange={(value) =>
              setFormData((previous) => ({
                ...previous,
                [field.key]: value || undefined,
              }))
            }
          />
        ))}

        {isStatic ? (
          <BooleanField
            inputId="setting-static-spa-fallback"
            label={t("create.spaFallback")}
            hint={t("build.spaHint")}
            checked={formData.staticSpaFallback ?? true}
            editing={editing}
            onChange={(value) =>
              setFormData((previous) => ({
                ...previous,
                staticSpaFallback: value,
              }))
            }
          />
        ) : (
          <>
            <PortField
              inputId="setting-runtime-port"
              label={t("build.runtimePort")}
              placeholder={placeholders.runtimePort}
              value={formData.runtimePort ?? null}
              editing={editing}
              onChange={(value) =>
                setFormData((previous) => ({ ...previous, runtimePort: value }))
              }
            />

            <PortField
              inputId="setting-healthcheck-port"
              label={t("build.healthcheckPort")}
              hint={t("build.healthcheckPortHint")}
              placeholder={placeholders.healthcheckPort}
              value={formData.healthcheckPort ?? null}
              editing={editing}
              onChange={(value) =>
                setFormData((previous) => ({
                  ...previous,
                  healthcheckPort: value,
                }))
              }
            />

            <RuntimeSelectField
              inputId="setting-runtime-mode"
              label={t("build.runtimeMode")}
              value={formData.runtime?.runtimeMode ?? "swarm"}
              editing={editing}
              onChange={(value) =>
                setFormData((previous) => ({
                  ...previous,
                  runtime: {
                    ...previous.runtime,
                    runtimeMode: value as "docker" | "swarm",
                  },
                }))
              }
            />

            <PortField
              inputId="setting-runtime-replicas"
              label={t("build.replicas")}
              placeholder="1"
              value={formData.runtime?.replicas ?? 1}
              editing={editing}
              onChange={(value) =>
                setFormData((previous) => ({
                  ...previous,
                  runtime: {
                    ...previous.runtime,
                    replicas: Math.max(1, value ?? 1),
                  },
                }))
              }
            />

            <RuntimeSelectField
              inputId="setting-update-order"
              label={t("build.updateOrder")}
              value={formData.runtime?.updateOrder ?? "start-first"}
              editing={editing}
              options={[
                { value: "start-first", label: t("build.startFirst") },
                { value: "stop-first", label: t("build.stopFirst") },
              ]}
              onChange={(value) =>
                setFormData((previous) => ({
                  ...previous,
                  runtime: {
                    ...previous.runtime,
                    updateOrder: value as "start-first" | "stop-first",
                  },
                }))
              }
            />
          </>
        )}

        {formError ? (
          <Alert variant="destructive" className="md:col-span-2 xl:col-span-3">
            <AlertTitle>{t("build.couldNotSave")}</AlertTitle>
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      {editing ? (
        <CardFooter className="justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleCancel}
            disabled={update.isPending}
          >
            {t("common:cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSave()}
            loading={update.isPending}
          >
            {update.isPending ? t("common:saving") : t("common:save")}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  )
}

function formDataFromApp(app: AppDetail): AppSettingsPatch {
  return {
    branch: app.branch,
    rootDir: app.rootDir,
    dockerfilePath: app.dockerfilePath,
    nixpacksConfigPath: app.nixpacksConfigPath,
    nodeVersion: app.nodeVersion,
    installCommand: app.installCommand,
    buildCommand: app.buildCommand,
    startCommand: app.startCommand,
    buildMethod: app.buildMethod,
    staticOutputDir: app.staticOutputDir,
    staticSpaFallback: app.staticSpaFallback ?? true,
    runtimePort: app.runtimePort,
    runtime: {
      runtimeMode: app.runtime?.runtimeMode ?? "swarm",
      swarmServiceName: app.runtime?.swarmServiceName ?? null,
      replicas: app.runtime?.replicas ?? 1,
      updateOrder: app.runtime?.updateOrder ?? "start-first",
      updateParallelism: app.runtime?.updateParallelism ?? 1,
      updateDelayS: app.runtime?.updateDelayS ?? 10,
      updateMonitorS: app.runtime?.updateMonitorS ?? 30,
      failureAction: app.runtime?.failureAction ?? "rollback",
      stopGracePeriodS: app.runtime?.stopGracePeriodS ?? 10,
    },
    healthcheckPath: app.healthcheckPath,
    healthcheckPort: app.healthcheckPort,
  }
}

function getRepoSource(
  gitProvider: string | undefined
): "github" | "gitlab" | undefined {
  if (gitProvider === "github" || gitProvider === "gitlab") {
    return gitProvider
  }
  return undefined
}

function SettingsField({
  field,
  value,
  editing,
  onChange,
}: {
  field: FieldDef
  value: string
  editing: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const inputId = `setting-${field.key}`
  const displayValue = getFieldDisplayValue(field, value)
  const normalizedValue = normalizeFieldValue(field, value)
  const hasUnsupportedValue =
    Boolean(value) &&
    Boolean(field.options) &&
    !field.options?.some((option) => option.value === normalizedValue)

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{field.label}</Label>
      {editing && field.options && !hasUnsupportedValue ? (
        <Select value={normalizedValue} onValueChange={onChange}>
          <SelectTrigger
            id={inputId}
            className={cn(field.mono && "font-mono")}
            aria-label={field.label}
          >
            <SelectValue placeholder={field.placeholder} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {field.options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : editing ? (
        <Input
          id={inputId}
          type="text"
          value={value}
          placeholder={field.placeholder}
          className={cn(field.mono && "font-mono")}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <ReadOnlyValue
          value={displayValue}
          placeholder={field.placeholder}
          mono={field.mono}
        />
      )}
      {field.hint ? (
        <p className="text-xs text-muted-foreground">{field.hint}</p>
      ) : null}
    </div>
  )
}

function normalizeFieldValue(field: FieldDef, value: string): string {
  if (field.key === "buildMethod") {
    if (!value) return "auto"
    return value === "docker" ? "dockerfile" : value
  }
  return value
}

function getFieldDisplayValue(field: FieldDef, value: string): string {
  const normalizedValue = normalizeFieldValue(field, value)
  return (
    field.options?.find((option) => option.value === normalizedValue)?.label ??
    value
  )
}

function PortField({
  inputId,
  label,
  hint,
  placeholder,
  value,
  editing,
  onChange,
}: {
  inputId: string
  label: string
  hint?: string
  placeholder: string
  value: number | null
  editing: boolean
  onChange: (value: number | null) => void
}): React.JSX.Element {
  const displayValue = value != null ? String(value) : ""

  const handleChange = (raw: string): void => {
    if (raw.trim() === "") {
      onChange(null)
      return
    }
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535) {
      onChange(parsed)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      {editing ? (
        <Input
          id={inputId}
          type="number"
          min={1}
          max={65535}
          value={displayValue}
          placeholder={placeholder}
          className="font-mono"
          onChange={(event) => handleChange(event.target.value)}
        />
      ) : (
        <ReadOnlyValue value={displayValue} placeholder={placeholder} mono />
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function RuntimeSelectField({
  inputId,
  label,
  value,
  editing,
  onChange,
  options,
}: {
  inputId: string
  label: string
  value: string
  editing: boolean
  onChange: (value: string) => void
  options?: Array<FieldOption>
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const resolvedOptions =
    options ??
    (value === "docker"
      ? [
          { value: "swarm", label: t("build.swarm") },
          { value: "docker", label: t("build.dockerLegacy") },
        ]
      : [{ value: "swarm", label: t("build.swarm") }])
  const selected = resolvedOptions.find((option) => option.value === value)
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      {editing ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={inputId} aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {resolvedOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : (
        <ReadOnlyValue
          value={selected?.label ?? value}
          placeholder={resolvedOptions[0]?.label ?? ""}
        />
      )}
    </div>
  )
}

function BooleanField({
  inputId,
  label,
  hint,
  checked,
  editing,
  onChange,
}: {
  inputId: string
  label: string
  hint?: string
  checked: boolean
  editing: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation("common")
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      {editing ? (
        <div className="flex h-10 items-center rounded-md border bg-background px-3">
          <Switch id={inputId} checked={checked} onCheckedChange={onChange} />
        </div>
      ) : (
        <ReadOnlyValue
          value={checked ? t("enabled") : t("disabled")}
          placeholder={t("enabled")}
        />
      )}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function ReadOnlyValue({
  value,
  placeholder,
  mono = false,
}: {
  value: string
  placeholder: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border bg-muted/40 px-3 py-2 text-sm",
        mono && "font-mono",
        value ? "text-foreground" : "text-muted-foreground"
      )}
    >
      <span className="block truncate">{value || placeholder}</span>
    </div>
  )
}
