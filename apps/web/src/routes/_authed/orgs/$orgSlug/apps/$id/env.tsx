// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  RiAddLine,
  RiDatabase2Line,
  RiDownloadLine,
  RiFileList3Line,
  RiTableLine,
  RiUploadLine,
} from "@remixicon/react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { Textarea } from "@workspace/ui/components/textarea"
import { createPageHead } from "../../../../../../lib/page-metadata"
import { SecretsTable } from "../../../../../../components/secrets/SecretsTable"
import { AddSecretDialog } from "../../../../../../components/secrets/AddSecretDialog"
import { EditSecretDialog } from "../../../../../../components/secrets/EditSecretDialog"
import { RevealSecretDialog } from "../../../../../../components/secrets/RevealSecretDialog"
import { ImportEnvDialog } from "../../../../../../components/secrets/ImportEnvDialog"
import { LinkDatabaseDialog } from "../../../../../../components/databases/LinkDatabaseDialog"
import { useImportEnvContent, useSecrets } from "../../../../../../lib/secrets"
import { useApp } from "../../../../../../lib/apps"
import type {
  ImportEnvMode,
  SecretMeta,
  SecretPhase,
  SecretScope,
} from "../../../../../../lib/secrets"

const SCOPES: Array<SecretScope> = ["shared", "prod", "preview", "dev"]
const PHASES: Array<SecretPhase> = ["runtime", "build", "both"]

const SCOPE_KEYS: Record<SecretScope, { label: string; hint: string }> = {
  shared: { label: "env.scopeShared", hint: "env.scopeSharedHint" },
  prod: { label: "env.scopeProd", hint: "env.scopeProdHint" },
  preview: { label: "env.scopePreview", hint: "env.scopePreviewHint" },
  dev: { label: "env.scopeDev", hint: "env.scopeDevHint" },
}

