// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../i18n/dialog"
import { useImportGitHubApp } from "../../../lib/github"
import { apiBaseUrl } from "../../../lib/api/base"
import type { ImportGitHubAppPayload } from "../../../lib/github"

interface GitHubAppSetupCardProps {
  isPending: boolean
  onCreate: () => void
  onImported: () => void
  error: string | null
  mode?: "setup" | "reconnect"
}

/**
 * Instance-level GitHub App setup: create one through the manifest flow, or
 * reconnect an existing App after a local DB reset. Rendered both by the
 * settings panel and by the onboarding wizard.
 */
export function GitHubAppSetupCard({
  isPending,
  onCreate,
  onImported,
  error,
  mode = "setup",
}: GitHubAppSetupCardProps): React.JSX.Element {
  const { t } = useTranslation("settings")
  const importApp = useImportGitHubApp()
  const [showImport, setShowImport] = React.useState(mode === "reconnect")
  const [form, setForm] = React.useState<ImportGitHubAppPayload>({
    appId: "",
    clientId: "",
    clientSecret: "",
    privateKey: "",
    webhookSecret: "",
    slug: "",
    name: "",
  })
  const importError = importApp.error
    ? t(`errors:codes.${importApp.error.code}`, {
        defaultValue: importApp.error.message,
      })
    : null
  const reconnectUrls = useReconnectUrls()
  const canImport = Boolean(
    form.appId.trim() &&
    form.clientId.trim() &&
    form.clientSecret.trim() &&
    form.privateKey.trim() &&
    form.slug.trim() &&
    form.name.trim()
  )

  const updateField =
    (key: keyof ImportGitHubAppPayload) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((current) => ({ ...current, [key]: event.target.value }))
    }

  async function handleImport(
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> {
    event.preventDefault()
    try {
      await importApp.mutateAsync({
        ...form,
        appId: form.appId.trim(),
        clientId: form.clientId.trim(),
        slug: form.slug.trim(),
        name: form.name.trim(),
        clientSecret: form.clientSecret.trim(),
        privateKey: form.privateKey.trim(),
        webhookSecret: form.webhookSecret?.trim() ?? "",
      })
      onImported()
    } catch {
      // Keep the entered values so the user can correct or retry the request.
    }
  }

  return (
    <div className="flex flex-col items-start gap-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <GitHubIcon className="size-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">
            {mode === "reconnect"
              ? t("github.reconnectTitle")
              : t("github.notConfigured")}
          </p>
          <p className="text-xs text-muted-foreground">
            {mode === "reconnect"
              ? t("github.reconnectHint")
              : t("github.notConfiguredHint")}
          </p>
        </div>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {mode === "setup" && (
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={onCreate}
            size="sm"
            loading={isPending}
            disabled={importApp.isPending}
          >
            {isPending ? t("github.redirecting") : t("github.createApp")}
          </Button>
          <Button
            type="button"
            onClick={() => setShowImport((value) => !value)}
            size="sm"
            variant="outline"
            disabled={isPending || importApp.isPending}
          >
            {t("github.reconnectExisting")}
          </Button>
        </div>
      )}
      {showImport && (
        <form
          className="grid w-full gap-3 border-t border-border pt-4 md:grid-cols-2"
          onSubmit={(event) => void handleImport(event)}
        >
          <ReconnectGuide
            appSlug={form.slug.trim()}
            apiOrigin={reconnectUrls.apiOrigin}
            webOrigin={reconnectUrls.webOrigin}
          />
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("github.appId")}
            <Input
              value={form.appId}
              onChange={updateField("appId")}
              inputMode="numeric"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("github.clientId")}
            <Input value={form.clientId} onChange={updateField("clientId")} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("github.appSlug")}
            <Input
              value={form.slug}
              onChange={updateField("slug")}
              placeholder="ploydok-local"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium">
            {t("github.appNameShort")}
            <Input
              value={form.name}
              onChange={updateField("name")}
              placeholder="Ploydok Local"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium md:col-span-2">
            {t("github.clientSecret")}
            <Input
              value={form.clientSecret}
              onChange={updateField("clientSecret")}
              type="password"
              autoComplete="off"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium md:col-span-2">
            {t("github.privateKeyShort")}
            <Textarea
              value={form.privateKey}
              onChange={updateField("privateKey")}
              rows={7}
              autoComplete="off"
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-medium md:col-span-2">
            {t("github.webhookSecret")}
            <Input
              value={form.webhookSecret}
              onChange={updateField("webhookSecret")}
              type="password"
              autoComplete="off"
              placeholder={t("github.webhookOptional")}
            />
          </label>
          {importError && (
            <p className="text-sm text-destructive md:col-span-2" role="alert">
              {importError}
            </p>
          )}
          <div className="flex justify-end md:col-span-2">
            <Button
              size="sm"
              type="submit"
              loading={importApp.isPending}
              disabled={!canImport}
            >
              {importApp.isPending
                ? t("github.reconnecting")
                : t("github.saveExisting")}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function useReconnectUrls(): { apiOrigin: string; webOrigin: string } {
  const [origins, setOrigins] = React.useState({
    apiOrigin: "https://<your-ploydok-api>",
    webOrigin: "https://<your-ploydok-instance>",
  })

  React.useEffect(() => {
    const base = apiBaseUrl().replace(/\/$/, "")
    const webOrigin = window.location.origin
    setOrigins({
      apiOrigin: /^https?:\/\//.test(base) ? base : webOrigin,
      webOrigin,
    })
  }, [])

  return origins
}

function ReconnectGuide({
  appSlug,
  apiOrigin,
  webOrigin,
}: {
  appSlug: string
  apiOrigin: string
  webOrigin: string
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const appSettingsUrl = appSlug
    ? `https://github.com/settings/apps/${encodeURIComponent(appSlug)}`
    : "https://github.com/settings/apps"
  const callbackUrl = `${apiOrigin}/github/app/callback`
  const setupUrl = `${apiOrigin}/github/app/setup`
  const webhookUrl = `${apiOrigin}/github/webhook`

  return (
    <Dialog>
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3 md:col-span-2">
        <p className="text-xs text-muted-foreground">
          {t("github.needHelpCredentials")}
        </p>
        <DialogTrigger asChild>
          <Button type="button" size="sm" variant="outline">
            {t("github.howToReconnect")}
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("github.howToReconnectTitle")}</DialogTitle>
          <DialogDescription>
            {t("github.howToReconnectHint")}
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-4 text-xs leading-5">
          <li className="space-y-2">
            <p className="font-medium">{t("github.guideStep1Title")}</p>
            <p className="text-muted-foreground">
              {t("github.guideStep1Body")}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <a
                href={appSettingsUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {t("github.openPersonalSettings")}
              </a>
              <a
                href="https://github.com/settings/organizations"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {t("github.chooseOrg")}
              </a>
            </div>
          </li>

          <li className="space-y-2">
            <p className="font-medium">{t("github.guideStep2Title")}</p>
            <p className="text-muted-foreground">
              {t("github.guideStep2Body")}
            </p>
            <dl className="grid gap-2 rounded-md bg-muted/50 p-3">
              <GuideValue label={t("github.homepageUrl")} value={webOrigin} />
              <GuideValue label={t("github.callbackUrl")} value={callbackUrl} />
              <GuideValue label={t("github.setupUrl")} value={setupUrl} />
              <GuideValue label={t("github.webhookUrl")} value={webhookUrl} />
            </dl>
            {apiOrigin.includes("localhost") ||
            apiOrigin.includes("127.0.0.1") ? (
              <p className="text-muted-foreground">
                {t("github.localhostHint")}
              </p>
            ) : null}
          </li>

          <li className="space-y-2">
            <p className="font-medium">{t("github.guideStep3Title")}</p>
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
              <li>{t("github.guideStep3AppId")}</li>
              <li>{t("github.guideStep3Secret")}</li>
              <li>{t("github.guideStep3Key")}</li>
              <li>{t("github.guideStep3Webhook")}</li>
            </ul>
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  )
}

function GuideValue({
  label,
  value,
}: {
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-3">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="font-mono text-[11px] break-all select-all">{value}</dd>
    </div>
  )
}

export function GitHubIcon({
  className,
}: {
  className?: string
}): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  )
}
