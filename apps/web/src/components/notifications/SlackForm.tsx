// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@workspace/ui/components/input"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field"

interface SlackFormProps {
  webhookUrl: string
  onChange: (webhookUrl: string) => void
  error?: string
}

export function SlackForm({
  webhookUrl,
  onChange,
  error,
}: SlackFormProps): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor="slack-webhook-url">
          {t("notifications.webhookUrl")}
        </FieldLabel>
        <FieldContent>
          <Input
            id="slack-webhook-url"
            type="url"
            placeholder="https://hooks.slack.com/services/..."
            value={webhookUrl}
            onChange={(e) => onChange(e.target.value)}
            required
          />
        </FieldContent>
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <FieldDescription>{t("notifications.slackHowTo")}</FieldDescription>
        )}
      </Field>
      <p className="text-xs text-muted-foreground">
        <a
          href="https://api.slack.com/messaging/webhooks"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4 hover:text-foreground"
        >
          {t("notifications.slackDocs")}
        </a>
      </p>
    </div>
  )
}
