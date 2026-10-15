// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { useTranslation } from "react-i18next"
import { createPageHead } from "../../../../lib/page-metadata"
import { ShellPage, ShellPanel } from "../../../../components/layout/AppShell"
import {
  useDeleteOrgBranding,
  useOrgBranding,
  useUpdateOrgBranding,
} from "../../../../lib/branding"

export const Route = createFileRoute("/_authed/orgs/$orgSlug/branding")({
  head: createPageHead("branding"),
  component: BrandingPage,
})

function BrandingPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { orgSlug } = Route.useParams()
  const { data: branding, isLoading } = useOrgBranding(orgSlug)
  const updateMutation = useUpdateOrgBranding(orgSlug)
  const deleteMutation = useDeleteOrgBranding(orgSlug)

  const [appName, setAppName] = React.useState("")
  const [logoUrl, setLogoUrl] = React.useState("")
  const [primaryColor, setPrimaryColor] = React.useState("")
  const [faviconUrl, setFaviconUrl] = React.useState("")

  React.useEffect(() => {
    if (branding) {
      setAppName(branding.app_name || "Ploydok")
      setLogoUrl(branding.logo_url || "")
      setPrimaryColor(branding.primary_color || "#0066ff")
      setFaviconUrl(branding.favicon_url || "")
    }
  }, [branding])

  const handleSave = async () => {
    updateMutation.mutate({
      app_name: appName,
      logo_url: logoUrl || null,
      primary_color: primaryColor || null,
      favicon_url: faviconUrl || null,
    })
  }

  const handleReset = () => {
    if (confirm(t("branding.resetConfirm"))) {
      deleteMutation.mutate()
    }
  }

  const isPremium = true // Check this based on the org's plan in a real implementation

  if (!isPremium) {
    return (
      <ShellPage
        title={t("branding.title")}
        description={t("branding.description")}
        eyebrow={t("eyebrow")}
      >
        <ShellPanel>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-6 py-8 text-center dark:border-amber-900 dark:bg-amber-950">
            <p className="font-semibold text-amber-900 dark:text-amber-100">
              {t("branding.requiresEnterprise")}
            </p>
            <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">
              {t("branding.upgradeHint")}
            </p>
            <Button className="mt-4" variant="default">
              {t("branding.upgrade")}
            </Button>
          </div>
        </ShellPanel>
      </ShellPage>
    )
  }

  return (
    <ShellPage
      title={t("branding.title")}
      description={t("branding.description")}
      eyebrow={t("eyebrow")}
    >
      <div className="space-y-6">
        {isLoading ? (
          <ShellPanel>
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-10 w-full rounded-lg skeleton-surface"
                />
              ))}
            </div>
          </ShellPanel>
        ) : (
          <>
            <ShellPanel
              title={t("branding.settings")}
              description={t("branding.settingsHint")}
            >
              <div className="space-y-6">
                {/* App name */}
                <div className="space-y-2">
                  <Label htmlFor="app-name">{t("branding.appName")}</Label>
                  <Input
                    id="app-name"
                    value={appName}
                    onChange={(e) => setAppName(e.target.value)}
                    placeholder="Ploydok"
                  />
                </div>

                {/* Logo URL */}
                <div className="space-y-2">
                  <Label htmlFor="logo-url">{t("branding.logoUrl")}</Label>
                  <Input
                    id="logo-url"
                    type="url"
                    value={logoUrl}
                    onChange={(e) => setLogoUrl(e.target.value)}
                    placeholder="https://example.com/logo.png"
                  />
                  {logoUrl && (
                    <div className="mt-2 rounded-lg border border-border p-4">
                      <img
                        src={logoUrl}
                        alt={t("branding.logoPreview")}
                        className="h-12 w-12 object-contain"
                      />
                    </div>
                  )}
                </div>

                {/* Primary color */}
                <div className="space-y-2">
                  <Label htmlFor="primary-color">
                    {t("branding.primaryColor")}
                  </Label>
                  <div className="flex gap-2">
                    <input
                      id="primary-color"
                      type="color"
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      className="h-10 w-16 cursor-pointer rounded-lg border border-border"
                    />
                    <Input
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      placeholder="#0066ff"
                      className="flex-1"
                    />
                  </div>
                </div>

                {/* Favicon URL */}
                <div className="space-y-2">
                  <Label htmlFor="favicon-url">{t("branding.faviconUrl")}</Label>
                  <Input
                    id="favicon-url"
                    type="url"
                    value={faviconUrl}
                    onChange={(e) => setFaviconUrl(e.target.value)}
                    placeholder="https://example.com/favicon.ico"
                  />
                  {faviconUrl && (
                    <div className="mt-2 rounded-lg border border-border p-4">
                      <img
                        src={faviconUrl}
                        alt={t("branding.faviconPreview")}
                        className="h-6 w-6"
                      />
                    </div>
                  )}
                </div>

                {/* Preview */}
                <div className="space-y-2">
                  <Label>{t("branding.preview")}</Label>
                  <div
                    className="rounded-lg border border-border p-6"
                    style={{
                      backgroundColor: "var(--background)",
                      color: primaryColor || "#0066ff",
                    }}
                  >
                    <h3 className="text-base font-medium">{appName}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("branding.previewHint")}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-3 pt-4">
                  <Button
                    onClick={handleSave}
                    loading={updateMutation.isPending}
                  >
                    {updateMutation.isPending
                      ? t("branding.saving")
                      : t("branding.save")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleReset}
                    loading={deleteMutation.isPending}
                  >
                    {deleteMutation.isPending
                      ? t("branding.resetting")
                      : t("branding.reset")}
                  </Button>
                </div>
              </div>
            </ShellPanel>
          </>
        )}
      </div>
    </ShellPage>
  )
}
