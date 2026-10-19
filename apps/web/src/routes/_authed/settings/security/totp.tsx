// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import {
  RiCheckboxCircleFill,
  RiDeleteBin6Line,
  RiQrCodeLine,
  RiShieldKeyholeLine,
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
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Switch } from "@workspace/ui/components/switch"
import { Input } from "@workspace/ui/components/input"
import { QRCodeSVG } from "qrcode.react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { createPageHead } from "../../../../lib/page-metadata"
import { copyToClipboard, notifyCopyFailed } from "../../../../lib/clipboard"
import {
  useDeleteTotp,
  useEnrollTotp,
  useTotpStatus,
  useUpdateTotpPreferences,
  useVerifyTotp,
} from "../../../../lib/totp"
import type { TotpEnrollResponse } from "../../../../lib/totp"

export const Route = createFileRoute("/_authed/settings/security/totp")({
  head: createPageHead("totp"),
  component: TotpPage,
})

function TotpPage(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: status, isLoading } = useTotpStatus()
  const [enrollData, setEnrollData] = React.useState<TotpEnrollResponse | null>(
    null
  )
  const [localVerified, setLocalVerified] = React.useState(false)
  const [code, setCode] = React.useState("")
  const [copied, setCopied] = React.useState(false)

  const enrollTotp = useEnrollTotp()
  const verifyTotp = useVerifyTotp()
  const deleteTotp = useDeleteTotp()
  const updateTotpPreferences = useUpdateTotpPreferences()

  const isEnrolled = localVerified || (status?.verified ?? false)
  const requireTotpForSecretReveal = status?.requireTotpForSecretReveal ?? true

  const handleEnroll = (): void => {
    enrollTotp.mutate(undefined, {
      onSuccess: (data) => {
        setEnrollData(data)
        setCode("")
      },
      onError: (err) => {
        toast.error(t("totp.enrollFailed"), { description: err.message })
      },
    })
  }

  const handleVerify = (): void => {
    verifyTotp.mutate(
      { code },
      {
        onSuccess: () => {
          setLocalVerified(true)
          setEnrollData(null)
          setCode("")
          toast.success(t("totp.enabledToast"), {
            description: t("totp.enabledToastHint"),
          })
        },
        onError: (err) => {
          toast.error(t("totp.invalidCode"), { description: err.message })
        },
      }
    )
  }

  const handleCancel = (): void => {
    setEnrollData(null)
    setCode("")
  }

  const handleCopySecret = async (): Promise<void> => {
    if (!enrollData) return
    try {
      await copyToClipboard(enrollData.secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      notifyCopyFailed()
    }
  }

  const handleDelete = (): void => {
    deleteTotp.mutate(undefined, {
      onSuccess: () => {
        setLocalVerified(false)
        toast.success(t("totp.disabledToast"), {
          description: t("totp.disabledToastHint"),
        })
      },
      onError: (err) => {
        toast.error(t("totp.disableFailed"), { description: err.message })
      },
    })
  }

  const handleSecretRevealProtectionChange = (checked: boolean): void => {
    updateTotpPreferences.mutate(
      { requireTotpForSecretReveal: checked },
      {
        onSuccess: () => {
          toast.success(
            checked ? t("totp.revealRequired") : t("totp.revealDisabled")
          )
        },
        onError: (err) => {
          toast.error(t("totp.revealUpdateFailed"), {
            description: err.message,
          })
        },
      }
    )
  }

  if (isLoading) {
    return (
      <CardFrame>
        <Skeleton className="h-10 w-full rounded-md" />
      </CardFrame>
    )
  }

  if (isEnrolled) {
    return (
      <div className="space-y-4">
        <TotpEnabledView
          onDelete={handleDelete}
          isPending={deleteTotp.isPending}
        />
        <SecretRevealProtectionCard
          checked={requireTotpForSecretReveal}
          onCheckedChange={handleSecretRevealProtectionChange}
          isPending={updateTotpPreferences.isPending}
        />
      </div>
    )
  }

  if (enrollData !== null) {
    return (
      <div className="space-y-4">
        <TotpScanView
          enrollData={enrollData}
          code={code}
          onCodeChange={setCode}
          onVerify={handleVerify}
          onCancel={handleCancel}
          onCopySecret={() => void handleCopySecret()}
          copied={copied}
          isPending={verifyTotp.isPending}
          error={verifyTotp.error}
        />
        <SecretRevealProtectionCard
          checked={requireTotpForSecretReveal}
          onCheckedChange={handleSecretRevealProtectionChange}
          isPending={updateTotpPreferences.isPending}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <TotpIdleView onEnable={handleEnroll} isPending={enrollTotp.isPending} />
      <SecretRevealProtectionCard
        checked={requireTotpForSecretReveal}
        onCheckedChange={handleSecretRevealProtectionChange}
        isPending={updateTotpPreferences.isPending}
      />
    </div>
  )
}

function TotpIdleView({
  onEnable,
  isPending,
}: {
  onEnable: () => void
  isPending: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <CardFrame
      title={t("totp.title")}
      description={t("totp.idleHint")}
      icon={RiShieldKeyholeLine}
    >
      <Button size="sm" onClick={onEnable} loading={isPending} className="mt-2">
        {t("totp.enable")}
      </Button>
    </CardFrame>
  )
}

function TotpScanView({
  enrollData,
  code,
  onCodeChange,
  onVerify,
  onCancel,
  onCopySecret,
  copied,
  isPending,
  error,
}: {
  enrollData: TotpEnrollResponse
  code: string
  onCodeChange: (v: string) => void
  onVerify: () => void
  onCancel: () => void
  onCopySecret: () => void
  copied: boolean
  isPending: boolean
  error: { message: string } | null
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  const isValidCode = /^[0-9]{6}$/.test(code)

  return (
    <CardFrame
      title={t("totp.scan")}
      description={t("totp.scanHint")}
      icon={RiQrCodeLine}
    >
      <div className="mt-4 flex flex-col items-center gap-5">
        <div className="rounded-lg border border-border bg-white p-3">
          <QRCodeSVG value={enrollData.otpauthUrl} size={200} />
        </div>

        <div className="w-full space-y-1">
          <p className="font-sans text-xs text-muted-foreground">
            {t("totp.manualEntry")}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
              {enrollData.secret}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={onCopySecret}
              className="shrink-0 font-sans text-[11px]"
            >
              {copied ? t("totp.copied") : t("common:copy")}
            </Button>
          </div>
        </div>

        <div className="w-full space-y-2">
          <label
            htmlFor="totp-code"
            className="font-sans text-xs text-muted-foreground"
          >
            {t("totp.verificationCode")}
          </label>
          <Input
            id="totp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, ""))}
            placeholder="000000"
            className="h-auto px-3 py-2 text-center font-mono text-lg tracking-[0.4em] placeholder:text-muted-foreground/40 md:text-lg"
            aria-describedby={error ? "totp-error" : undefined}
          />
          {error ? (
            <p
              id="totp-error"
              role="alert"
              className="text-xs text-destructive"
            >
              {error.message}
            </p>
          ) : null}
        </div>

        <div className="flex w-full gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={isPending}
            className="flex-1"
          >
            {t("common:cancel")}
          </Button>
          <Button
            size="sm"
            onClick={onVerify}
            loading={isPending}
            disabled={!isValidCode}
            className="flex-1"
          >
            {t("totp.verifyEnable")}
          </Button>
        </div>
      </div>
    </CardFrame>
  )
}

function TotpEnabledView({
  onDelete,
  isPending,
}: {
  onDelete: () => void
  isPending: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <CardFrame
      title={t("totp.title")}
      description={t("totp.enabledHint")}
      icon={RiCheckboxCircleFill}
    >
      <div className="mt-3 flex items-center justify-between gap-4">
        <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <RiCheckboxCircleFill className="size-3.5 shrink-0" />
          {t("totp.enabled")}
        </p>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              loading={isPending}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RiDeleteBin6Line className="mr-1.5 size-3.5" />
              {t("totp.disable")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia>
                <RiDeleteBin6Line />
              </AlertDialogMedia>
              <AlertDialogTitle>{t("totp.disableConfirm")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("totp.disableHint")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("totp.keep")}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onDelete}>
                {t("totp.disable")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </CardFrame>
  )
}

function SecretRevealProtectionCard({
  checked,
  onCheckedChange,
  isPending,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  isPending: boolean
}): React.JSX.Element {
  const { t } = useTranslation("settings")
  return (
    <CardFrame
      title={t("totp.secretReveal")}
      description={t("totp.secretRevealHint")}
      icon={RiShieldKeyholeLine}
    >
      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("totp.requireForReveal")}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t("totp.requireHint")}
          </p>
        </div>
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={isPending}
          aria-label={t("totp.requireAria")}
        />
      </div>
    </CardFrame>
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
