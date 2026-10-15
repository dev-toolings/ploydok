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

const DEFAULT_PLACEHOLDERS: BuildRuntimePlaceholders = {
  branch: "main",
  rootDir: "/",
  buildMethod: "auto",
  dockerfilePath: "Dockerfile",
  nixpacksConfigPath: "nixpacks.toml",
  nodeVersion: "22",
  installCommand: "npm install",
  buildCommand: "npm run build",
  startCommand: "npm start",
  staticOutputDir: "dist",
  healthcheckPath: "/",
  runtimePort: "3000",
  healthcheckPort: "3000",
}

function withDefaultPlaceholders(
  overrides: Partial<BuildRuntimePlaceholders>
): BuildRuntimePlaceholders {
  return { ...DEFAULT_PLACEHOLDERS, ...overrides }
}

function getBuildRuntimePlaceholders(
  stack: Stack | undefined,
  buildMethod: string | undefined
): BuildRuntimePlaceholders {
  if (buildMethod === "static") {
    return withDefaultPlaceholders({
      buildMethod: "static",
      nodeVersion: "22",
      installCommand: "npm install",
      buildCommand: "npm run build",
      startCommand: "managed static server",
      staticOutputDir: "dist",
      runtimePort: "80",
      healthcheckPort: "80",
    })
  }

  switch (stack) {
    case "laravel":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
        installCommand:
          "composer install --no-interaction --prefer-dist --optimize-autoloader && npm install",
        buildCommand: "npm run build",
        startCommand: "php artisan serve --host=0.0.0.0 --port=$PORT",
        runtimePort: "80",
        healthcheckPort: "80",
      })
    case "symfony":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
        installCommand:
          "composer install --no-interaction --prefer-dist --optimize-autoloader && npm install",
        buildCommand: "composer dump-env prod && php bin/console cache:clear",
        startCommand: "php -S 0.0.0.0:$PORT -t public",
        runtimePort: "80",
        healthcheckPort: "80",
      })
    case "php":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand:
          "composer install --no-interaction --prefer-dist --optimize-autoloader",
        buildCommand: "composer dump-autoload --optimize",
        startCommand: "php -S 0.0.0.0:$PORT -t public",
        runtimePort: "80",
        healthcheckPort: "80",
      })
    case "next":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
        installCommand: "npm install",
        buildCommand: "npm run build",
        startCommand: "npm run start",
        runtimePort: "3000",
        healthcheckPort: "3000",
      })
    case "hono":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
        installCommand: "npm install",
        buildCommand: "npm run build",
        startCommand: "npm run start",
        runtimePort: "3000",
        healthcheckPort: "3000",
      })
    case "remix":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
        installCommand: "npm install",
        buildCommand: "npm run build",
        startCommand: "npm run start",
      })
    case "astro":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
        installCommand: "npm install",
        buildCommand: "npm run build",
        startCommand: "npm run preview -- --host 0.0.0.0 --port $PORT",
        runtimePort: "4321",
        healthcheckPort: "4321",
      })
    case "node":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
      })
    case "bun":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "22",
        installCommand: "bun install",
        buildCommand: "bun run build",
        startCommand: "bun run start",
      })
    case "deno":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "deno install",
        buildCommand: "deno task build",
        startCommand: "deno task start",
      })
    case "django":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "pip install -r requirements.txt",
        buildCommand: "python manage.py collectstatic --noinput",
        startCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:$PORT",
        runtimePort: "8000",
        healthcheckPort: "8000",
      })
    case "flask":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "pip install -r requirements.txt",
        buildCommand: "python -m compileall .",
        startCommand: "gunicorn app:app --bind 0.0.0.0:$PORT",
        runtimePort: "8000",
        healthcheckPort: "8000",
      })
    case "fastapi":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "pip install -r requirements.txt",
        buildCommand: "python -m compileall .",
        startCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
        runtimePort: "8000",
        healthcheckPort: "8000",
      })
    case "python":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "pip install -r requirements.txt",
        buildCommand: "python -m compileall .",
        startCommand: "python app.py",
        runtimePort: "8000",
        healthcheckPort: "8000",
      })
    case "go":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "go mod download",
        buildCommand: "go build -o app ./...",
        startCommand: "./app",
        runtimePort: "8080",
        healthcheckPort: "8080",
      })
    case "rust":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "cargo fetch",
        buildCommand: "cargo build --release",
        startCommand: "./target/release/app",
        runtimePort: "8080",
        healthcheckPort: "8080",
      })
    case "ruby":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "bundle install",
        buildCommand: "bundle exec rake assets:precompile",
        startCommand: "bundle exec rails server -b 0.0.0.0 -p $PORT",
      })
    case "elixir":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "mix deps.get",
        buildCommand: "mix assets.deploy",
        startCommand: "mix phx.server",
        runtimePort: "4000",
        healthcheckPort: "4000",
      })
    case "java":
      return withDefaultPlaceholders({
        buildMethod: "nixpacks",
        nodeVersion: "not required",
        installCommand: "./mvnw -B dependency:go-offline",
        buildCommand: "./mvnw -B package -DskipTests",
        startCommand: "java -jar target/*.jar",
        runtimePort: "8080",
        healthcheckPort: "8080",
      })
    case "static":
      return withDefaultPlaceholders({
        buildMethod: "static",
        nodeVersion: "22",
        installCommand: "npm install",
        buildCommand: "npm run build",
        startCommand: "managed static server",
        staticOutputDir: "dist",
        runtimePort: "80",
        healthcheckPort: "80",
      })
    default:
      return DEFAULT_PLACEHOLDERS
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
        app.buildMethod
      ),
    [app.buildMethod, stackClassification.data?.stack]
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
