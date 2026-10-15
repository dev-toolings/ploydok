// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
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
import { Skeleton } from "@workspace/ui/components/skeleton"
import { DestinationFormDialog } from "../../../../components/storage/DestinationFormDialog"
import { ProviderMark } from "../../../../components/storage/ProviderMark"
import { ShellPage } from "../../../../components/layout/AppShell"
import { createPageHead } from "../../../../lib/page-metadata"
import { useMembers } from "../../../../lib/memberships"
import {
  testFailureKey,
  useCreateStorageDestination,
  useDeleteStorageDestination,
  useStorageDestinations,
  useTestStorageDestination,
  useUpdateStorageDestination,
} from "../../../../lib/storage-destinations"
import type { DestinationSubmitOptions } from "../../../../components/storage/DestinationFormDialog"
import type {
  StorageDestination,
  StorageDestinationInput,
} from "../../../../lib/storage-destinations"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/storage")({
  head: createPageHead("storageDestinations"),
  component: StorageDestinationsPage,
})

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

const DESTINATION_COLUMNS =
  "xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,0.7fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_9rem]"

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
      <div className="col-span-2 flex min-w-0 items-center gap-3 xl:col-span-1">
        <ProviderMark provider={destination.provider} />
        <div className="min-w-0">
          <p className="text-sm font-medium break-words text-foreground">
            {destination.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(`providers.${destination.provider}.name`)}
          </p>
        </div>
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
        {destination.lastTestStatus === "failure" ? (
          <p className="mt-1 text-xs text-destructive">
            {t(testFailureKey(destination.lastTestError))}
          </p>
        ) : null}
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

  const handleSave = async (
    input: StorageDestinationInput,
    options: DestinationSubmitOptions
  ): Promise<void> => {
    if (editing) {
      await updateDestination.mutateAsync({
        destinationId: editing.id,
        input,
      })
      setFormOpen(false)
      return
    }
    const { destination } = await createDestination.mutateAsync(input)
    setFormOpen(false)
    // Prove the destination right away: the row shows the result (and why it
    // failed) without a second click.
    testDestination.mutate({
      destinationId: destination.id,
      createBucket: options.createBucket,
    })
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
                  onTest={() =>
                    testDestination.mutate({ destinationId: destination.id })
                  }
                  testing={
                    testDestination.isPending &&
                    testDestination.variables.destinationId === destination.id
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
