// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  RiCloudLine,
  RiDeleteBinLine,
  RiEditLine,
  RiHardDrive3Line,
  RiTestTubeLine,
} from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/i18n/dialog"
import { ShellPage } from "../../../../components/layout/AppShell"
import { createPageHead } from "../../../../lib/page-metadata"
import { useMembers } from "../../../../lib/memberships"
import {
  useCreateStorageDestination,
  useDeleteStorageDestination,
  useStorageDestinations,
  useTestStorageDestination,
  useUpdateStorageDestination,
} from "../../../../lib/storage-destinations"
import type {
  StorageDestination,
  StorageDestinationInput,
  StorageDestinationKind,
} from "../../../../lib/storage-destinations"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/storage")({
  head: createPageHead("storageDestinations"),
  component: StorageDestinationsPage,
})

interface DestinationFormState {
  name: string
  kind: StorageDestinationKind
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

const EMPTY_FORM: DestinationFormState = {
  name: "",
  kind: "s3",
  endpoint: "",
  bucket: "",
  region: "auto",
  accessKeyId: "",
  secretAccessKey: "",
}

function destinationUsage(destination: StorageDestination): number {
  return destination.usageCount
}

function destinationDate(
  value: string | null,
  locale: string,
  unavailable: string
): string {
  return value
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : unavailable
}

function DestinationFormDialog({
  open,
  destination,
  isPending,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  destination: StorageDestination | null
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: StorageDestinationInput) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation("storage")
  const [form, setForm] = React.useState<DestinationFormState>(EMPTY_FORM)
  const [credentialsError, setCredentialsError] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setForm(
      destination
        ? {
            name: destination.name,
            kind: destination.kind,
            endpoint: destination.endpoint ?? "",
            bucket: destination.bucket ?? "",
            region: destination.region ?? "auto",
            accessKeyId: "",
            secretAccessKey: "",
          }
        : EMPTY_FORM
    )
    setCredentialsError(false)
  }, [destination, open])

  const update = <TKey extends keyof DestinationFormState>(
    key: TKey,
    value: DestinationFormState[TKey]
  ): void => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const hasAccessKey = form.accessKeyId.trim().length > 0
    const hasSecretKey = form.secretAccessKey.trim().length > 0
    if (form.kind === "s3" && hasAccessKey !== hasSecretKey) {
      setCredentialsError(true)
      return
    }
    setCredentialsError(false)

    const input: StorageDestinationInput = {
      name: form.name.trim(),
      kind: form.kind,
    }
    if (form.kind === "s3") {
      input.endpoint = form.endpoint.trim() || undefined
      input.bucket = form.bucket.trim()
      input.region = form.region.trim() || "auto"
      if (hasAccessKey && hasSecretKey) {
        input.credentials = {
          accessKeyId: form.accessKeyId.trim(),
          secretAccessKey: form.secretAccessKey,
        }
      }
    }
    await onSubmit(input)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(42rem,calc(100dvh-2rem))] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {destination ? t("editTitle") : t("createTitle")}
          </DialogTitle>
          <DialogDescription>
            {destination ? t("editDescription") : t("createDescription")}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => void handleSubmit(event)}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="storage-destination-name">{t("name")}</Label>
            <Input
              id="storage-destination-name"
              value={form.name}
              placeholder={t("namePlaceholder")}
              onChange={(event) => update("name", event.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="storage-destination-kind">{t("kind")}</Label>
            <Select
              value={form.kind}
              disabled={Boolean(destination)}
              onValueChange={(value) =>
                update("kind", value as StorageDestinationKind)
              }
            >
              <SelectTrigger id="storage-destination-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="s3">{t("s3")}</SelectItem>
                <SelectItem value="local">{t("local")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.kind === "s3" ? (
            <div className="space-y-4 rounded-lg border border-panel-border/70 bg-panel-inset p-4">
              <div className="space-y-1.5">
                <Label htmlFor="storage-destination-endpoint">
                  {t("endpoint")}
                </Label>
                <Input
                  id="storage-destination-endpoint"
                  type="url"
                  value={form.endpoint}
                  placeholder={t("endpointPlaceholder")}
                  onChange={(event) => update("endpoint", event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("endpointHint")}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="storage-destination-bucket">
                    {t("bucket")}
                  </Label>
                  <Input
                    id="storage-destination-bucket"
                    value={form.bucket}
                    placeholder={t("bucketPlaceholder")}
                    onChange={(event) => update("bucket", event.target.value)}
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="storage-destination-region">
                    {t("region")}
                  </Label>
                  <Input
                    id="storage-destination-region"
                    value={form.region}
                    placeholder={t("regionPlaceholder")}
                    onChange={(event) => update("region", event.target.value)}
                    required
                  />
                </div>
              </div>

              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="storage-destination-access-key">
                    {t("accessKeyId")}
                  </Label>
                  <Input
                    id="storage-destination-access-key"
                    value={form.accessKeyId}
                    placeholder={t("accessKeyPlaceholder")}
                    autoComplete="username"
                    onChange={(event) =>
                      update("accessKeyId", event.target.value)
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="storage-destination-secret-key">
                    {t("secretAccessKey")}
                  </Label>
                  <Input
                    id="storage-destination-secret-key"
                    type="password"
                    value={form.secretAccessKey}
                    placeholder={t("secretPlaceholder")}
                    autoComplete="new-password"
                    aria-invalid={credentialsError}
                    onChange={(event) =>
                      update("secretAccessKey", event.target.value)
                    }
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {destination ? t("credentialsKeepHint") : t("credentialsHint")}
              </p>
              {credentialsError ? (
                <p className="text-xs text-destructive" role="alert">
                  {t("credentialsRequired")}
                </p>
              ) : null}
            </div>
          ) : null}

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
                  : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const DESTINATION_COLUMNS =
  "xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_9rem]"

function DestinationRow({
  destination,
  locale,
  onEdit,
  onDelete,
  onTest,
  testing,
  deleting,
  canManage,
}: {
  destination: StorageDestination
  locale: string
  onEdit: () => void
  onDelete: () => void
  onTest: () => void
  testing: boolean
  deleting: boolean
  canManage: boolean
}): React.JSX.Element {
  const { t } = useTranslation("storage")
  const usage = destinationUsage(destination)
  const used = usage > 0
  const lastTest =
    destination.lastTestStatus === "success"
      ? t("testSucceeded")
      : destination.lastTestStatus === "failure"
        ? t("testFailed")
        : t("neverTested")

  return (
    <li
      className={`grid min-w-0 grid-cols-2 gap-4 border-b border-border p-4 last:border-b-0 xl:items-center ${DESTINATION_COLUMNS}`}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium break-words text-foreground">
          {destination.name}
        </p>
      </div>
      <div className="min-w-0">
        <Badge
          variant="secondary"
          className="max-w-full gap-1.5 whitespace-normal"
        >
          {destination.kind === "s3" ? (
            <RiCloudLine className="size-3.5" aria-hidden="true" />
          ) : (
            <RiHardDrive3Line className="size-3.5" aria-hidden="true" />
          )}
          {destination.kind === "s3" ? t("s3") : t("local")}
        </Badge>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase xl:sr-only">
          {t("endpointColumn")}
        </p>
        <p className="font-mono text-xs break-all text-foreground">
          {destination.kind === "local"
            ? t("notApplicable")
            : destination.endpoint || t("notApplicable")}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase xl:sr-only">
          {t("bucketColumn")}
        </p>
        <p className="text-sm break-words text-foreground">
          {destination.kind === "local"
            ? t("notApplicable")
            : destination.bucket || t("notApplicable")}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase xl:sr-only">
          {t("regionColumn")}
        </p>
        <p className="text-sm break-words text-foreground">
          {destination.kind === "local"
            ? t("notApplicable")
            : destination.region || t("notApplicable")}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase xl:sr-only">
          {t("usageColumn")}
        </p>
        <p className="text-sm break-words text-foreground">
          {used ? t("usedBy", { count: usage }) : t("unused")}
        </p>
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase xl:sr-only">
          {t("lastTestColumn")}
        </p>
        <Badge
          variant={
            destination.lastTestStatus === "failure"
              ? "destructive"
              : destination.lastTestStatus === "success"
                ? "default"
                : "secondary"
          }
          className="max-w-full whitespace-normal"
        >
          {testing ? t("testRunning") : lastTest}
        </Badge>
        {destination.lastTestAt ? (
          <time
            dateTime={destination.lastTestAt}
            className="mt-1 block text-xs text-muted-foreground"
          >
            {destinationDate(destination.lastTestAt, locale, t("neverTested"))}
          </time>
        ) : null}
      </div>
      <div className="col-span-2 flex flex-nowrap items-center justify-end gap-1 xl:col-span-1">
        {canManage ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              loading={testing}
              disabled={deleting}
              onClick={onTest}
              aria-label={testing ? t("testing") : t("test")}
              title={t("test")}
              className="shrink-0"
            >
              <RiTestTubeLine aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              onClick={onEdit}
              disabled={testing || deleting}
              aria-label={t("editAction")}
              title={t("editAction")}
              className="shrink-0"
            >
              <RiEditLine aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              loading={deleting}
              disabled={used || testing}
              title={used ? t("deleteDisabled") : t("deleteAction")}
              aria-label={deleting ? t("deleting") : t("deleteAction")}
              onClick={onDelete}
              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RiDeleteBinLine aria-hidden="true" />
            </Button>
          </>
        ) : null}
      </div>
    </li>
  )
}

function StorageDestinationsPage(): React.JSX.Element {
  const { t, i18n } = useTranslation("storage")
  const { orgSlug } = Route.useParams()
  const { data: membership } = useMembers(orgSlug)
  const isOwner = membership?.members.some(
    (member) => member.is_me && member.role === "owner"
  )
  const {
    data: destinations = [],
    isLoading,
    error,
  } = useStorageDestinations(orgSlug)
  const createDestination = useCreateStorageDestination(orgSlug)
  const updateDestination = useUpdateStorageDestination(orgSlug)
  const testDestination = useTestStorageDestination(orgSlug)
  const deleteDestination = useDeleteStorageDestination(orgSlug)
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<StorageDestination | null>(null)
  const [deleting, setDeleting] = React.useState<StorageDestination | null>(
    null
  )

  const openCreate = (): void => {
    setEditing(null)
    setFormOpen(true)
  }

  const openEdit = (destination: StorageDestination): void => {
    setEditing(destination)
    setFormOpen(true)
  }

  const handleSave = async (input: StorageDestinationInput): Promise<void> => {
    if (editing) {
      await updateDestination.mutateAsync({
        destinationId: editing.id,
        input,
      })
    } else {
      await createDestination.mutateAsync(input)
    }
    setFormOpen(false)
  }

  const handleDelete = (): void => {
    if (!deleting) return
    deleteDestination.mutate(deleting.id)
    setDeleting(null)
  }

  const savePending = createDestination.isPending || updateDestination.isPending

  return (
    <ShellPage
      title={t("title")}
      description={t("description")}
      actions={
        isOwner ? (
          <Button type="button" onClick={openCreate} className="gap-1.5">
            {t("add")}
          </Button>
        ) : null
      }
    >
      <section
        className="min-w-0 rounded-[10px] bg-panel-inset shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]"
        aria-label={t("title")}
      >
        {isLoading ? (
          <div
            className="space-y-3 p-4"
            aria-busy="true"
            aria-label={t("loading")}
          >
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : error ? (
          <p className="p-5 text-sm text-destructive" role="alert">
            {error.message}
          </p>
        ) : destinations.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center">
            <RiHardDrive3Line
              className="size-6 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="text-sm font-medium text-foreground">
              {t("emptyTitle")}
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("emptyBody")}
            </p>
            {isOwner ? (
              <Button
                type="button"
                variant="outline"
                onClick={openCreate}
                className="mt-2"
              >
                {t("add")}
              </Button>
            ) : null}
          </div>
        ) : (
          <>
            <div
              className={`hidden gap-4 border-b border-border px-4 py-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase xl:grid ${DESTINATION_COLUMNS}`}
              aria-hidden="true"
            >
              <span>{t("nameColumn")}</span>
              <span>{t("kindColumn")}</span>
              <span>{t("endpointColumn")}</span>
              <span>{t("bucketColumn")}</span>
              <span>{t("regionColumn")}</span>
              <span>{t("usageColumn")}</span>
              <span>{t("lastTestColumn")}</span>
              <span className="text-right">{t("actionsColumn")}</span>
            </div>
            <ul>
              {destinations.map((destination) => (
                <DestinationRow
                  key={destination.id}
                  destination={destination}
                  locale={i18n.resolvedLanguage ?? i18n.language}
                  onEdit={() => openEdit(destination)}
                  onDelete={() => setDeleting(destination)}
                  onTest={() => testDestination.mutate(destination.id)}
                  testing={
                    testDestination.isPending &&
                    testDestination.variables === destination.id
                  }
                  deleting={
                    deleteDestination.isPending &&
                    deleteDestination.variables === destination.id
                  }
                  canManage={Boolean(isOwner)}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      <DestinationFormDialog
        open={formOpen}
        destination={editing}
        isPending={savePending}
        onOpenChange={setFormOpen}
        onSubmit={handleSave}
      />

      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!deleteDestination.isPending && !open) setDeleting(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting ? t("deleteTitle", { name: deleting.name }) : null}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? t("deleteDescription", { name: deleting.name })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDestination.isPending}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                handleDelete()
              }}
              className="bg-destructive bg-none text-white hover:bg-destructive/90"
            >
              {t("deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ShellPage>
  )
}
