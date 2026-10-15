// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  RiArchiveLine,
  RiBookOpenLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiHardDrive3Line,
  RiPencilLine,
} from "@remixicon/react"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { createPageHead } from "../../../../../../lib/page-metadata"
import { BackupConfigPanel } from "../../../../../../components/databases/BackupConfigPanel"
import { BackupsList } from "../../../../../../components/databases/BackupsList"
import {
  useAppVolumes,
  useCreateAppVolume,
  useDeleteAppVolume,
  useUpdateAppVolume,
} from "../../../../../../lib/app-volumes"
import { useTargetBackupNow } from "../../../../../../lib/backups"
import i18n from "../../../../../../lib/i18n"
import type { AppVolume } from "../../../../../../lib/app-volumes"

export const Route = createFileRoute(
  "/_authed/orgs/$orgSlug/apps/$id/storage"
)({
  head: createPageHead("storage"),
  component: AppStoragePage,
})

function formatBytes(bytes: number | null): string {
  if (bytes === null) return i18n.t("apps:storage.noLimit")
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function AppStoragePage(): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const { id: appId } = Route.useParams()
  const { data: volumes = [], isLoading } = useAppVolumes(appId)
  const createVolume = useCreateAppVolume(appId)
  const [guideOpen, setGuideOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [mountPath, setMountPath] = React.useState("/data")
  const [sizeLimitMb, setSizeLimitMb] = React.useState("")

  const handleCreate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    await createVolume.mutateAsync({
      name: name.trim(),
      mountPath: mountPath.trim(),
      sizeLimitBytes: sizeLimitMb
        ? Number(sizeLimitMb) * 1024 * 1024
        : undefined,
    })
    setName("")
    setMountPath("/data")
    setSizeLimitMb("")
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 md:px-8 md:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">{t("storage.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("storage.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setGuideOpen(true)}
          >
            <RiBookOpenLine className="size-3.5" aria-hidden="true" />
            {t("storage.guide")}
          </Button>
          <Badge variant="secondary" className="gap-1.5">
            <RiHardDrive3Line className="size-3.5" aria-hidden="true" />
            {t("storage.volumes", { count: volumes.length })}
          </Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("storage.createTitle")}</CardTitle>
          <CardDescription>{t("storage.createDesc")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleCreate}
            className="grid gap-3 md:grid-cols-[minmax(140px,1fr)_minmax(180px,1fr)_minmax(140px,0.8fr)_auto]"
          >
            <div className="space-y-1.5">
              <Label htmlFor="volume-name">{t("storage.name")}</Label>
              <Input
                id="volume-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="data"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="volume-mount-path">{t("storage.mountPath")}</Label>
              <Input
                id="volume-mount-path"
                value={mountPath}
                onChange={(event) => setMountPath(event.target.value)}
                placeholder="/data"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="volume-size-limit">{t("storage.limitMb")}</Label>
              <Input
                id="volume-size-limit"
                type="number"
                min={1}
                value={sizeLimitMb}
                onChange={(event) => setSizeLimitMb(event.target.value)}
                placeholder={t("storage.optional")}
              />
            </div>
            <div className="flex items-end">
              <Button type="submit" loading={createVolume.isPending}>
                {createVolume.isPending ? t("storage.creating") : t("storage.create")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {isLoading ? (
        <StorageSkeleton />
      ) : volumes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-panel-border bg-panel-inset py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t("storage.empty")}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {volumes.map((volume) => (
            <VolumePanel key={volume.id} appId={appId} volume={volume} />
          ))}
        </div>
      )}

      <StorageGuideAside
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
      />
    </div>
  )
}

function StorageGuideAside({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation("apps")
  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label={t("storage.closeGuide")}
        className="hidden flex-1 cursor-default bg-background/20 md:block"
        onClick={onClose}
      />
      <aside className="flex h-full w-full max-w-[34rem] flex-col border-l bg-background shadow-2xl md:w-[34rem]">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("storage.guideKicker")}
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-normal">
              {t("storage.guideTitle")}
            </h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t("storage.closeGuide")}
          >
            <RiCloseLine className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="space-y-5 text-sm">
            <GuideSection
              title={t("storage.step1Title")}
              body={t("storage.step1Body")}
            />
            <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
              <h3 className="text-sm font-semibold">
                {t("storage.mountTitle")}
              </h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {t("storage.mountBody")}
              </p>
              <div className="mt-4 space-y-3">
                <StackMountGuide
                  stack="Symfony"
                  recommended="/app/public/uploads"
                  alternatives={["/app/var/uploads", "/data/uploads"]}
                  note="Best for uploaded files served by the app. Do not persist var/cache; let Symfony rebuild cache per deploy."
                />
                <StackMountGuide
                  stack="Laravel"
                  recommended="/app/storage/app/public"
                  alternatives={["/app/storage/app", "/app/storage/uploads"]}
                  note="Best for Storage disk files. If files must be public, keep using Laravel's public storage link."
                />
                <StackMountGuide
                  stack="Node.js"
                  recommended="/app/uploads"
                  alternatives={["/data/uploads", "/data"]}
                  note="Point your upload middleware, worker, or env var such as UPLOAD_DIR to this path."
                />
                <StackMountGuide
                  stack="Python"
                  recommended="/app/media"
                  alternatives={["/app/uploads", "/data/media"]}
                  note="For Django, align MEDIA_ROOT with the mount path. For Flask or FastAPI, use the same path in your upload code."
                />
              </div>
            </div>
            <GuideSection
              title={t("storage.step2Title")}
              body={t("storage.step2Body")}
            />
            <GuideSection
              title={t("storage.step3Title")}
              body={t("storage.step3Body")}
            />
            <GuideSection
              title={t("storage.step4Title")}
              body={t("storage.step4Body")}
            />

            <div className="rounded-md border bg-muted/35 p-4">
              <h3 className="text-sm font-semibold">{t("storage.notesTitle")}</h3>
              <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
                <li>{t("storage.noteDb")}</li>
                <li>{t("storage.noteOne")}</li>
                <li>{t("storage.noteRestore")}</li>
              </ul>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}

