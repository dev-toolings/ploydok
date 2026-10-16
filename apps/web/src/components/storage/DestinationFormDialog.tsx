// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiArrowLeftLine, RiExternalLinkLine } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import {
  LocalFolderSchema,
  STORAGE_PROVIDERS,
  buildStorageProviderEndpoint,
  parseAzureConnectionString,
  storageProviderAccount,
} from "@ploydok/shared"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Switch } from "@workspace/ui/components/switch"
import { cn } from "@workspace/ui/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { ApiError } from "../../lib/api/errors"
import { ProviderMark } from "./ProviderMark"
import type { StorageProvider } from "@ploydok/shared"
import type {
  StorageDestination,
  StorageDestinationInput,
  StorageProviderId,
} from "../../lib/storage-destinations"

const PROVIDER_GROUPS: Array<{
  key: "groupCloud" | "groupSelfHosted" | "groupServer"
  providers: Array<StorageProviderId>
}> = [
  {
    key: "groupCloud",
    providers: [
      "aws",
      "cloudflare-r2",
      "azure-blob",
      "gcs",
      "backblaze-b2",
      "wasabi",
      "digitalocean-spaces",
      "hetzner",
      "scaleway",
      "ovhcloud",
    ],
  },
  { key: "groupSelfHosted", providers: ["minio", "s3-compatible"] },
  { key: "groupServer", providers: ["local"] },
]

interface FormState {
  name: string
  account: string
  region: string
  bucket: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  accountKey: string
  connectionString: string
  localFolder: string
  createBucket: boolean
}

type FormError =
  | "account"
  | "region"
  | "endpoint"
  | "credentials"
  | "connectionString"
  | "localFolder"
  | "localFolderTaken"
  | null

export interface DestinationSubmitOptions {
  createBucket: boolean
}

function initialState(
  preset: StorageProvider | null,
  destination: StorageDestination | null,
  name: string
): FormState {
  if (!preset) {
    return {
      name: "",
      account: "",
      region: "",
      bucket: "",
      endpoint: "",
      accessKeyId: "",
      secretAccessKey: "",
      accountKey: "",
      connectionString: "",
      localFolder: "",
      createBucket: true,
    }
  }
  const account = destination
    ? storageProviderAccount(preset.id, destination.endpoint) ||
      pathStyleAccount(preset, destination.endpoint)
    : ""
  const derived = buildStorageProviderEndpoint(preset.id, {
    account,
    region: destination?.region ?? preset.defaultRegion,
  })
  // A stored endpoint that the preset would not produce is an override
  // (EU jurisdiction, Azurite...). Keep it visible instead of losing it.
  const endpoint =
    destination?.endpoint &&
    (preset.customEndpoint || destination.endpoint !== derived)
      ? destination.endpoint
      : ""
  return {
    name: destination?.name ?? name,
    account,
    region: destination?.region ?? preset.defaultRegion ?? "",
    bucket: destination?.bucket ?? "",
    endpoint,
    accessKeyId: "",
    secretAccessKey: "",
    accountKey: "",
    connectionString: "",
    localFolder: "",
    createBucket: !destination,
  }
}

/** Emulators address the account in the path: `http://host/<account>`. */
function pathStyleAccount(
  preset: StorageProvider,
  endpoint: string | null
): string {
  if (preset.kind !== "azure" || !endpoint) return ""
  try {
    return new URL(endpoint).pathname.split("/").filter(Boolean)[0] ?? ""
  } catch {
    return ""
  }
}

