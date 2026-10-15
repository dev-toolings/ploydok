// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { RiExternalLinkLine, RiGitlabFill } from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import type { SaveGitLabConfigPayload } from "../../../lib/gitlab"

/**
 * Instance-level GitLab OAuth app credentials. Rendered both by the settings
 * panel and by the onboarding wizard.
 */
export function GitLabConfigForm({
  onSave,
  pending,
}: {
  onSave: (values: Required<SaveGitLabConfigPayload>) => Promise<void>
  pending: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const [instanceUrl, setInstanceUrl] = React.useState("https://gitlab.com")
  const [clientId, setClientId] = React.useState("")
  const [clientSecret, setClientSecret] = React.useState("")
  const [webhookSecret, setWebhookSecret] = React.useState("")

  return (
    <form
      className="space-y-4 rounded-2xl bg-panel p-5"
      onSubmit={(e) => {
        e.preventDefault()
        void onSave({
          instance_url: instanceUrl,
          client_id: clientId,
          client_secret: clientSecret,
          webhook_secret: webhookSecret,
        })
      }}
    >
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-md border border-border bg-background">
          <RiGitlabFill className="size-5 text-[#fc6d26]" />
        </div>
        <div>
          <h2 className="font-heading text-base font-medium">
            {t("gitlab.createOauth")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("gitlab.createOauthHint")}
          </p>
        </div>
      </header>

      <FieldInput
        label={t("gitlab.instanceUrl")}
        hint={t("gitlab.instanceHint")}
        value={instanceUrl}
        onChange={setInstanceUrl}
        type="url"
        placeholder="https://gitlab.com"
        required
      />
      <FieldInput
        label={t("gitlab.applicationId")}
        value={clientId}
        onChange={setClientId}
        placeholder={t("gitlab.clientIdPlaceholder")}
        required
      />
      <FieldInput
        label={t("gitlab.secret")}
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        placeholder="gloas-…"
        required
      />
      <FieldInput
        label={t("gitlab.webhookSecret")}
        hint={t("gitlab.webhookHint")}
        value={webhookSecret}
        onChange={setWebhookSecret}
        type="password"
        required
      />

      <div className="flex justify-end gap-2 pt-1">
        <Button type="submit" loading={pending}>
          {pending ? t("common:saving") : t("common:save")}
        </Button>
      </div>
    </form>
  )
}

/**
 * `callbackUrl` must be the exact value the API sends as `redirect_uri`, so it
 * comes from GET /gitlab/config rather than being guessed from the browser
 * location. GitLab rejects the token exchange on any mismatch.
 */
export function GitLabSetupHelp({
  callbackUrl,
}: {
  callbackUrl: string | undefined
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <details className="rounded-2xl bg-panel p-5 text-xs">
      <summary className="cursor-pointer font-medium">
        {t("gitlab.howTo")}
      </summary>
      <div className="mt-3 space-y-3 leading-relaxed text-muted-foreground">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            {t("gitlab.openPrefs")}{" "}
            <a
              href="https://gitlab.com/-/user_settings/applications"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-foreground underline-offset-2 hover:underline"
            >
              {t("gitlab.openPrefs")}
              <RiExternalLinkLine className="size-3" />
            </a>{" "}
            {t("gitlab.orInstance")}{" "}
            <code className="font-mono">
              {"{"}instance{"}"}/-/user_settings/applications
            </code>
            ).
          </li>
          <li>{t("gitlab.createApplication")}</li>
          <li>
            {t("gitlab.redirectUri")}{" "}
            {callbackUrl ? (
              <code className="font-mono text-foreground">{callbackUrl}</code>
            ) : (
              <span className="text-muted-foreground">{t("gitlab.loading")}</span>
            )}
          </li>
          <li>
            {t("gitlab.scopes")} <code className="font-mono">api</code> +{" "}
            <code className="font-mono">read_repository</code>.
          </li>
          <li>{t("gitlab.copyPaste")}</li>
          <li>{t("gitlab.generateWebhook")}</li>
        </ol>
      </div>
    </details>
  )
}

function FieldInput({
  label,
  hint,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  required?: boolean
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="font-medium">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        placeholder={placeholder}
        required={required}
        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
      />
      {hint ? (
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  )
}