function StackMountGuide({
  stack,
  recommended,
  alternatives,
  note,
}: {
  stack: string
  recommended: string
  alternatives: Array<string>
  note: string
}): React.JSX.Element {
  return (
    <div className="rounded-md border bg-background/85 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{stack}</span>
        <code className="rounded bg-muted px-2 py-1 font-mono text-xs">
          {recommended}
        </code>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {alternatives.map((path) => (
          <code
            key={path}
            className="rounded border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground"
          >
            {path}
          </code>
        ))}
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{note}</p>
    </div>
  )
}

function GuideSection({
  title,
  body,
}: {
  title: string
  body: string
}): React.JSX.Element {
  return (
    <section className="rounded-md border p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
    </section>
  )
}

function StorageSkeleton(): React.JSX.Element {
  return (
    <div className="grid gap-4">
      {Array.from({ length: 2 }).map((_, index) => (
        <Skeleton key={index} className="h-72 rounded-lg" />
      ))}
    </div>
  )
}

function VolumePanel({
  appId,
  volume,
}: {
  appId: string
  volume: AppVolume
}): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const updateVolume = useUpdateAppVolume(appId)
  const deleteVolume = useDeleteAppVolume(appId)
  const backupNow = useTargetBackupNow({
    kind: "app-volume",
    appId,
    volumeId: volume.id,
  })
  const [editing, setEditing] = React.useState(false)
  const [name, setName] = React.useState(volume.name)
  const [mountPath, setMountPath] = React.useState(volume.mountPath)
  const [sizeLimitMb, setSizeLimitMb] = React.useState(
    volume.sizeLimitBytes
      ? String(Math.round(volume.sizeLimitBytes / 1024 / 1024))
      : ""
  )

  React.useEffect(() => {
    setName(volume.name)
    setMountPath(volume.mountPath)
    setSizeLimitMb(
      volume.sizeLimitBytes
        ? String(Math.round(volume.sizeLimitBytes / 1024 / 1024))
        : ""
    )
  }, [volume])

  const handleUpdate = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    await updateVolume.mutateAsync({
      volumeId: volume.id,
      input: {
        name: name.trim(),
        mountPath: mountPath.trim(),
        sizeLimitBytes: sizeLimitMb
          ? Number(sizeLimitMb) * 1024 * 1024
          : null,
      },
    })
    setEditing(false)
  }

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <RiHardDrive3Line
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="truncate">{volume.name}</span>
            </CardTitle>
            <CardDescription className="mt-1 font-mono">
              {volume.mountPath}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{formatBytes(volume.sizeLimitBytes)}</Badge>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setEditing((value) => !value)}
            >
              <RiPencilLine className="size-3.5" aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => backupNow.mutate()}
              loading={backupNow.isPending}
            >
              <RiArchiveLine className="size-3.5" aria-hidden="true" />
              {backupNow.isPending ? "Starting..." : "Backup now"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-destructive hover:text-destructive"
              onClick={() => deleteVolume.mutate(volume.id)}
              loading={deleteVolume.isPending}
            >
              <RiDeleteBinLine className="size-3.5" aria-hidden="true" />
              Delete
            </Button>
          </div>
        </div>

        <div className="grid gap-3 rounded-md bg-muted/40 p-3 text-sm md:grid-cols-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Host</p>
            <p className="truncate font-mono" title={volume.hostPath}>
              {volume.hostPath}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Created
            </p>
            <p>{new Date(volume.createdAt).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">
              Restore
            </p>
            <p className="text-muted-foreground">Not exposed yet</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {editing ? (
          <form
            onSubmit={handleUpdate}
            className="grid gap-3 rounded-md border p-3 md:grid-cols-[minmax(140px,1fr)_minmax(180px,1fr)_minmax(140px,0.8fr)_auto]"
          >
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Mount path</Label>
              <Input
                value={mountPath}
                onChange={(event) => setMountPath(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Limit MB</Label>
              <Input
                type="number"
                min={1}
                value={sizeLimitMb}
                onChange={(event) => setSizeLimitMb(event.target.value)}
                placeholder={t("storage.optional")}
              />
            </div>
            <div className="flex items-end gap-2">
              <Button type="submit" loading={updateVolume.isPending}>
                {updateVolume.isPending ? "Saving..." : "Save"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <div>
            <div className="mb-3">
              <h3 className="text-sm font-semibold">Backups</h3>
              <p className="text-xs text-muted-foreground">
                Local filesystem backups run here immediately; S3-compatible
                destinations use your configured provider endpoint.
              </p>
            </div>
            <BackupsList
              target={{ kind: "app-volume", appId, volumeId: volume.id }}
              restoreLabel={volume.name}
              onBackupNow={() => backupNow.mutate()}
              backupNowLoading={backupNow.isPending}
            />
          </div>

          <div>
            <div className="mb-3">
              <h3 className="text-sm font-semibold">Backup policy</h3>
              <p className="text-xs text-muted-foreground">
                Configure local or S3-compatible scheduled backups for this
                volume.
              </p>
            </div>
            <BackupConfigPanel
              target={{ kind: "app-volume", appId, volumeId: volume.id }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