export function DestinationFormDialog({
  open,
  destination,
  localRoot,
  isPending,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  destination: StorageDestination | null
  localRoot: string | undefined
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (
    input: StorageDestinationInput,
    options: DestinationSubmitOptions
  ) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation("storage")
  const [providerId, setProviderId] = React.useState<StorageProviderId | null>(
    null
  )
  const [form, setForm] = React.useState<FormState>(() =>
    initialState(null, null, "")
  )
  const [error, setError] = React.useState<FormError>(null)

  React.useEffect(() => {
    if (!open) return
    const id = destination?.provider ?? null
    setProviderId(id)
    setForm(initialState(id ? STORAGE_PROVIDERS[id] : null, destination, ""))
    setError(null)
  }, [destination, open])

  const preset = providerId ? STORAGE_PROVIDERS[providerId] : null

  const choose = (id: StorageProviderId): void => {
    setProviderId(id)
    setForm(
      initialState(
        STORAGE_PROVIDERS[id],
        null,
        t(`providers.${id}.defaultName`)
      )
    )
    setError(null)
  }

  const update = <TKey extends keyof FormState>(
    key: TKey,
    value: FormState[TKey]
  ): void => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const applyConnectionString = (value: string): void => {
    update("connectionString", value)
    if (!value.trim()) {
      setError(null)
      return
    }
    const parsed = parseAzureConnectionString(value)
    if (!parsed) {
      setError("connectionString")
      return
    }
    setError(null)
    setForm((current) => ({
      ...current,
      connectionString: value,
      account: parsed.accountName,
      accountKey: parsed.accountKey,
      endpoint: parsed.endpoint ?? "",
    }))
  }

  const derivedEndpoint = preset
    ? buildStorageProviderEndpoint(preset.id, {
        account: form.account,
        region: form.region,
      })
    : undefined
  const effectiveEndpoint = form.endpoint.trim() || derivedEndpoint || null

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!preset) return

    const input: StorageDestinationInput = {
      name: form.name.trim(),
      kind: preset.kind,
      provider: preset.id,
    }
    if (preset.kind === "local" && !destination && form.localFolder.trim()) {
      const folder = LocalFolderSchema.safeParse(form.localFolder)
      if (!folder.success) return setError("localFolder")
      input.localFolder = folder.data
    }
    if (preset.kind !== "local") {
      const override = form.endpoint.trim()
      if (preset.customEndpoint && !override) return setError("endpoint")
      if (preset.needsAccount && !override && derivedEndpoint === null) {
        return setError("account")
      }
      if (preset.regions.length > 0 && !preset.regions.includes(form.region)) {
        return setError("region")
      }
      input.endpoint = override || derivedEndpoint || undefined
      input.bucket = form.bucket.trim()
      if (preset.kind === "s3") {
        input.region = form.region.trim() || preset.defaultRegion || "auto"
        const hasAccess = form.accessKeyId.trim().length > 0
        const hasSecret = form.secretAccessKey.length > 0
        if (hasAccess !== hasSecret || (!destination && !hasAccess)) {
          return setError("credentials")
        }
        if (hasAccess) {
          input.credentials = {
            accessKeyId: form.accessKeyId.trim(),
            secretAccessKey: form.secretAccessKey,
          }
        }
      } else {
        const accountName = form.account.trim().toLowerCase()
        const hasKey = form.accountKey.trim().length > 0
        if ((!destination && !hasKey) || (hasKey && !accountName)) {
          return setError("credentials")
        }
        if (hasKey) {
          input.credentials = {
            accountName,
            accountKey: form.accountKey.trim(),
          }
        }
      }
    }
    setError(null)
    try {
      await onSubmit(input, {
        createBucket: preset.kind !== "local" && form.createBucket,
      })
    } catch (err) {
      if (err instanceof ApiError && err.code === "LOCAL_FOLDER_TAKEN") {
        return setError("localFolderTaken")
      }
      throw err
    }
  }

  const title = destination
    ? t("editTitle")
    : preset
      ? t("createTitleFor", { provider: t(`providers.${preset.id}.name`) })
      : t("createTitle")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(52rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {destination
              ? t("editDescription")
              : preset
                ? t(`providers.${preset.id}.tagline`)
                : t("chooseProviderDescription")}
          </DialogDescription>
        </DialogHeader>

        {!preset ? (
          <ProviderPicker onChoose={choose} />
        ) : (
          <form
            onSubmit={(event) => void handleSubmit(event)}
            className="space-y-5"
            noValidate
          >
            <div className="flex items-center gap-3 rounded-lg border border-panel-border/70 bg-panel-inset p-3">
              <ProviderMark provider={preset.id} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {t(`providers.${preset.id}.name`)}
                </p>
                {effectiveEndpoint ? (
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {effectiveEndpoint}
                  </p>
                ) : preset.id === "aws" ? (
                  <p className="text-xs text-muted-foreground">
                    {t("awsEndpointHint")}
                  </p>
                ) : null}
              </div>
              {!destination ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setProviderId(null)}
                  className="gap-1.5"
                >
                  <RiArrowLeftLine aria-hidden="true" />
                  {t("changeProvider")}
                </Button>
              ) : null}
            </div>

            <Field id="storage-destination-name" label={t("name")}>
              <Input
                id="storage-destination-name"
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                required
                autoFocus
              />
            </Field>

            {preset.kind === "local" ? (
              <>
                {!destination ? (
                  <Field
                    id="storage-destination-folder"
                    label={t("localFolder")}
                    hint={t("localFolderHint")}
                    error={
                      error === "localFolder"
                        ? t("localFolderInvalid")
                        : error === "localFolderTaken"
                          ? t("localFolderTaken")
                          : null
                    }
                  >
                    <Input
                      id="storage-destination-folder"
                      value={form.localFolder}
                      onChange={(event) =>
                        update("localFolder", event.target.value)
                      }
                      placeholder={t("localFolderPlaceholder")}
                      aria-invalid={
                        error === "localFolder" || error === "localFolderTaken"
                      }
                      className="font-mono"
                    />
                  </Field>
                ) : null}
                <div className="space-y-2 rounded-lg border border-panel-border/70 bg-panel-inset p-3 text-sm text-muted-foreground">
                  {destination?.localPath || localRoot ? (
                    <p>
                      {t(destination ? "localPathLabel" : "localRootLabel")}{" "}
                      <code className="font-mono text-xs break-all text-foreground">
                        {destination?.localPath ??
                          `${localRoot}/${form.localFolder.trim() || t("localFolderAuto")}`}
                      </code>
                    </p>
                  ) : null}
                  <p>{t("localHint")}</p>
                </div>
              </>
            ) : (
              <RemoteFields
                preset={preset}
                form={form}
                error={error}
                editing={Boolean(destination)}
                update={update}
                applyConnectionString={applyConnectionString}
              />
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isPending}
              >
                {t("cancel")}
              </Button>
              <Button type="submit" loading={isPending}>
                {isPending
                  ? destination
                    ? t("saving")
                    : t("creating")
                  : destination
                    ? t("save")
                    : preset.kind === "local"
                      ? t("create")
                      : t("createAndTest")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ProviderPicker({
  onChoose,
}: {
  onChoose: (id: StorageProviderId) => void
}): React.JSX.Element {
  const { t } = useTranslation("storage")
  return (
    <div className="space-y-5">
      {PROVIDER_GROUPS.map((group) => (
        <section key={group.key} className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t(group.key)}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.providers.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onChoose(id)}
                className="flex min-h-16 items-center gap-3 rounded-lg border border-panel-border/70 bg-panel p-3 text-left transition-colors outline-none hover:border-primary/50 hover:bg-panel-inset focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ProviderMark provider={id} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {t(`providers.${id}.name`)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`providers.${id}.short`)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function RemoteFields({
  preset,
  form,
  error,
  editing,
  update,
  applyConnectionString,
}: {
  preset: StorageProvider
  form: FormState
  error: FormError
  editing: boolean
  update: <TKey extends keyof FormState>(
    key: TKey,
    value: FormState[TKey]
  ) => void
  applyConnectionString: (value: string) => void
}): React.JSX.Element {
  const { t } = useTranslation("storage")
  const azure = preset.kind === "azure"
  const [advancedOpen, setAdvancedOpen] = React.useState(
    Boolean(form.endpoint) && !preset.customEndpoint
  )
  const labels = credentialLabels(preset.id)

  return (
    <div className="space-y-5">
      {azure ? (
        <Field
          id="storage-destination-connection-string"
          label={t("connectionString")}
          hint={t("connectionStringHint")}
          error={
            error === "connectionString" ? t("connectionStringInvalid") : null
          }
        >
          <Input
            id="storage-destination-connection-string"
            type="password"
            value={form.connectionString}
            placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=..."
            autoComplete="off"
            aria-invalid={error === "connectionString"}
            onChange={(event) => applyConnectionString(event.target.value)}
          />
        </Field>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {preset.customEndpoint ? (
          <Field
            id="storage-destination-endpoint"
            label={t("endpoint")}
            hint={t(`providers.${preset.id}.endpointHint`)}
            error={error === "endpoint" ? t("endpointRequired") : null}
            className="sm:col-span-2"
          >
            <Input
              id="storage-destination-endpoint"
              type="url"
              value={form.endpoint}
              placeholder={t(`providers.${preset.id}.endpointPlaceholder`)}
              aria-invalid={error === "endpoint"}
              onChange={(event) => update("endpoint", event.target.value)}
            />
          </Field>
        ) : null}

        {preset.needsAccount ? (
          <Field
            id="storage-destination-account"
            label={t(`providers.${preset.id}.accountLabel`)}
            hint={t(`providers.${preset.id}.accountHint`)}
            error={error === "account" ? t("accountInvalid") : null}
          >
            <Input
              id="storage-destination-account"
              value={form.account}
              autoComplete="off"
              aria-invalid={error === "account"}
              onChange={(event) => update("account", event.target.value)}
            />
          </Field>
        ) : null}

        {preset.regions.length > 0 ? (
          <Field
            id="storage-destination-region"
            label={t("region")}
            error={error === "region" ? t("regionRequired") : null}
          >
            <Select
              value={form.region}
              onValueChange={(value) => update("region", value)}
            >
              <SelectTrigger id="storage-destination-region" className="w-full">
                <SelectValue placeholder={t("regionChoose")} />
              </SelectTrigger>
              <SelectContent>
                {preset.regions.map((region) => (
                  <SelectItem key={region} value={region}>
                    {region}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : preset.customEndpoint ? (
          <Field id="storage-destination-region" label={t("region")}>
            <Input
              id="storage-destination-region"
              value={form.region}
              onChange={(event) => update("region", event.target.value)}
            />
          </Field>
        ) : null}

        <Field
          id="storage-destination-bucket"
          label={azure ? t("container") : t("bucket")}
          hint={t("bucketHint")}
        >
          <Input
            id="storage-destination-bucket"
            value={form.bucket}
            placeholder={t("bucketPlaceholder")}
            onChange={(event) => update("bucket", event.target.value)}
            required
          />
        </Field>
      </div>

      <div className="space-y-4 rounded-lg border border-panel-border/70 bg-panel-inset p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-foreground">
            {t("credentials")}
          </p>
          {preset.credentialsUrl ? (
            <a
              href={preset.credentialsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {t("credentialsHelp", {
                provider: t(`providers.${preset.id}.name`),
              })}
              <RiExternalLinkLine className="size-3.5" aria-hidden="true" />
            </a>
          ) : null}
        </div>
        {azure ? (
          <Field id="storage-destination-account-key" label={t("accountKey")}>
            <Input
              id="storage-destination-account-key"
              type="password"
              value={form.accountKey}
              placeholder={editing ? t("secretKeepPlaceholder") : undefined}
              autoComplete="new-password"
              aria-invalid={error === "credentials"}
              onChange={(event) => update("accountKey", event.target.value)}
            />
          </Field>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="storage-destination-access-key" label={t(labels.access)}>
              <Input
                id="storage-destination-access-key"
                value={form.accessKeyId}
                autoComplete="off"
                aria-invalid={error === "credentials"}
                onChange={(event) => update("accessKeyId", event.target.value)}
              />
            </Field>
            <Field id="storage-destination-secret-key" label={t(labels.secret)}>
              <Input
                id="storage-destination-secret-key"
                type="password"
                value={form.secretAccessKey}
                placeholder={editing ? t("secretKeepPlaceholder") : undefined}
                autoComplete="new-password"
                aria-invalid={error === "credentials"}
                onChange={(event) =>
                  update("secretAccessKey", event.target.value)
                }
              />
            </Field>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {editing ? t("credentialsKeepHint") : t("credentialsHint")}
        </p>
        {error === "credentials" ? (
          <p className="text-xs text-destructive" role="alert">
            {editing ? t("credentialsRequired") : t("credentialsMissing")}
          </p>
        ) : null}
      </div>

      {!editing ? (
        <label
          htmlFor="storage-destination-create-bucket"
          className="flex cursor-pointer items-start justify-between gap-4 rounded-lg border border-panel-border/70 p-3"
        >
          <span>
            <span className="block text-sm font-medium text-foreground">
              {azure ? t("createContainer") : t("createBucket")}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t("createBucketHint")}
            </span>
          </span>
          <Switch
            id="storage-destination-create-bucket"
            checked={form.createBucket}
            onCheckedChange={(checked) => update("createBucket", checked)}
          />
        </label>
      ) : null}

      {!preset.customEndpoint ? (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((value) => !value)}
            aria-expanded={advancedOpen}
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? t("advancedHide") : t("advancedShow")}
          </button>
          {advancedOpen ? (
            <Field
              id="storage-destination-endpoint-override"
              label={t("endpointOverride")}
              hint={t("endpointOverrideHint")}
            >
              <Input
                id="storage-destination-endpoint-override"
                type="url"
                value={form.endpoint}
                placeholder={
                  buildStorageProviderEndpoint(preset.id, {
                    account: form.account || "account",
                    region: form.region,
                  }) ?? undefined
                }
                onChange={(event) => update("endpoint", event.target.value)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function credentialLabels(id: StorageProviderId): {
  access: string
  secret: string
} {
  if (id === "gcs") return { access: "hmacAccessId", secret: "hmacSecret" }
  if (id === "backblaze-b2") {
    return { access: "b2KeyId", secret: "b2ApplicationKey" }
  }
  return { access: "accessKeyId", secret: "secretAccessKey" }
}

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string | null
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
