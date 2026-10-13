// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  RiArrowRightSLine,
  RiFingerprintLine,
  RiKey2Line,
  RiMacbookLine,
  RiShieldCheckLine,
  RiShieldKeyholeLine,
} from "@remixicon/react"
import { useTranslation } from "react-i18next"
import { cn } from "@workspace/ui/lib/utils"
import { useMe } from "../../../../lib/auth"
import { usePasskeys } from "../../../../lib/passkeys"
import { useSessions } from "../../../../lib/sessions"

export const Route = createFileRoute("/_authed/settings/security/posture")({
  component: SecurityPosturePage,
})

type PostureStatus = "strong" | "fair" | "weak"

interface PostureSignal {
  label: string
  verdict: string
  hint: string
  status: PostureStatus
  icon: React.ComponentType<{ className?: string }>
  to?: string
}

function SecurityPosturePage(): React.JSX.Element {
  const { t } = useTranslation("settings")
  const { data: me } = useMe()
  const { data: passkeys } = usePasskeys()
  const { data: sessions } = useSessions()

  const statusStyles: Record<
    PostureStatus,
    { dot: string; text: string; label: string }
  > = {
    strong: {
      dot: "bg-emerald-500 shadow-[0_0_0_4px] shadow-emerald-500/10",
      text: "text-emerald-600 dark:text-emerald-400",
      label: t("posture.strong"),
    },
    fair: {
      dot: "bg-amber-500 shadow-[0_0_0_4px] shadow-amber-500/10",
      text: "text-amber-600 dark:text-amber-400",
      label: t("posture.fair"),
    },
    weak: {
      dot: "bg-destructive shadow-[0_0_0_4px] shadow-destructive/10",
      text: "text-destructive",
      label: t("posture.weak"),
    },
  }

  const passkeyCount = passkeys?.length ?? 0
  const otherSessions = sessions?.filter((s) => !s.is_current).length ?? 0
  const hasBackupCodes = me?.has_backup_codes ?? false
  const hasTotp = me?.has_totp ?? false

  const passkeyStatus: PostureStatus =
    passkeyCount >= 2 ? "strong" : passkeyCount === 1 ? "fair" : "weak"
  const backupStatus: PostureStatus = hasBackupCodes ? "strong" : "weak"
  const totpStatus: PostureStatus = hasTotp ? "strong" : "weak"
  const sessionStatus: PostureStatus =
    otherSessions === 0 ? "strong" : otherSessions <= 2 ? "fair" : "weak"

  const signals: Array<PostureSignal> = [
    {
      label: t("posture.passkeys"),
      verdict:
        passkeyCount === 0
          ? t("posture.passkeysNone")
          : t("posture.passkeysCount", { count: passkeyCount }),
      hint:
        passkeyCount >= 2
          ? t("posture.passkeysStrong")
          : passkeyCount === 1
            ? t("posture.passkeysFair")
            : t("posture.passkeysWeak"),
      status: passkeyStatus,
      icon: RiFingerprintLine,
      to: "/settings/security/passkey",
    },
    {
      label: t("posture.totp"),
      verdict: hasTotp ? t("posture.totpEnabled") : t("posture.totpMissing"),
      hint: hasTotp ? t("posture.totpStrong") : t("posture.totpWeak"),
      status: totpStatus,
      icon: RiShieldCheckLine,
      to: "/settings/security/totp",
    },
    {
      label: t("posture.backup"),
      verdict: hasBackupCodes
        ? t("posture.backupIssued")
        : t("posture.backupMissing"),
      hint: hasBackupCodes
        ? t("posture.backupStrong")
        : t("posture.backupWeak"),
      status: backupStatus,
      icon: RiKey2Line,
    },
    {
      label: t("posture.sessions"),
      verdict:
        otherSessions === 0
          ? t("posture.sessionsOnlyThis")
          : t("posture.sessionsDevices", { count: otherSessions + 1 }),
      hint:
        otherSessions === 0
          ? t("posture.sessionsStrong")
          : t("posture.sessionsWeak"),
      status: sessionStatus,
      icon: RiMacbookLine,
      to: "/settings/security/sessions",
    },
  ]

  return (
    <section
      aria-label={t("posture.aria")}
      className="relative overflow-hidden rounded-2xl rounded-xl bg-panel"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,var(--muted)_0%,transparent_60%)] opacity-70"
      />
      <div className="relative grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)]">
        <div className="flex flex-col justify-between gap-6 border-b border-border p-5 md:border-r md:border-b-0">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <RiShieldKeyholeLine className="size-5" />
            </div>
            <div className="space-y-1">
              <p className="font-sans text-[10px] font-light tracking-wide text-muted-foreground uppercase">
                {t("posture.label")}
              </p>
              <h2 className="font-heading text-lg leading-tight font-medium">
                {t("posture.title")}
              </h2>
            </div>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("posture.intro")}
          </p>
        </div>
        <ul className="divide-y divide-border">
          {signals.map((signal) => (
            <PostureRow
              key={signal.label}
              signal={signal}
              statusStyles={statusStyles}
            />
          ))}
        </ul>
      </div>
    </section>
  )
}

function PostureRow({
  signal,
  statusStyles,
}: {
  signal: PostureSignal
  statusStyles: Record<
    PostureStatus,
    { dot: string; text: string; label: string }
  >
}): React.JSX.Element {
  const { dot, text, label } = statusStyles[signal.status]
  const Icon = signal.icon
  const inner = (
    <div
      className={cn(
        "flex items-center gap-4 p-4 transition-colors",
        signal.to && "group-hover:bg-muted/50"
      )}
    >
      <div className="relative">
        <span
          aria-hidden
          className={cn("absolute top-1 left-1 size-2 rounded-full", dot)}
        />
        <div className="flex size-10 items-center justify-center rounded-md border border-border bg-background">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <p className="text-sm font-medium">{signal.label}</p>
          <p
            className={cn(
              "font-sans text-[10px] tracking-wide uppercase",
              text
            )}
          >
            {label}
          </p>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{signal.verdict}</span>
          <span className="mx-1.5 opacity-40">·</span>
          {signal.hint}
        </p>
      </div>
      {signal.to ? (
        <RiArrowRightSLine className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      ) : null}
    </div>
  )

  return (
    <li className="group">
      {signal.to ? (
        <Link to={signal.to} className="block outline-none">
          {inner}
        </Link>
      ) : (
        inner
      )}
    </li>
  )
}
