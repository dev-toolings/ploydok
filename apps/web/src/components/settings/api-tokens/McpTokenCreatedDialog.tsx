// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { RiFileCopyLine } from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../i18n/dialog"
import { copyToClipboard, notifyCopyFailed } from "../../../lib/clipboard"
import { mcpClientSnippets, mcpEndpointUrl } from "../../../lib/api-tokens"

export function McpTokenCreatedDialog({
  token,
  onClose,
}: {
  token: string | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const url = React.useMemo(() => (token ? mcpEndpointUrl() : ""), [token])
  const snippets = token ? mcpClientSnippets(url, token) : null

  return (
    <Dialog open={token !== null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("apiTokens.created.title")}</DialogTitle>
          <DialogDescription>
            {t("apiTokens.created.description")}
          </DialogDescription>
        </DialogHeader>
        {token && snippets ? (
          <div className="space-y-4">
            <CopyField id="mcp-token" label={t("apiTokens.created.token")}>
              {token}
            </CopyField>
            <CopyField id="mcp-url" label={t("apiTokens.created.url")}>
              {url}
            </CopyField>
            <CopyField
              id="mcp-claude"
              label={t("apiTokens.created.claude")}
              multiline
            >
              {snippets.claude}
            </CopyField>
            <CopyField
              id="mcp-codex"
              label={t("apiTokens.created.codex")}
              multiline
            >
              {snippets.codex}
            </CopyField>
            <CopyField
              id="mcp-cursor"
              label={t("apiTokens.created.cursor")}
              multiline
            >
              {snippets.cursor}
            </CopyField>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common:close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CopyField({
  id,
  label,
  multiline,
  children,
}: {
  id: string
  label: string
  multiline?: boolean
  children: string
}): React.JSX.Element {
  const { t } = useTranslation("common")
  const copy = (): void => {
    copyToClipboard(children).catch(notifyCopyFailed)
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <Button type="button" size="xs" variant="ghost" onClick={copy}>
          <RiFileCopyLine />
          {t("copy")}
        </Button>
      </div>
      {multiline ? (
        <Textarea
          id={id}
          readOnly
          value={children}
          rows={children.split("\n").length + 1}
          className="font-mono text-xs"
        />
      ) : (
        <Input
          id={id}
          readOnly
          value={children}
          className="font-mono text-xs"
        />
      )}
    </div>
  )
}