function AppEnvTab(): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { id: routeAppId } = useParams({ strict: false })
  const appId = routeAppId!
  const [activeScope, setActiveScope] = React.useState<SecretScope>("shared")
  const [showAdd, setShowAdd] = React.useState(false)
  const [showImport, setShowImport] = React.useState(false)
  const [showLinkDb, setShowLinkDb] = React.useState(false)
  const [viewMode, setViewMode] = React.useState<"normal" | "developer">(
    "normal"
  )
  const [revealTarget, setRevealTarget] = React.useState<{
    key: string
    scope: SecretScope
    phase: SecretPhase
  } | null>(null)
  const [editTarget, setEditTarget] = React.useState<SecretMeta | null>(null)

  const { data: app } = useApp(appId)
  const { data: secrets, isLoading, isError } = useSecrets(appId, activeScope)

  function handleReveal(key: string, scope: SecretScope, phase: SecretPhase) {
    setRevealTarget({ key, scope, phase })
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-destructive/40 bg-destructive/5 py-12 text-center">
        <p className="text-sm font-medium text-destructive">
          {t("env.loadFailed")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("env.loadFailedHint")}
        </p>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4 px-4 py-6 md:px-8 md:py-8">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {t("env.encryptedTitle")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border bg-background p-0.5">
            <Button
              variant={viewMode === "normal" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("normal")}
              className="h-7 gap-1.5"
            >
              <RiTableLine className="size-3.5" />
              {t("env.normal")}
            </Button>
            <Button
              variant={viewMode === "developer" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setViewMode("developer")}
              className="h-7 gap-1.5"
            >
              <RiFileList3Line className="size-3.5" />
              {t("env.developer")}
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowImport(true)}
            className="gap-1.5"
          >
            <RiUploadLine className="size-3.5" />
            {t("env.importEnv")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowLinkDb(true)}
            className="gap-1.5"
          >
            <RiDatabase2Line className="size-3.5" />
            {t("env.linkDatabase")}
          </Button>
          <Button
            size="sm"
            onClick={() => setShowAdd(true)}
            className="gap-1.5"
          >
            <RiAddLine className="size-3.5" />
            {t("env.addSecret")}
          </Button>
        </div>
      </div>

      {/* Scope tabs */}
      <Tabs
        value={activeScope}
        onValueChange={(v) => setActiveScope(v as SecretScope)}
      >
        <TabsList>
          {SCOPES.map((s) => (
            <TabsTrigger key={s} value={s} title={t(SCOPE_KEYS[s].hint)}>
              {t(SCOPE_KEYS[s].label)}
            </TabsTrigger>
          ))}
        </TabsList>

        <p className="mt-2 text-xs text-muted-foreground">
          {t(SCOPE_KEYS[activeScope].hint)}
        </p>

        {SCOPES.map((s) => (
          <TabsContent key={s} value={s}>
            {isLoading ? (
              <SecretsSkeleton />
            ) : viewMode === "developer" ? (
              <DeveloperEnvEditor
                appId={appId}
                scope={s}
                secrets={secrets ?? []}
              />
            ) : (
              <SecretsTable
                appId={appId}
                scope={s}
                secrets={secrets ?? []}
                onReveal={handleReveal}
                onEdit={(secret) => setEditTarget(secret)}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* Dialogs */}
      <AddSecretDialog
        appId={appId}
        open={showAdd}
        defaultScope={activeScope}
        onOpenChange={setShowAdd}
      />

      <ImportEnvDialog
        appId={appId}
        open={showImport}
        defaultScope={activeScope}
        onOpenChange={setShowImport}
      />

      <RevealSecretDialog
        appId={appId}
        secretKey={revealTarget?.key ?? null}
        scope={revealTarget?.scope ?? null}
        phase={revealTarget?.phase ?? null}
        onClose={() => setRevealTarget(null)}
      />

      <EditSecretDialog
        appId={appId}
        open={!!editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null)
        }}
        secret={editTarget}
      />

      {app?.projectId && (
        <LinkDatabaseDialog
          open={showLinkDb}
          appId={appId}
          projectId={app.projectId}
          onClose={() => setShowLinkDb(false)}
        />
      )}
    </div>
  )
}

