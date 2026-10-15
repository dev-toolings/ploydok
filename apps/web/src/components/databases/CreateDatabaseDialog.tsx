// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Switch } from "@workspace/ui/components/switch"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import {
  useCreateDatabase,
  useRegisterExternalDatabase,
} from "../../lib/databases"
import type { DbExposureMode, DbKind, DbPlan } from "../../lib/databases"

interface CreateDatabaseDialogProps {
  open: boolean
  organizationId: string
  onClose: () => void
}

const KINDS: Array<{ value: DbKind; label: string; icon: string }> = [
  { value: "postgres", label: "PostgreSQL 16", icon: "🐘" },
  { value: "mysql", label: "MySQL 8.4", icon: "🐬" },
  { value: "mariadb", label: "MariaDB 11.4", icon: "🦭" },
  { value: "redis", label: "Redis 7", icon: "⚡" },
  { value: "mongo", label: "MongoDB 7", icon: "🍃" },
  { value: "libsql", label: "SQLite / libSQL", icon: "▦" },
]

const PLANS: Array<{ value: DbPlan; labelKey: string; descKey: string }> = [
  { value: "small", labelKey: "plans.small", descKey: "plans.smallDesc" },
  { value: "medium", labelKey: "plans.medium", descKey: "plans.mediumDesc" },
  { value: "large", labelKey: "plans.large", descKey: "plans.largeDesc" },
]

const CREATE_PROGRESS_STAGES = [
  { id: "reserve", untilMs: 1_000 },
  { id: "provision", untilMs: 4_000 },
  { id: "boot", untilMs: 8_000 },
  { id: "probes", untilMs: 13_000 },
] as const

const CREATE_PROGRESS_TICK_MS = 120
const CREATE_SUCCESS_CLOSE_DELAY_MS = 700
const MAX_PENDING_PROGRESS = 94
type CreateMode = "managed" | "external"

function getCreateProgress(elapsedMs: number): number {
  if (elapsedMs <= 0) return 7
  const totalMs =
    CREATE_PROGRESS_STAGES[CREATE_PROGRESS_STAGES.length - 1]?.untilMs ?? 1
  const ratio = Math.min(elapsedMs / totalMs, 1)
  return Math.min(
    MAX_PENDING_PROGRESS,
    Math.round(7 + ratio * (MAX_PENDING_PROGRESS - 7))
  )
}

function getCreateStageId(elapsedMs: number): string {
  return (
    CREATE_PROGRESS_STAGES.find((stage) => elapsedMs <= stage.untilMs)?.id ??
    CREATE_PROGRESS_STAGES[CREATE_PROGRESS_STAGES.length - 1]?.id ??
    "probes"
  )
}

