// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import { useApp } from "../../lib/apps"
import { useUpdateAppSettings } from "../../lib/apps-mutations"
import { patchAppSettings } from "../../lib/webhooks"
import { ReadOnlyValue } from "./ReadOnlyValue"
import type { AppDetail } from "../../lib/apps"
import type { AutoDeploySettings } from "../../lib/webhooks"

interface AppAutoDeployFields {
  autoDeployEnabled?: boolean
  postCommitStatus?: boolean
  coalescePushes?: boolean
  deployOnTag?: boolean
  tagPattern?: string
}

export function DeploymentTriggers({
  appId,
}: {
  appId: string
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { data: app, isLoading, error } = useApp(appId)

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("triggers.failed")}</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (isLoading || !app) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-72 rounded-lg" />
        <Skeleton className="h-72 rounded-lg" />
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <AutoDeployCard appId={appId} app={app} />
      <DeployHooksCard appId={appId} app={app} />
    </div>
  )
}

function AutoDeployCard({
  appId,
  app,
}: {
  appId: string
  app: AppDetail
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const [autoSettings, setAutoSettings] = React.useState<AutoDeploySettings>(
    () => {
      const fields = app as AppDetail & AppAutoDeployFields
      return {
        autoDeployEnabled: fields.autoDeployEnabled ?? true,
        postCommitStatus: fields.postCommitStatus ?? true,
        coalescePushes: fields.coalescePushes ?? true,
        deployOnTag: fields.deployOnTag ?? false,
        tagPattern: fields.tagPattern ?? undefined,
      }
    }
  )

  React.useEffect(() => {
    const fields = app as AppDetail & AppAutoDeployFields
    setAutoSettings({
      autoDeployEnabled: fields.autoDeployEnabled ?? true,
      postCommitStatus: fields.postCommitStatus ?? true,
      coalescePushes: fields.coalescePushes ?? true,
      deployOnTag: fields.deployOnTag ?? false,
      tagPattern: fields.tagPattern ?? undefined,
    })
  }, [app])

  const handleSwitchChange = async (
    key: keyof AutoDeploySettings,
    value: boolean | string
  ): Promise<void> => {
    const previous = { ...autoSettings }
    const next = { ...autoSettings, [key]: value }
    setAutoSettings(next)
    try {
      await patchAppSettings(appId, { [key]: value })
      toast.success(t("triggers.updated"))
    } catch (err) {
      setAutoSettings(previous)
      toast.error(err instanceof Error ? err.message : t("triggers.updateFailed"))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("triggers.autoDeploy")}</CardTitle>
        <CardDescription>{t("triggers.autoDeployDesc")}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col divide-y divide-border">
        <ToggleRow
          id="auto-deploy-enabled"
          title={t("triggers.deployOnPush")}
          description={t("triggers.deployOnPushDesc")}
          checked={autoSettings.autoDeployEnabled}
          onCheckedChange={(value) =>
            void handleSwitchChange("autoDeployEnabled", value)
          }
        />
        <ToggleRow
          id="post-commit-status"
          title={t("triggers.postStatus")}
          description={t("triggers.postStatusDesc")}
          checked={autoSettings.postCommitStatus}
          onCheckedChange={(value) =>
            void handleSwitchChange("postCommitStatus", value)
          }
        />
        <ToggleRow
          id="coalesce-pushes"
          title={t("triggers.coalesce")}
          description={t("triggers.coalesceDesc")}
          checked={autoSettings.coalescePushes}
          onCheckedChange={(value) =>
            void handleSwitchChange("coalescePushes", value)
          }
        />
        <ToggleRow
          id="deploy-on-tag"
          title={t("triggers.deployOnTag")}
          description={t("triggers.deployOnTagDesc")}
          checked={autoSettings.deployOnTag}
          onCheckedChange={(value) =>
            void handleSwitchChange("deployOnTag", value)
          }
        />

        {autoSettings.deployOnTag ? (
          <div className="flex flex-col gap-2 pt-4">
            <Label htmlFor="tag-pattern">{t("triggers.tagPattern")}</Label>
            <Input
              id="tag-pattern"
              value={autoSettings.tagPattern ?? ""}
              placeholder="v* or release-*"
              className="font-mono"
              onChange={(event) => {
                const value = event.target.value
                setAutoSettings((previous) => ({
                  ...previous,
                  tagPattern: value || undefined,
                }))
              }}
              onBlur={() =>
                void handleSwitchChange(
                  "tagPattern",
                  autoSettings.tagPattern ?? ""
                )
              }
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

function DeployHooksCard({
  appId,
  app,
}: {
  appId: string
  app: AppDetail
}): React.JSX.Element {
  const { t } = useTranslation(["apps", "common"])
  const update = useUpdateAppSettings(appId)
  const [editing, setEditing] = React.useState(false)
  const [preHook, setPreHook] = React.useState(app.hooksPreDeploy ?? "")
  const [postHook, setPostHook] = React.useState(app.hooksPostDeploy ?? "")
  const [timeoutS, setTimeoutS] = React.useState(
    String(app.hooksTimeoutS ?? 300)
  )
  const [formError, setFormError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setPreHook(app.hooksPreDeploy ?? "")
    setPostHook(app.hooksPostDeploy ?? "")
    setTimeoutS(String(app.hooksTimeoutS ?? 300))
  }, [app.hooksPreDeploy, app.hooksPostDeploy, app.hooksTimeoutS])

  const handleCancel = (): void => {
    setEditing(false)
    setFormError(null)
    setPreHook(app.hooksPreDeploy ?? "")
    setPostHook(app.hooksPostDeploy ?? "")
    setTimeoutS(String(app.hooksTimeoutS ?? 300))
  }

  const handleSave = async (): Promise<void> => {
    setFormError(null)
    const parsedTimeout = Number.parseInt(timeoutS, 10)
    try {
      await update.mutateAsync({
        hooksPreDeploy: preHook.trim() || null,
        hooksPostDeploy: postHook.trim() || null,
        hooksTimeoutS: Number.isFinite(parsedTimeout) ? parsedTimeout : 300,
      })
      setEditing(false)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("build.saveFailed"))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("triggers.hooks")}</CardTitle>
        <CardDescription>{t("triggers.hooksDesc")}</CardDescription>
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

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hook-pre">{t("triggers.preDeploy")}</Label>
          {editing ? (
            <Textarea
              id="hook-pre"
              value={preHook}
              placeholder="./scripts/migrate.sh"
              className="font-mono text-sm"
              rows={3}
              onChange={(e) => setPreHook(e.target.value)}
            />
          ) : (
            <ReadOnlyValue value={preHook} placeholder={t("common:none")} mono />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hook-post">{t("triggers.postDeploy")}</Label>
          {editing ? (
            <Textarea
              id="hook-post"
              value={postHook}
              placeholder="./scripts/smoke-test.sh"
              className="font-mono text-sm"
              rows={3}
              onChange={(e) => setPostHook(e.target.value)}
            />
          ) : (
            <ReadOnlyValue value={postHook} placeholder={t("common:none")} mono />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hook-timeout">{t("triggers.timeout")}</Label>
          {editing ? (
            <Input
              id="hook-timeout"
              type="number"
              min={10}
              max={3600}
              value={timeoutS}
              placeholder="300"
              className="font-mono"
              onChange={(e) => setTimeoutS(e.target.value)}
            />
          ) : (
            <ReadOnlyValue value={`${timeoutS}s`} placeholder="300s" mono />
          )}
        </div>

        {formError ? (
          <Alert variant="destructive">
            <AlertTitle>{t("triggers.saveFailed")}</AlertTitle>
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

function ToggleRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  title: string
  description: string
  checked: boolean
  onCheckedChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="cursor-pointer">
          {title}
        </Label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        aria-label={title}
        onCheckedChange={onCheckedChange}
      />
    </div>
  )
}