function DeveloperEnvEditor({
  appId,
  scope,
  secrets,
}: {
  appId: string
  scope: SecretScope
  secrets: Array<SecretMeta>
}): React.JSX.Element {
  const [content, setContent] = React.useState("")
  const [phase, setPhase] = React.useState<SecretPhase>("runtime")
  const [mode, setMode] = React.useState<ImportEnvMode>("merge")
  const [showLoadConfirm, setShowLoadConfirm] = React.useState(false)
  const [showReplaceConfirm, setShowReplaceConfirm] = React.useState(false)
  const { mutate: importContent, isPending } = useImportEnvContent(appId)
  const manualCount = secrets.filter((s) => s.managed_by === "manual").length
  const linkedCount = secrets.length - manualCount
  const targetManualSecrets = React.useMemo(
    () =>
      secrets.filter(
        (secret) => secret.managed_by === "manual" && secret.phase === phase
      ),
    [phase, secrets]
  )
  const currentKeysContent = React.useMemo(() => {
    const keys = new Set(targetManualSecrets.map((secret) => secret.key))
    return [...keys]
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${key}=`)
      .join("\n")
  }, [targetManualSecrets])
  const isSecretScope = React.useCallback(
    (value: string | undefined): value is SecretScope =>
      value !== undefined && SCOPES.includes(value as SecretScope),
    []
  )
  const isSecretPhase = React.useCallback(
    (value: string | undefined): value is SecretPhase =>
      value !== undefined && PHASES.includes(value as SecretPhase),
    []
  )
  const targetKeysInContent = React.useMemo(() => {
    const keys = new Set<string>()
    let currentScope: SecretScope = scope
    let currentPhase: SecretPhase = phase

    for (const rawLine of content.split(/\r?\n/)) {
      let line = rawLine.trim()
      if (!line) continue

      if (line.startsWith("#")) {
        const scopeDirective = line.match(/^#\s*@scope\s+(\w+)/)
        if (scopeDirective && isSecretScope(scopeDirective[1])) {
          currentScope = scopeDirective[1]
        }
        const phaseDirective = line.match(/^#\s*@phase\s+(\w+)/)
        if (phaseDirective && isSecretPhase(phaseDirective[1])) {
          currentPhase = phaseDirective[1]
        }
        continue
      }

      let lineScope = currentScope
      let linePhase = currentPhase
      const prefixed = line.match(/^((?:@\w+\s+)+)(.*)$/)
      if (prefixed) {
        for (const prefix of prefixed[1].trim().split(/\s+/)) {
          const value = prefix.slice(1)
          if (isSecretScope(value)) lineScope = value
          if (isSecretPhase(value)) linePhase = value
        }
        line = prefixed[2].trimStart()
      }

      const match = line.match(/^([A-Z][A-Z0-9_]*)=/)
      if (match && lineScope === scope && linePhase === phase) {
        keys.add(match[1])
      }
    }

    return keys
  }, [content, isSecretPhase, isSecretScope, phase, scope])
  const removedKeys = React.useMemo(
    () =>
      targetManualSecrets
        .filter((secret) => !targetKeysInContent.has(secret.key))
        .map((secret) => secret.key)
        .sort((a, b) => a.localeCompare(b)),
    [targetManualSecrets, targetKeysInContent]
  )

  function loadCurrentKeys() {
    setContent(currentKeysContent)
    setShowLoadConfirm(false)
  }

  function handleLoadCurrentKeys() {
    if (content.trim()) {
      setShowLoadConfirm(true)
      return
    }

    loadCurrentKeys()
  }

  function submitImport(submitMode: ImportEnvMode) {
    if (submitMode === "merge" && !content.trim()) return

    importContent(
      { content, scope, phase, mode: submitMode },
      {
        onSuccess: ({ imported, removed }) => {
          if (submitMode === "replace") {
            toast.success(
              `Imported ${imported} · Removed ${removed} variable${removed === 1 ? "" : "s"}`
            )
          } else {
            toast.success(
              `Imported ${imported} variable${imported === 1 ? "" : "s"}`
            )
          }
          setContent("")
        },
        onError: (err) => {
          toast.error(err.message)
        },
      }
    )
  }

  function handleImport(e: React.FormEvent) {
    e.preventDefault()

    if (mode === "replace") {
      setShowReplaceConfirm(true)
      return
    }

    if (!content.trim()) return
    submitImport("merge")
  }

  function getSubmitLabel() {
    if (isPending) {
      return mode === "replace" ? "Replacing..." : "Importing..."
    }

    return mode === "replace" ? "Replace" : "Import"
  }

  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        <form
          onSubmit={handleImport}
          className="flex min-w-0 flex-col gap-3 rounded-lg border bg-background p-4"
        >
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h3 className="text-sm font-medium">Bulk import</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Paste .env lines. Prefixes like @prod @build override these
                defaults.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={phase}
                onValueChange={(value) => setPhase(value as SecretPhase)}
              >
                <SelectTrigger className="h-8 w-[132px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHASES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tabs
                value={mode}
                onValueChange={(value) => setMode(value as ImportEnvMode)}
                className="gap-0"
              >
                <TabsList>
                  <TabsTrigger value="merge" className="text-xs">
                    Append
                  </TabsTrigger>
                  <TabsTrigger value="replace" className="text-xs">
                    Replace (sync)
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleLoadCurrentKeys}
                disabled={!currentKeysContent}
                className="gap-1.5"
              >
                <RiDownloadLine className="size-3.5" />
                Load current keys
              </Button>
              <Button
                type="submit"
                size="sm"
                loading={isPending}
                disabled={mode === "merge" && !content.trim()}
              >
                {getSubmitLabel()}
              </Button>
            </div>
          </div>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="min-h-[260px] resize-y font-mono text-xs"
            placeholder={[
              "APP_ENV=production",
              "APP_DEBUG=false",
              "@prod @runtime DATABASE_POOL=10",
              "# @phase build",
              "NPM_TOKEN=...",
            ].join("\n")}
          />
          {mode === "replace" && (
            <Alert variant="destructive">
              <AlertDescription className="text-xs">
                Replace mode: keys missing from this file will be deleted for
                (scope={scope}, phase={phase}).
              </AlertDescription>
            </Alert>
          )}
        </form>

        <aside className="rounded-lg border bg-muted/20 p-4">
          <h3 className="text-sm font-medium">Current scope</h3>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border bg-background p-2">
              <dt className="text-muted-foreground">Scope</dt>
              <dd className="mt-1 font-mono">{scope}</dd>
            </div>
            <div className="rounded-md border bg-background p-2">
              <dt className="text-muted-foreground">Keys</dt>
              <dd className="mt-1 font-sans tabular-nums">{secrets.length}</dd>
            </div>
            <div className="rounded-md border bg-background p-2">
              <dt className="text-muted-foreground">Manual</dt>
              <dd className="mt-1 font-sans tabular-nums">{manualCount}</dd>
            </div>
            <div className="rounded-md border bg-background p-2">
              <dt className="text-muted-foreground">Linked</dt>
              <dd className="mt-1 font-sans tabular-nums">{linkedCount}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-col gap-2">
            <h4 className="text-xs font-medium text-muted-foreground">
              Existing keys
            </h4>
            <div className="max-h-48 overflow-auto rounded-md border bg-background">
              {secrets.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  No keys yet.
                </p>
              ) : (
                <ul className="divide-y">
                  {secrets.map((secret) => (
                    <li
                      key={`${secret.key}-${secret.scope}-${secret.phase}`}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                    >
                      <span className="truncate font-mono text-xs">
                        {secret.key}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {secret.phase}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </aside>
      </div>

      <AlertDialog open={showLoadConfirm} onOpenChange={setShowLoadConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace editor contents?</AlertDialogTitle>
            <AlertDialogDescription>
              Loading current keys will overwrite the text currently in the .env
              editor.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={loadCurrentKeys}>
              Load current keys
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showReplaceConfirm}
        onOpenChange={setShowReplaceConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace environment variables?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="flex flex-col gap-3 text-sm text-muted-foreground">
                <p>
                  This will sync secrets for scope{" "}
                  <span className="font-mono text-foreground">{scope}</span> and
                  phase{" "}
                  <span className="font-mono text-foreground">{phase}</span>.
                </p>
                <p>
                  {removedKeys.length} current manual{" "}
                  {removedKeys.length === 1 ? "key is" : "keys are"} missing
                  from this file and will be deleted.
                </p>
                {removedKeys.length > 0 && (
                  <ul className="max-h-32 overflow-auto rounded-md border bg-background p-2 font-mono text-xs text-foreground">
                    {removedKeys.slice(0, 12).map((key) => (
                      <li key={key}>{key}</li>
                    ))}
                    {removedKeys.length > 12 && (
                      <li className="text-muted-foreground">
                        +{removedKeys.length - 12} more
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowReplaceConfirm(false)
                submitImport("replace")
              }}
              className="bg-none bg-destructive text-white hover:bg-destructive/90"
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function SecretsSkeleton(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="skeleton-surface border-b border-border px-4 py-2.5" />
      <div className="divide-y divide-border">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3">
            <div className="h-4 w-40 rounded skeleton-surface" />
            <div className="h-4 w-24 rounded skeleton-surface" />
            <div className="ml-auto flex gap-2">
              <div className="size-7 rounded skeleton-surface" />
              <div className="size-7 rounded skeleton-surface" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/$id/env")({
  head: createPageHead("env"),
  component: AppEnvTab,
})
