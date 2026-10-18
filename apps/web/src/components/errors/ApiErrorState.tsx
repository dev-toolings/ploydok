// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { Link } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import i18n from "../../lib/i18n"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ApiErrorStateProps {
  code?: string
  status?: number
  message?: string
  onRetry?: () => void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function titleForStatus(code?: string, status?: number): string {
  if (code === "SECOND_FACTOR_REQUIRED")
    return i18n.t("errors:secondFactorRequired")
  if (code === "BACKEND_UNAVAILABLE")
    return i18n.t("errors:backendUnavailable")
  if (status === 401) return i18n.t("errors:notSignedIn")
  if (status === 403) return i18n.t("errors:forbidden")
  if (status === 404) return i18n.t("errors:notFound")
  if (status !== undefined && status >= 500)
    return i18n.t("errors:somethingBroke")
  return i18n.t("errors:somethingWentWrong")
}

function bodyForStatus(status?: number): string | undefined {
  if (status === 401) return i18n.t("errors:notSignedInBody")
  if (status === 403) return i18n.t("errors:forbiddenBody")
  if (status === 404) return i18n.t("errors:notFoundBody")
  if (status !== undefined && status >= 500)
    return i18n.t("errors:somethingBrokeBody")
  return undefined
}

// A client error (bad id, missing rights) fails the same way on every retry.
export function isRetryable(code?: string, status?: number): boolean {
  if (code === "BACKEND_UNAVAILABLE") return true
  if (status === undefined || status === 408 || status === 429) return true
  return status >= 500
}

// ---------------------------------------------------------------------------
// Icons (inline SVG — no extra dep)
// ---------------------------------------------------------------------------

function AlertCircleIcon({
  className,
}: {
  className?: string
}): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function HomeIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  )
}

function RefreshIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApiErrorState({
  code,
  status,
  message,
  onRetry,
}: ApiErrorStateProps): React.JSX.Element {
  const { t } = useTranslation("errors")
  const title = titleForStatus(code, status)
  const body = code === "BACKEND_UNAVAILABLE" ? undefined : bodyForStatus(status)
  const canRetry = onRetry !== undefined && isRetryable(code, status)
  // Outside dev the API message is untranslated; only a 5xx carries a useful
  // request reference.
  const showDetail =
    Boolean(message) &&
    (Boolean(import.meta.env?.DEV) || (status !== undefined && status >= 500))

  // Dedicated branch for SECOND_FACTOR_REQUIRED: show a CTA to configure a
  // second passkey or backup codes instead of a generic error message.
  if (code === "SECOND_FACTOR_REQUIRED") {
    return (
      <div
        role="alert"
        className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl bg-panel p-8 text-center"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertCircleIcon className="size-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">
            {t("secondFactorBody")}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="default" size="sm" asChild>
            <Link to="/settings/security/passkey">{t("configure")}</Link>
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/dashboard">
              <HomeIcon className="mr-1.5 size-3.5" />
              {t("common:goHome")}
            </Link>
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl bg-panel p-8 text-center"
    >
      {/* Icon */}
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircleIcon className="size-6 text-destructive" />
      </div>

      {/* Status badge */}
      {status !== undefined && (
        <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 font-sans text-xs text-muted-foreground">
          {status}
        </span>
      )}

      {/* Title + message */}
      <div className="space-y-2">
        <h2 className="text-base font-medium text-foreground">{title}</h2>
        {body ? (
          <>
            <p className="text-sm text-muted-foreground">{body}</p>
            {showDetail && (
              <p className="rounded-lg border border-panel-border/70 bg-panel-inset px-3 py-2 text-left font-mono text-xs break-words text-muted-foreground">
                {message}
              </p>
            )}
          </>
        ) : (
          message && <p className="text-sm text-muted-foreground">{message}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-center gap-2">
        {canRetry && (
          <Button variant="default" size="sm" onClick={onRetry}>
            <RefreshIcon className="mr-1.5 size-3.5" />
            {t("common:retry")}
          </Button>
        )}
        <Button variant={canRetry ? "ghost" : "default"} size="sm" asChild>
          <Link to="/dashboard">
            <HomeIcon className="mr-1.5 size-3.5" />
            {t("common:goHome")}
          </Link>
        </Button>
      </div>
    </div>
  )
}
