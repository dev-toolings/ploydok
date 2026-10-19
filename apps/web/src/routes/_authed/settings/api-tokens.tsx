// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { RiAddLine, RiDeleteBinLine, RiKey2Line } from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { createPageHead } from "../../../lib/page-metadata"
import { ShellPage } from "../../../components/layout/AppShell"
import { McpTokenForm } from "../../../components/settings/api-tokens/McpTokenForm"
import { McpTokenCreatedDialog } from "../../../components/settings/api-tokens/McpTokenCreatedDialog"
import { useOrganizations } from "../../../lib/organizations"
import { useApiTokens, useRevokeApiToken } from "../../../lib/api-tokens"
import type { ApiToken } from "../../../lib/api-tokens"

export const Route = createFileRoute("/_authed/settings/api-tokens")({
  head: createPageHead("apiTokens"),
  component: ApiTokensPage,
})

function ApiTokensPage(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: tokens, isLoading } = useApiTokens()
  const [showForm, setShowForm] = React.useState(false)
  const [createdToken, setCreatedToken] = React.useState<string | null>(null)
  const active = (tokens ?? []).filter((tk) => !tk.revoked_at)

  return (
    <ShellPage
      title={t("apiTokens.title")}
      description={t("apiTokens.description")}
      actions={
        !showForm ? (
          <Button size="sm" onClick={() => setShowForm(true)}>
            <RiAddLine />
            {t("apiTokens.new")}
          </Button>
        ) : null
      }
    >
      <div className="space-y-6">
        {showForm ? (
          <McpTokenForm
            onCancel={() => setShowForm(false)}
            onCreated={(token) => {
              setShowForm(false)
              setCreatedToken(token)
            }}
          />
        ) : null}

        <section aria-label={t("apiTokens.title")}>
          {isLoading ? null : active.length === 0 ? (
            <EmptyState onCreate={() => setShowForm(true)} />
          ) : (
            <ul className="divide-y divide-border rounded-2xl bg-panel">
              {active.map((tk) => (
                <TokenRow key={tk.id} token={tk} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <McpTokenCreatedDialog
        token={createdToken}
        onClose={() => setCreatedToken(null)}
      />
    </ShellPage>
  )
}

function TokenRow({ token }: { token: ApiToken }): React.JSX.Element {
  const { t, i18n } = useTranslation("settings")
  const { data: orgs = [] } = useOrganizations()
  const revoke = useRevokeApiToken()
  const [confirming, setConfirming] = React.useState(false)
  const orgName = orgs.find((o) => o.id === token.org_id)?.name
  const date = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { dateStyle: "medium" })

  const details = [
    orgName,
    token.app_ids
      ? t("apiTokens.row.apps", { count: token.app_ids.length })
      : token.kind === "mcp"
        ? t("apiTokens.row.allApps")
        : null,
    token.scopes.includes("apps:deploy") || token.scopes.includes("admin:*")
      ? t("apiTokens.row.canDeploy")
      : t("apiTokens.row.readOnly"),
    token.expires_at
      ? t("apiTokens.row.expires", { date: date(token.expires_at) })
      : t("apiTokens.row.noExpiry"),
    token.last_used_at
      ? t("apiTokens.row.lastUsed", { date: date(token.last_used_at) })
      : t("apiTokens.row.neverUsed"),
  ].filter(Boolean)

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <RiKey2Line className="size-5 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium">{token.name}</p>
          <Badge variant="outline">
            {token.kind === "mcp" ? "MCP" : "API"}
          </Badge>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {details.join(" · ")}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() =>
          confirming ? revoke.mutate(token.id) : setConfirming(true)
        }
        loading={revoke.isPending}
        className={cn(
          "h-8 gap-1.5 px-2.5",
          confirming
            ? "border-destructive/40 text-destructive hover:bg-destructive/10"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <RiDeleteBinLine />
        {confirming ? t("apiTokens.row.confirm") : t("apiTokens.row.revoke")}
      </Button>
    </li>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-panel-border bg-panel-inset px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <RiKey2Line className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("apiTokens.empty")}</p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {t("apiTokens.emptyHint")}
        </p>
      </div>
      <Button size="sm" onClick={onCreate}>
        <RiAddLine />
        {t("apiTokens.new")}
      </Button>
    </div>
  )
}
