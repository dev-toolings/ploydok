// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Button } from "@workspace/ui/components/button"
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
import {
  RiHistoryLine,
  RiRefreshLine,
  RiRocketLine,
  RiStopCircleLine,
} from "@remixicon/react"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import { useBuilds } from "../../lib/apps"
import {
  useDeployApp,
  useRestartApp,
  useRollbackApp,
  useStopApp,
} from "../../lib/apps-mutations"
import type { AppDetail } from "../../lib/apps"
import type { AppStatus } from "@ploydok/shared"

function isBuildInFlight(status: AppStatus): boolean {
  return (
    status === "building" || status === "pending" || status === "restarting"
  )
}

export function shouldUseDeployLabel(status: AppStatus): boolean {
  return status === "stopped" || status === "failed" || status === "created"
}

export function canStopRuntime(status: AppStatus): boolean {
  return status !== "stopped" && status !== "created"
}

function useScrollbarInset(ref: React.RefObject<HTMLElement | null>): void {
  React.useLayoutEffect(() => {
    const bar = ref.current
    if (!bar) return
    let scroller: HTMLElement | null = bar.parentElement
    while (scroller) {
      const overflowY = getComputedStyle(scroller).overflowY
      if (overflowY === "auto" || overflowY === "scroll") break
      scroller = scroller.parentElement
    }
    if (!scroller) return
    const el = scroller
    const root = document.documentElement
    const sync = () => {
      bar.style.setProperty(
        "--runtime-bar-scrollbar",
        `${el.offsetWidth - el.clientWidth}px`
      )
      // Toasts are portaled to <body>, outside this layout: publish the bar's
      // horizontal center so globals.css can center them over the bar.
      const rect = bar.getBoundingClientRect()
      root.style.setProperty(
        "--runtime-bar-center",
        `${rect.left + rect.width / 2}px`
      )
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    observer.observe(bar)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => {
      observer.disconnect()
      root.style.removeProperty("--runtime-bar-center")
    }
  }, [ref])
}

export function AppHeaderActions({
  app,
}: {
  app: AppDetail
}): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { data: builds } = useBuilds(app.id, { initialData: app.builds })

  const barRef = React.useRef<HTMLDivElement>(null)
  useScrollbarInset(barRef)

  const deploy = useDeployApp(app.id)
  const restart = useRestartApp(app.id)
  const rollback = useRollbackApp(app.id)
  const stop = useStopApp(app.id)

  const inFlight = isBuildInFlight(app.status)
  const useDeployLabel = shouldUseDeployLabel(app.status)
  const canStop = canStopRuntime(app.status)
  const succeededBuilds = (builds ?? []).filter((b) => b.status === "succeeded")
  const canRollback = succeededBuilds.length >= 2

  return (
    <>
      <div
        ref={barRef}
        data-slot="runtime-action-bar"
        className="pointer-events-none fixed right-[var(--runtime-bar-scrollbar,0px)] bottom-[calc(1rem+env(safe-area-inset-bottom))] left-0 z-30 flex justify-center px-3 md:left-[var(--sidebar-width)] group-data-[sidebar-state=collapsed]/shell:md:left-[calc(var(--sidebar-width-icon)+1rem)]"
      >
        <div
          role="group"
          aria-label={t("actions.runtimeControls")}
          className="pointer-events-auto flex max-w-full items-center gap-2 rounded-2xl border border-border bg-background/95 p-2 shadow-xl backdrop-blur-md"
        >
          <Button
            size="sm"
            variant="default"
            onClick={() => deploy.mutate()}
            loading={deploy.isPending}
            disabled={inFlight}
            title={t("actions.deployHint")}
            className="h-11 gap-1.5 px-3"
          >
            <RiRocketLine className="size-4" aria-hidden="true" />
            {useDeployLabel ? t("actions.deploy") : t("actions.redeploy")}
          </Button>

          <ConfirmButton
            size="sm"
            variant="secondary"
            icon={<RiRefreshLine className="size-4" />}
            label={t("actions.restart")}
            title={t("actions.restartHint")}
            disabled={useDeployLabel || inFlight}
            loading={restart.isPending}
            compact
            confirmTitle={t("actions.restartConfirm")}
            confirmDescription={t("actions.restartConfirmHint")}
            confirmActionLabel={t("actions.restart")}
            onConfirm={() => restart.mutate()}
          />

          {canStop && (
            <ConfirmButton
              size="sm"
              variant="destructive"
              icon={<RiStopCircleLine className="size-4" />}
              label={t("actions.stop")}
              title={t("actions.stopHint")}
              disabled={inFlight}
              loading={stop.isPending}
              compact
              confirmTitle={t("actions.stopConfirmTitle")}
              confirmDescription={
                <>
                  <span className="mb-2 block">
                    {t("actions.stopConfirmBody")}
                  </span>
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    <li>{t("actions.stopConfirm")}</li>
                    <li>{t("actions.stopLost")}</li>
                    <li>{t("actions.stopPreserved")}</li>
                  </ul>
                </>
              }
              confirmActionLabel={t("actions.stopApplication")}
              onConfirm={() => stop.mutate()}
            />
          )}
        </div>
      </div>
      <ConfirmButton
        size="sm"
        variant="secondary"
        icon={<RiHistoryLine className="size-4" />}
        label={t("actions.rollback")}
        title={
          canRollback ? t("actions.rollbackHint") : t("actions.rollbackNeedTwo")
        }
        disabled={rollback.isPending || !canRollback || inFlight}
        loading={rollback.isPending}
        confirmTitle={t("actions.rollbackConfirmTitle")}
        confirmDescription={t("actions.rollbackConfirmHint")}
        confirmActionLabel={t("actions.rollbackAction")}
        onConfirm={() => rollback.mutate()}
      />
    </>
  )
}

interface ConfirmButtonProps {
  size?: "sm" | "default"
  variant: "secondary" | "destructive" | "default"
  icon: React.ReactNode
  label: string
  title: string
  disabled?: boolean
  loading?: boolean
  compact?: boolean
  confirmTitle: string
  confirmDescription: React.ReactNode
  confirmActionLabel: string
  onConfirm: () => void
}

function ConfirmButton({
  size = "default",
  variant,
  icon,
  label,
  title,
  disabled,
  loading,
  compact = false,
  confirmTitle,
  confirmDescription,
  confirmActionLabel,
  onConfirm,
}: ConfirmButtonProps): React.JSX.Element {
  const { t } = useTranslation("common")
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <Button
        size={size}
        variant={variant}
        loading={loading}
        disabled={disabled}
        title={title}
        onClick={() => setOpen(true)}
        aria-label={label}
        className={cn("gap-1.5", compact && "size-11 px-0 sm:w-auto sm:px-3")}
      >
        {icon}
        <span className={compact ? "sr-only sm:not-sr-only" : undefined}>
          {label}
        </span>
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                {confirmDescription}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false)
                onConfirm()
              }}
              className={cn(
                variant === "destructive" &&
                  "bg-destructive bg-none text-white hover:bg-destructive/90"
              )}
            >
              {confirmActionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
