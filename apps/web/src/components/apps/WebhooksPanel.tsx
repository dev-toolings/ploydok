// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiShieldCheckLine } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { RotateSecretDialog } from "../webhooks/RotateSecretDialog"
import { WebhookDeliveriesTable } from "../webhooks/WebhookDeliveriesTable"
import { useApp } from "../../lib/apps"

export function WebhooksPanel({ appId }: { appId: string }): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { data: app } = useApp(appId)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [rotated, setRotated] = React.useState(false)

  const hasSecret = Boolean(app?.webhookSecret || rotated)

  const handleRotated = (): void => {
    setRotated(true)
    toast.success(t("toasts.webhookRotated"))
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("webhooks.incoming")}</CardTitle>
          <CardDescription>{t("webhooks.incomingDesc")}</CardDescription>
          <CardAction>
            <div className="flex flex-wrap items-center gap-2">
              {app?.gitProvider ? (
                <Badge variant="secondary">{app.gitProvider}</Badge>
              ) : null}
            </div>
          </CardAction>
        </CardHeader>

        <CardContent>
          <WebhookDeliveriesTable appId={appId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("webhooks.signingSecret")}</CardTitle>
          <CardDescription>{t("webhooks.signingDesc")}</CardDescription>
          <CardAction>
            <Badge variant={hasSecret ? "secondary" : "outline"}>
              {hasSecret ? t("webhooks.configured") : t("webhooks.missing")}
            </Badge>
          </CardAction>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          <div className="rounded-lg bg-panel-inset p-4 shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">
                  {t("webhooks.currentState")}
                </p>
                <p className="text-sm font-medium">
                  {hasSecret
                    ? t("webhooks.secretActive")
                    : t("webhooks.noSecret")}
                </p>
              </div>
              <div className="rounded-lg border border-panel-border/70 bg-background px-3 py-2 font-mono text-sm">
                {hasSecret ? "••••••••••••••••" : "not-set"}
              </div>
            </div>
          </div>

          <Alert>
            <RiShieldCheckLine />
            <AlertTitle>{t("webhooks.oldSecret")}</AlertTitle>
            <AlertDescription>{t("webhooks.oldSecretDesc")}</AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              {t("webhooks.rotateSecret")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <RotateSecretDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        appId={appId}
        onRotated={handleRotated}
      />
    </div>
  )
}
