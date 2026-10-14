// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import {
  RiAddLine,
  RiAlarmWarningLine,
  RiDeleteBin6Line,
  RiErrorWarningLine,
  RiFingerprintLine,
  RiKey2Line,
  RiShieldKeyholeLine,
  RiSmartphoneLine,
  RiUsbLine,
} from "@remixicon/react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import {
  useAddPasskey,
  usePasskeys,
  useRemovePasskey,
} from "../../lib/passkeys"
import i18n from "../../lib/i18n"
import type { PasskeyInfo } from "@ploydok/shared"

export function SecurityPasskeysPanel(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: passkeys, isLoading, error } = usePasskeys()

  if (error) {
    return (
      <CardFrame>
        <p className="text-sm text-destructive" role="alert">
          <RiErrorWarningLine className="mr-1.5 inline size-3.5 align-[-2px]" />
          {t("passkeys.loadFailed", { message: error.message })}
        </p>
      </CardFrame>
    )
  }

  const isSoleKey = (passkeys?.length ?? 0) <= 1

  return (
    <div className="space-y-5">
      <AddPasskeyCard />

      <div className="space-y-2">
        <div className="flex items-baseline justify-between px-1">
          <p className="font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
            {t("passkeys.registered")}
          </p>
          <p className="font-sans text-[10px] text-muted-foreground">
            {isLoading
              ? "…"
              : t("passkeys.total", { count: passkeys?.length ?? 0 })}
          </p>
        </div>

        {isLoading ? (
          <LoadingRow />
        ) : passkeys && passkeys.length > 0 ? (
          <ul className="space-y-2">
            {passkeys.map((pk) => (
              <PasskeyRow key={pk.id} passkey={pk} canRemove={!isSoleKey} />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={RiFingerprintLine}
            title={t("passkeys.empty")}
            hint={t("passkeys.emptyHint")}
          />
        )}
      </div>

      {isSoleKey && passkeys && passkeys.length > 0 ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs">
          <RiAlarmWarningLine className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-medium text-foreground">
              {t("passkeys.singlePoint")}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              {t("passkeys.singlePointHint")}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

interface PasskeySupport {
  available: boolean
  message: string | null
}

function detectPasskeySupport(): PasskeySupport {
  if (typeof window === "undefined") return { available: true, message: null }
  if (!window.isSecureContext) {
    return {
      available: false,
      message: i18n.t("settings:passkeys.httpsRequired"),
    }
  }
  if (!("PublicKeyCredential" in window)) {
    return {
      available: false,
      message: i18n.t("settings:passkeys.noWebAuthn"),
    }
  }
  return { available: true, message: null }
}

function AddPasskeyCard(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const addPasskey = useAddPasskey()
  const [deviceName, setDeviceName] = React.useState("")
  const [support, setSupport] = React.useState<PasskeySupport>({
    available: true,
    message: null,
  })
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setSupport(detectPasskeySupport())
  }, [])

  const handleSubmit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    if (!support.available) return

    setError(null)
    try {
      await addPasskey.mutateAsync({ deviceName })
      setDeviceName("")
      toast.success(t("passkeys.enrolled"))
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? t("passkeys.cancelled")
          : err instanceof Error
            ? err.message
            : t("passkeys.enrollFailed")
      setError(message)
      toast.error(message)
    }
  }

  return (
    <CardFrame
      title={t("passkeys.add")}
      description={t("passkeys.addHint")}
      icon={RiFingerprintLine}
    >
      <form
        onSubmit={(event) => void handleSubmit(event)}
        className="space-y-3"
      >
        <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="passkey-device-name">
              {t("passkeys.deviceName")}
            </Label>
            <Input
              id="passkey-device-name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder={t("passkeys.devicePlaceholder")}
              autoComplete="off"
            />
          </div>
          <Button
            type="submit"
            loading={addPasskey.isPending}
            disabled={!support.available}
            className="md:min-w-32"
          >
            <RiAddLine className="size-4" />
            {addPasskey.isPending ? t("passkeys.enrolling") : t("passkeys.add")}
          </Button>
        </div>

        {support.message ? (
          <p className="flex items-start gap-1.5 text-xs leading-5 text-amber-600 dark:text-amber-400">
            <RiAlarmWarningLine className="mt-0.5 size-3.5 shrink-0" />
            {support.message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </CardFrame>
  )
}

interface DeviceKind {
  icon: React.ComponentType<{ className?: string }>
  tagKey:
    | "passkeys.kindHardware"
    | "passkeys.kindMobile"
    | "passkeys.kindTouchId"
    | "passkeys.kindWindowsHello"
    | "passkeys.kindPasskey"
}

function inferDevice(name: string | null): DeviceKind {
  const n = (name ?? "").toLowerCase()
  if (/yubi|nitro|feitian|solokeys|hardware.?key|security.?key|usb/.test(n)) {
    return { icon: RiUsbLine, tagKey: "passkeys.kindHardware" }
  }
  if (/iphone|ipad|android|phone|pixel|galaxy/.test(n)) {
    return { icon: RiSmartphoneLine, tagKey: "passkeys.kindMobile" }
  }
  if (/mac|touch.?id|macbook|imac/.test(n)) {
    return { icon: RiFingerprintLine, tagKey: "passkeys.kindTouchId" }
  }
  if (/windows|hello|thinkpad|surface/.test(n)) {
    return { icon: RiKey2Line, tagKey: "passkeys.kindWindowsHello" }
  }
  return { icon: RiShieldKeyholeLine, tagKey: "passkeys.kindPasskey" }
}

function PasskeyRow({
  passkey,
  canRemove,
}: {
  passkey: PasskeyInfo
  canRemove: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const removePasskey = useRemovePasskey()
  const [removeError, setRemoveError] = React.useState<string | null>(null)
  const { icon: Icon, tagKey } = inferDevice(passkey.device_name)
  const displayName = passkey.device_name ?? t("passkeys.unnamed")
  const createdAbs = new Date(passkey.created_at).toLocaleString()
  const lastUsedAbs = new Date(passkey.last_used_at).toLocaleString()

  const handleRemove = async (): Promise<void> => {
    setRemoveError(null)
    try {
      await removePasskey.mutateAsync(passkey.id)
    } catch (err) {
      setRemoveError(
        err instanceof Error ? err.message : t("passkeys.removeFailed")
      )
    }
  }

  return (
    <li className="group relative rounded-2xl bg-panel transition-colors hover:bg-muted/30">
      <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium">{displayName}</p>
            <span className="inline-flex items-center rounded-full border border-border bg-background px-1.5 py-0.5 font-sans text-[9px] tracking-wide text-muted-foreground uppercase">
              {t(tagKey)}
            </span>
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-0.5 font-sans text-[11px] text-muted-foreground">
            <div className="flex items-center gap-1">
              <dt className="opacity-60">{t("passkeys.added")}</dt>
              <dd title={createdAbs} className="text-foreground/80">
                {relativeTime(passkey.created_at)}
              </dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="opacity-60">{t("passkeys.lastUsed")}</dt>
              <dd title={lastUsedAbs} className="text-foreground/80">
                {relativeTime(passkey.last_used_at)}
              </dd>
            </div>
          </dl>
          {removeError ? (
            <p role="alert" className="text-xs text-destructive">
              {removeError}
            </p>
          ) : null}
        </div>

        <div className="shrink-0">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                loading={removePasskey.isPending}
                disabled={!canRemove}
                aria-label={t("passkeys.removeAria", { name: displayName })}
                className={cn(
                  "text-muted-foreground hover:text-destructive",
                  !canRemove && "cursor-not-allowed"
                )}
              >
                <RiDeleteBin6Line />
                {t("passkeys.remove")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogMedia>
                  <RiDeleteBin6Line />
                </AlertDialogMedia>
                <AlertDialogTitle>
                  {t("passkeys.removeConfirm")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("passkeys.removeHint", { name: displayName })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("passkeys.keep")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => void handleRemove()}
                >
                  {t("passkeys.removePasskey")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </li>
  )
}

function CardFrame({
  title,
  description,
  icon: Icon,
  children,
}: {
  title?: string
  description?: string
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="rounded-2xl bg-panel p-4">
      {title ? (
        <header className="mb-3 flex items-start gap-3">
          {Icon ? (
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <Icon className="size-4 text-muted-foreground" />
            </div>
          ) : null}
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{title}</h3>
            {description ? (
              <p className="text-xs leading-5 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </header>
      ) : null}
      {children}
    </section>
  )
}

function LoadingRow(): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <div
      className="rounded-lg border border-dashed border-panel-border bg-panel-inset p-4"
      aria-busy="true"
      aria-label={t("passkeys.loading")}
    >
      <Skeleton className="h-10 w-full rounded-md" />
    </div>
  )
}

function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  hint: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-panel-border bg-panel-inset px-4 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function relativeTime(iso: string): string {
  const now = Date.now()
  const then = new Date(iso).getTime()
  const diff = Math.max(0, now - then)
  const s = Math.floor(diff / 1000)
  if (s < 45) return i18n.t("settings:relative.justNow")
  const m = Math.floor(s / 60)
  if (m < 60) return i18n.t("settings:relative.minutes", { count: m })
  const h = Math.floor(m / 60)
  if (h < 24) return i18n.t("settings:relative.hours", { count: h })
  const d = Math.floor(h / 24)
  if (d < 7) return i18n.t("settings:relative.days", { count: d })
  const w = Math.floor(d / 7)
  if (w < 5) return i18n.t("settings:relative.weeks", { count: w })
  const mo = Math.floor(d / 30)
  if (mo < 12) return i18n.t("settings:relative.months", { count: mo })
  return i18n.t("settings:relative.years", { count: Math.floor(d / 365) })
}
