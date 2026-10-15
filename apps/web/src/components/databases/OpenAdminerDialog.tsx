// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { apiBaseUrl } from "../../lib/api/base"
import {
  useCreateAdminerSession,
  useRevealDatabaseCredentials,
} from "../../lib/databases"
import i18n from "../../lib/i18n"
import type { AdminerSessionLaunch, Database } from "../../lib/databases"

const AUTO_HIDE_PASSWORD_MS = 30_000

interface OpenAdminerDialogProps {
  database: Database | null
  onClose: () => void
}

function adminerUrl(path: string): string {
  const base = apiBaseUrl().replace(/\/+$/, "")
  return `${base}${path}`
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function extractPassword(connectionString: string): string {
  const schemeEnd = connectionString.indexOf("://")
  if (schemeEnd === -1) {
    throw new Error(i18n.t("databases:toasts.schemeMissing"))
  }

  const rest = connectionString.slice(schemeEnd + 3)
  const authorityEndCandidates = ["/", "?", "#"]
    .map((separator) => rest.indexOf(separator))
    .filter((index) => index !== -1)
  const authorityEnd =
    authorityEndCandidates.length > 0
      ? Math.min(...authorityEndCandidates)
      : rest.length
  const authority = rest.slice(0, authorityEnd)
  const atIndex = authority.lastIndexOf("@")
  if (atIndex === -1) {
    throw new Error(i18n.t("databases:toasts.credentialsMissing"))
  }

  const userInfo = authority.slice(0, atIndex)
  const passwordSeparator = userInfo.indexOf(":")
  if (passwordSeparator === -1) {
    throw new Error(i18n.t("databases:toasts.passwordMissing"))
  }

  const password = safeDecode(userInfo.slice(passwordSeparator + 1))
  if (!password) {
    throw new Error(i18n.t("databases:toasts.passwordMissing"))
  }
  return password
}

async function copyTextToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Fall back to the legacy path below for plain HTTP/IP origins.
    }
  }

  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.top = "0"

  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()

  try {
    const copied = document.execCommand("copy")
    if (!copied) throw new Error(i18n.t("databases:toasts.copyFailed"))
  } finally {
    textarea.remove()
  }
}

export function OpenAdminerDialog({
  database,
  onClose,
}: OpenAdminerDialogProps): React.JSX.Element {
  const { t, i18n: i18nInstance } = useTranslation("databases")
  const [totpCode, setTotpCode] = React.useState("")
  const [launch, setLaunch] = React.useState<AdminerSessionLaunch | null>(null)
  const [revealedPassword, setRevealedPassword] = React.useState<string | null>(
    null
  )
  const [passwordCountdown, setPasswordCountdown] = React.useState(0)
  const createSession = useCreateAdminerSession()
  const reveal = useRevealDatabaseCredentials()

  const open = Boolean(database)
  const launchUrl = launch ? adminerUrl(launch.path) : null

  React.useEffect(() => {
    if (!revealedPassword) {
      setPasswordCountdown(0)
      return
    }

    setPasswordCountdown(AUTO_HIDE_PASSWORD_MS / 1000)
    const timer = window.setInterval(() => {
      setPasswordCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(timer)
          setRevealedPassword(null)
          return 0
        }

        return current - 1
      })
    }, 1000)

    return () => window.clearInterval(timer)
  }, [revealedPassword])

  function handleClose() {
    setTotpCode("")
    setLaunch(null)
    setRevealedPassword(null)
    onClose()
  }

  function handleCreateSession() {
    if (!database) return
    createSession.mutate(
      { id: database.id, totpCode },
      {
        onSuccess: (nextLaunch) => {
          setLaunch(nextLaunch)
          setTotpCode("")
          setRevealedPassword(null)
        },
      }
    )
  }

  function handleRevealPassword() {
    if (!database) return
    reveal.mutate(
      { id: database.id },
      {
        onSuccess: (credentials) => {
          try {
            const password =
              typeof credentials.password === "string" &&
              credentials.password.length > 0
                ? credentials.password
                : extractPassword(credentials.connection_string)
            setRevealedPassword(password)
            toast.success(t("toasts.passwordRevealed"))
          } catch {
            toast.error(t("toasts.passwordExtractFailed"))
          }
        },
        onError: (err: Error) => {
          toast.error(err.message || t("toasts.revealFailed"))
        },
      }
    )
  }

  function handleCopyPassword() {
    if (!revealedPassword) return
    void copyTextToClipboard(revealedPassword)
      .then(() => toast.success(t("toasts.passwordCopied")))
      .catch(() => {
        toast.error(t("toasts.clipboardUnavailable"), {
          description: t("toasts.clipboardHint"),
        })
      })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("adminer.title")}</DialogTitle>
          <DialogDescription>{t("adminer.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {launch ? (
            <div className="grid gap-4 rounded-lg border p-3 text-sm">
              <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
                <span className="text-muted-foreground">
                  {t("adminer.server")}
                </span>
                <span className="truncate font-mono">{launch.server}</span>
                <span className="text-muted-foreground">
                  {t("adminer.database")}
                </span>
                <span className="truncate font-mono">{launch.database}</span>
                <span className="text-muted-foreground">
                  {t("adminer.username")}
                </span>
                <span className="truncate font-mono">{launch.username}</span>
                <span className="text-muted-foreground">
                  {t("adminer.expires")}
                </span>
                <span>
                  {new Date(launch.expires_at).toLocaleTimeString(
                    i18nInstance.language
                  )}
                </span>
              </div>

              {revealedPassword ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="adminer-password">
                      {t("adminer.password")}
                    </Label>
                    <span className="text-xs text-muted-foreground">
                      {t("adminer.autoHide", { seconds: passwordCountdown })}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      id="adminer-password"
                      readOnly
                      value={revealedPassword}
                      className="font-mono text-xs"
                      type="text"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={handleCopyPassword}
                    >
                      {t("common:copy")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="adminer-totp">{t("adminer.totp")}</Label>
              <Input
                id="adminer-totp"
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={totpCode}
                onChange={(event) =>
                  setTotpCode(
                    event.target.value.replace(/\D+/g, "").slice(0, 6)
                  )
                }
                autoComplete="one-time-code"
              />
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={createSession.isPending || reveal.isPending}
          >
            {t("common:close")}
          </Button>
          {launch && launchUrl ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={handleRevealPassword}
                loading={reveal.isPending}
              >
                {reveal.isPending
                  ? t("adminer.revealing")
                  : revealedPassword
                    ? t("adminer.revealAgain")
                    : t("adminer.revealPassword")}
              </Button>
              {revealedPassword ? (
                <Button asChild>
                  <a href={launchUrl} target="_blank" rel="noreferrer">
                    {t("adminer.title")}
                  </a>
                </Button>
              ) : (
                <Button type="button" disabled>
                  {t("adminer.title")}
                </Button>
              )}
            </>
          ) : (
            <Button
              type="button"
              onClick={handleCreateSession}
              loading={createSession.isPending}
              disabled={totpCode.length !== 6}
            >
              {createSession.isPending
                ? t("adminer.opening")
                : t("adminer.createSession")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