export function CreateDatabaseDialog({
  open,
  organizationId,
  onClose,
}: CreateDatabaseDialogProps): React.JSX.Element {
  const { t } = useTranslation("databases")
  const [mode, setMode] = React.useState<CreateMode>("managed")
  const [kind, setKind] = React.useState<DbKind>("postgres")
  const [plan, setPlan] = React.useState<DbPlan>("small")
  const [publicEnabled, setPublicEnabled] = React.useState(false)
  const [exposureMode, setExposureMode] =
    React.useState<DbExposureMode>("internal")
  const [name, setName] = React.useState("")
  const [phase, setPhase] = React.useState<"form" | "progress" | "done">("form")
  const [elapsedMs, setElapsedMs] = React.useState(0)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [connectionString, setConnectionString] = React.useState("")
  const createDatabase = useCreateDatabase()
  const registerExternalDatabase = useRegisterExternalDatabase()
  const resetCreateMutationRef = React.useRef(createDatabase.reset)
  const resetRegisterMutationRef = React.useRef(registerExternalDatabase.reset)
  const progressTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(
    null
  )
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  const isPending =
    createDatabase.isPending || registerExternalDatabase.isPending
  const progressValue = phase === "done" ? 100 : getCreateProgress(elapsedMs)
  const fallbackName = t("create.fallbackName")
  const displayName = name || fallbackName
  const stageLabel =
    phase === "done"
      ? mode === "external"
        ? t("create.registered")
        : t("create.ready")
      : mode === "external"
        ? t("create.registeringEndpoint")
        : t(`create.stages.${getCreateStageId(elapsedMs)}`)

  React.useEffect(() => {
    resetCreateMutationRef.current = createDatabase.reset
    resetRegisterMutationRef.current = registerExternalDatabase.reset
  }, [createDatabase.reset, registerExternalDatabase.reset])

  const clearTimers = React.useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current)
      progressTimerRef.current = null
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const resetForm = React.useCallback(() => {
    setMode("managed")
    setKind("postgres")
    setPlan("small")
    setPublicEnabled(false)
    setExposureMode("internal")
    setName("")
    setConnectionString("")
  }, [])

  const resetState = React.useCallback(() => {
    clearTimers()
    setPhase("form")
    setElapsedMs(0)
    setActionError(null)
    resetCreateMutationRef.current()
    resetRegisterMutationRef.current()
  }, [clearTimers])

  React.useEffect(() => {
    if (!open) {
      resetState()
    }
  }, [open, resetState])

  React.useEffect(() => {
    return () => {
      clearTimers()
    }
  }, [clearTimers])

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isPending) return
    if (!nextOpen) resetState()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const finalExposureMode = publicEnabled ? exposureMode : "internal"

    setActionError(null)
    setPhase("progress")
    setElapsedMs(0)
    clearTimers()

    if (mode === "managed") {
      progressTimerRef.current = setInterval(() => {
        setElapsedMs((current) => current + CREATE_PROGRESS_TICK_MS)
      }, CREATE_PROGRESS_TICK_MS)
    }

    try {
      if (mode === "external") {
        await registerExternalDatabase.mutateAsync({
          organizationId,
          projectId: organizationId,
          name,
          connectionString,
        })
      } else {
        await createDatabase.mutateAsync({
          organizationId,
          projectId: organizationId,
          kind,
          name,
          plan,
          exposureMode: finalExposureMode,
          publicEnabled,
        })
      }

      clearTimers()
      resetForm()
      setPhase("done")
      setElapsedMs(
        mode === "external"
          ? 0
          : (CREATE_PROGRESS_STAGES[CREATE_PROGRESS_STAGES.length - 1]
              ?.untilMs ?? 0)
      )

      closeTimerRef.current = setTimeout(() => {
        resetState()
        onClose()
      }, CREATE_SUCCESS_CLOSE_DELAY_MS)
    } catch (err) {
      clearTimers()
      setPhase("form")
      setActionError(
        err instanceof Error ? err.message : t("toasts.actionFailed")
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {phase === "progress" || phase === "done"
              ? mode === "external"
                ? t("create.progressRegistering", { name: displayName })
                : t("create.progressCreating", { name: displayName })
              : t("create.addTitle")}
          </DialogTitle>
          <DialogDescription>
            {phase === "progress" || phase === "done"
              ? mode === "external"
                ? t("create.progressHintExternal")
                : t("create.progressHintManaged")
              : t("create.formHint")}
          </DialogDescription>
        </DialogHeader>

        {phase === "progress" || phase === "done" ? (
          <>
            <div className="flex flex-col gap-4">
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">
                  {mode === "external"
                    ? t("create.externalKind")
                    : `${kind} ${t(`plans.${plan}`)}`}
                </span>
                <span className="mx-2 text-muted-foreground">·</span>
                <span>{displayName}</span>
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between text-sm">
                  <span>{stageLabel}</span>
                  <span className="font-sans tabular-nums">
                    {progressValue}%
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                    style={{ width: `${progressValue}%` }}
                  />
                </div>
                <div className="grid gap-2 text-xs text-muted-foreground">
                  {CREATE_PROGRESS_STAGES.map((stage, index) => {
                    const previousUntilMs =
                      index === 0
                        ? 0
                        : (CREATE_PROGRESS_STAGES[index - 1]?.untilMs ?? 0)
                    const isComplete =
                      phase === "done" || elapsedMs > stage.untilMs
                    const isCurrent =
                      !isComplete && elapsedMs >= previousUntilMs
                    return (
                      <div key={stage.id} className="flex items-center gap-2">
                        <span
                          className={[
                            "inline-flex size-2 rounded-full",
                            isComplete
                              ? "bg-primary"
                              : isCurrent
                                ? "bg-primary/70"
                                : "bg-muted-foreground/30",
                          ].join(" ")}
                        />
                        <span>{t(`create.stages.${stage.id}`)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={isPending}
              >
                {phase === "done" ? t("create.closing") : t("common:cancel")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="db-mode">{t("create.mode")}</Label>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as CreateMode)}
              >
                <SelectTrigger id="db-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="managed">{t("create.managed")}</SelectItem>
                  <SelectItem value="external">
                    {t("create.external")}
                  </SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">
                {t("create.externalHint")}
              </span>
            </div>

            {mode === "managed" ? (
              <div className="flex flex-col gap-2">
                <Label>{t("create.type")}</Label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {KINDS.map((k) => (
                    <button
                      key={k.value}
                      type="button"
                      onClick={() => setKind(k.value)}
                      className={`flex flex-col items-center gap-1 rounded-md border p-3 text-sm transition-colors ${
                        kind === k.value
                          ? "border-primary bg-primary/10"
                          : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <span className="text-2xl">{k.icon}</span>
                      <span>{k.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex flex-col gap-2">
              <Label htmlFor="db-name">{t("create.name")}</Label>
              <Input
                id="db-name"
                placeholder={t("create.namePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                pattern="[a-z0-9-]+"
                required
              />
              <span className="text-xs text-muted-foreground">
                {t("create.nameHint")}
              </span>
            </div>

            {mode === "managed" ? (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="db-plan">{t("create.plan")}</Label>
                  <Select
                    value={plan}
                    onValueChange={(v) => setPlan(v as DbPlan)}
                  >
                    <SelectTrigger id="db-plan">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLANS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          <span className="font-medium">{t(p.labelKey)}</span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t(p.descKey)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="db-public">
                        {t("create.publicAccess")}
                      </Label>
                      <span className="text-xs text-muted-foreground">
                        {t("create.publicHint")}
                      </span>
                    </div>
                    <Switch
                      id="db-public"
                      checked={publicEnabled}
                      onCheckedChange={(next) => {
                        setPublicEnabled(next)
                        setExposureMode(next ? "direct_port" : "internal")
                      }}
                    />
                  </div>
                  {publicEnabled ? (
                    <div className="mt-3 flex flex-col gap-2">
                      <Label htmlFor="db-exposure-mode">
                        {t("create.exposure")}
                      </Label>
                      <Select
                        value={exposureMode}
                        onValueChange={(v) =>
                          setExposureMode(v as DbExposureMode)
                        }
                      >
                        <SelectTrigger id="db-exposure-mode">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="direct_port">
                            {t("exposure.directPort")}
                          </SelectItem>
                          <SelectItem value="public_proxy">
                            {t("exposure.publicProxy")}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="external-db-url">
                  {t("create.postgresUrl")}
                </Label>
                <Textarea
                  id="external-db-url"
                  value={connectionString}
                  onChange={(e) => setConnectionString(e.target.value)}
                  placeholder={t("create.urlPlaceholder")}
                  spellCheck={false}
                  className="min-h-24 font-mono text-xs"
                />
                <span className="text-xs text-muted-foreground">
                  {t("create.urlHint")}
                </span>
              </div>
            )}

            {actionError ? (
              <p className="text-sm text-destructive" role="alert">
                {actionError}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isPending}
              >
                {t("common:cancel")}
              </Button>
              <Button
                type="submit"
                loading={isPending}
                disabled={
                  !name || (mode === "external" && !connectionString.trim())
                }
              >
                {isPending
                  ? mode === "external"
                    ? t("create.registering")
                    : t("common:creating")
                  : mode === "external"
                    ? t("create.register")
                    : t("common:create")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
