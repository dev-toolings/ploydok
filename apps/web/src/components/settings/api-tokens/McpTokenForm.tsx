// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Switch } from "@workspace/ui/components/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useOrganizations } from "../../../lib/organizations"
import { useApps } from "../../../lib/apps"
import { useCreateMcpToken } from "../../../lib/api-tokens"

const EXPIRY_DAYS = [7, 30, 90] as const

export function McpTokenForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void
  onCreated: (token: string) => void
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: orgs = [] } = useOrganizations()
  const [name, setName] = React.useState("")
  const [orgId, setOrgId] = React.useState("")
  const [allApps, setAllApps] = React.useState(true)
  const [appIds, setAppIds] = React.useState<Array<string>>([])
  const [allowDeploy, setAllowDeploy] = React.useState(false)
  const [allowConfig, setAllowConfig] = React.useState(false)
  const [expiresInDays, setExpiresInDays] = React.useState("30")
  const [error, setError] = React.useState<string | null>(null)
  const create = useCreateMcpToken()

  const selectedOrg = orgId || orgs.find((o) => o.is_default)?.id || ""
  const { data: apps = [] } = useApps(selectedOrg || undefined)

  const toggleApp = (id: string, on: boolean): void => {
    setAppIds((cur) => (on ? [...cur, id] : cur.filter((x) => x !== id)))
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    if (!name.trim() || !selectedOrg) {
      setError(t("apiTokens.form.required"))
      return
    }
    if (!allApps && appIds.length === 0) {
      setError(t("apiTokens.form.pickApps"))
      return
    }
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        orgId: selectedOrg,
        allowDeploy,
        allowConfig,
        expiresInDays: Number(expiresInDays),
        ...(allApps ? {} : { appIds }),
      })
      onCreated(created.token)
    } catch {
      // The mutation already reported the API error.
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="space-y-4 rounded-2xl bg-panel p-5"
    >
      <div>
        <p className="text-sm font-medium">{t("apiTokens.form.title")}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("apiTokens.form.hint")}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-name">{t("apiTokens.form.name")}</Label>
          <Input
            id="mcp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("apiTokens.form.namePlaceholder")}
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t("apiTokens.form.organization")}</Label>
          <Select
            value={selectedOrg}
            onValueChange={(v) => {
              setOrgId(v)
              setAppIds([])
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={t("apiTokens.form.organization")} />
            </SelectTrigger>
            <SelectContent>
              {orgs.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t("apiTokens.form.expiry")}</Label>
          <Select value={expiresInDays} onValueChange={setExpiresInDays}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_DAYS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {t("apiTokens.form.days", { count: d })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ToggleRow
        id="mcp-all-apps"
        label={t("apiTokens.form.allApps")}
        hint={t("apiTokens.form.allAppsHint")}
        checked={allApps}
        onChange={setAllApps}
      />
      {!allApps ? (
        <ul className="divide-y divide-panel-border/70 rounded-xl border border-panel-border/70 bg-panel-inset">
          {apps.length === 0 ? (
            <li className="px-3 py-2.5 text-xs text-muted-foreground">
              {t("apiTokens.form.noApps")}
            </li>
          ) : (
            apps.map((app) => (
              <li key={app.id}>
                <ToggleRow
                  id={`mcp-app-${app.id}`}
                  label={app.name}
                  checked={appIds.includes(app.id)}
                  onChange={(on) => toggleApp(app.id, on)}
                  dense
                />
              </li>
            ))
          )}
        </ul>
      ) : null}
      <ToggleRow
        id="mcp-deploy"
        label={t("apiTokens.form.allowDeploy")}
        hint={t("apiTokens.form.allowDeployHint")}
        checked={allowDeploy}
        onChange={setAllowDeploy}
      />
      <ToggleRow
        id="mcp-config"
        label={t("apiTokens.form.allowConfig")}
        hint={t("apiTokens.form.allowConfigHint")}
        checked={allowConfig}
        onChange={setAllowConfig}
      />

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("common:cancel")}
        </Button>
        <Button type="submit" size="sm" loading={create.isPending}>
          {create.isPending
            ? t("apiTokens.form.creating")
            : t("apiTokens.form.create")}
        </Button>
      </div>
    </form>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  dense,
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
  dense?: boolean
}): React.JSX.Element {
  return (
    <div
      className={
        dense
          ? "flex items-center justify-between gap-3 px-3 py-2"
          : "flex items-start justify-between gap-3"
      }
    >
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm">
          {label}
        </Label>
        {hint ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
