// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { QRCodeSVG } from "qrcode.react"
import { RiEyeLine, RiEyeOffLine } from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"
import { SetupAdminFormSchema, fieldErrors } from "@ploydok/shared"
import { createPageHead } from "../../lib/page-metadata"
import i18n from "../../lib/i18n"
import { copyToClipboard } from "../../lib/clipboard"
import { apiFetch } from "../../lib/api"
import { ApiError } from "../../lib/api/errors"
import { usePendingAction } from "../../lib/hooks/use-pending-action"
import {
  AuthShell,
  AuthShowcaseFrame,
  Field,
  ShowcasePanel,
  ShowcaseStep,
} from "../../components/layout/AuthShell"

interface SetupSearch {
  token?: string
}

interface InstanceStateResponse {
  bootstrapped: boolean
  setup_token_required: boolean
  setup_session_grant_allowed: boolean
}

interface SetupPasswordResponse {
  user: { id: string; email: string; display_name: string }
  accessExpiresAt?: number
  backup_codes: Array<string>
}

interface TotpEnrollResponse {
  otpauthUrl: string
  secret: string
}

type SetupStep = "form" | "totp" | "codes"

const SETUP_EYEBROW_KEY = "setup.eyebrow" as const

// Compte seedé par `make db-seed` (packages/db/src/seed.ts). Dupliqué ici
// plutôt qu'importé : `@ploydok/db` est server-only. `import.meta.env.DEV`
// vaut statiquement false en build prod, donc Vite supprime la branche.
const DEV_SEED_EMAIL = "dev@ploydok.local"
const DEV_SEED_NAME = "Dev"
const DEV_SEED_PASSWORD = "DEVD-EVDE-VDEV"

/**
 * Panneau de droite du wizard. Il remplace le pitch produit de /login : à ce
 * stade l'opérateur n'a pas besoin d'être convaincu, il a besoin de savoir
 * combien d'étapes il reste.
 */
function FirstBootShowcase({ step }: { step: SetupStep }): React.JSX.Element {
  const { t } = useTranslation("auth")
  const index: Record<SetupStep, number> = { form: 1, totp: 2, codes: 3 }
  const current = index[step]
  const state = (position: number): { done?: boolean; active?: boolean } =>
    position < current
      ? { done: true }
      : position === current
        ? { active: true }
        : {}

  return (
    <AuthShowcaseFrame
      label={t("setup.showcase.label")}
      badge={t("setup.showcase.badge")}
      eyebrow={t("setup.showcase.eyebrow")}
      title={
        <>
          {t("setup.showcase.titleLine1")}
          <br />
          {t("setup.showcase.titleLine2")}
        </>
      }
      description={t("setup.showcase.description")}
      footer={t("setup.showcase.footer")}
    >
      <ShowcasePanel
        title={t("setup.showcase.panelTitle")}
        meta={t("setup.showcase.panelMeta")}
      >
        <ShowcaseStep
          index="01"
          label={t("setup.showcase.stepAdmin")}
          meta={t("setup.showcase.stepAdminMeta")}
          {...state(1)}
        />
        <ShowcaseStep
          index="02"
          label={t("setup.showcase.stepTotp")}
          meta={t("common:optional")}
          {...state(2)}
        />
        <ShowcaseStep
          index="03"
          label={t("setup.showcase.stepCodes")}
          meta={t("setup.showcase.stepCodesMeta")}
          {...state(3)}
        />
      </ShowcasePanel>
    </AuthShowcaseFrame>
  )
}

export const Route = createFileRoute("/_public/setup")({
  head: createPageHead("setup"),
  validateSearch: (search): SetupSearch => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  loader: async () => {
    const state = await apiFetch<InstanceStateResponse>("/auth/instance-state")
    return {
      setupTokenRequired: state.setup_token_required,
      setupSessionGrantAllowed: state.setup_session_grant_allowed,
    }
  },
  component: SetupPage,
})

function SetupPage(): React.JSX.Element {
  const { t } = useTranslation("auth")
  const router = useRouter()
  const { token } = Route.useSearch()
  const { setupTokenRequired, setupSessionGrantAllowed } = Route.useLoaderData()

  const [step, setStep] = React.useState<SetupStep>("form")
  const [email, setEmail] = React.useState("")
  const [displayName, setDisplayName] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordConfirm, setPasswordConfirm] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [showPasswordConfirm, setShowPasswordConfirm] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [backupCodes, setBackupCodes] = React.useState<Array<string>>([])
  const [acknowledged, setAcknowledged] = React.useState(false)

  const [totpData, setTotpData] = React.useState<TotpEnrollResponse | null>(
    null
  )
  const [totpEnrolling, setTotpEnrolling] = React.useState(false)
  const [totpCode, setTotpCode] = React.useState("")
  const [totpVerifying, setTotpVerifying] = React.useState(false)
  const [totpError, setTotpError] = React.useState<string | null>(null)
  const [totpCopied, setTotpCopied] = React.useState(false)
  const totpEnrollStarted = React.useRef(false)

  // Ouvrir /setup sans query string doit suffire : l'API dépose le token dans
  // un cookie HttpOnly (hors prod). Le POST se fait depuis le navigateur, pas
  // depuis le SSR — sinon le Set-Cookie n'atteindrait jamais l'onglet. Le
  // formulaire se peint tout de suite ; le grant tourne en fond et le submit
  // l'attend si besoin.
  const needsSetupSession = setupTokenRequired && !token
  const [sessionDenied, setSessionDenied] = React.useState(
    needsSetupSession && !setupSessionGrantAllowed
  )
  const grantPromise = React.useRef<Promise<boolean> | null>(null)

  const ensureSetupSession = React.useCallback((): Promise<boolean> => {
    if (!needsSetupSession) return Promise.resolve(true)
    if (!setupSessionGrantAllowed) return Promise.resolve(false)
    if (!grantPromise.current) {
      grantPromise.current = apiFetch("/auth/setup/session", { method: "POST" })
        .then(() => true)
        .catch(() => {
          setSessionDenied(true)
          return false
        })
    }
    return grantPromise.current
  }, [needsSetupSession, setupSessionGrantAllowed])

  React.useEffect(() => {
    void ensureSetupSession()
  }, [ensureSetupSession])

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()

    // Même schéma que `POST /auth/setup/password` : ce qui passe ici passe au
    // serveur, et les messages affichés sont mot pour mot les siens.
    const parsed = SetupAdminFormSchema.safeParse({
      email,
      display_name: displayName,
      password,
      password_confirm: passwordConfirm,
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error))
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    setErrors({})
    try {
      const sessionReady = await ensureSetupSession()
      if (!sessionReady) return
      const created = await apiFetch<SetupPasswordResponse>(
        "/auth/setup/password",
        {
          method: "POST",
          body: { token, ...parsed.data, password_confirm: undefined },
        }
      )
      setBackupCodes(created.backup_codes)
      setStep("totp")
      toast.success(t("setup.accountCreated"))
    } catch (err) {
      // Une validation refusée par le serveur (bornes divergentes, corps
      // altéré) revient annotée par champ : la réafficher au bon endroit
      // plutôt que dans le bandeau global.
      if (err instanceof ApiError && err.fields) setErrors(err.fields)
      const msg =
        err instanceof Error ? err.message : "Setup failed — check API logs"
      setError(msg)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    if (step !== "totp" || totpData || totpEnrollStarted.current) return
    let cancelled = false
    totpEnrollStarted.current = true
    setTotpEnrolling(true)
    setTotpError(null)
    void (async () => {
      try {
        const data = await apiFetch<TotpEnrollResponse>("/auth/totp/enroll", {
          method: "POST",
        })
        if (!cancelled) setTotpData(data)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : t("totp.enrollFailed")
        setTotpError(msg)
        totpEnrollStarted.current = false
      } finally {
        if (!cancelled) setTotpEnrolling(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [step, totpData])

  const handleTotpVerify = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!/^\d{6}$/.test(totpCode)) {
      setTotpError(t("setup.totp.hint"))
      return
    }
    setTotpVerifying(true)
    setTotpError(null)
    try {
      await apiFetch("/auth/totp/verify", {
        method: "POST",
        body: { code: totpCode },
      })
      toast.success(t("setup.totp.enabled"))
      setStep("codes")
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("totp.invalid")
      setTotpError(msg)
      toast.error(msg)
    } finally {
      setTotpVerifying(false)
    }
  }

  const handleCopyTotpSecret = async (): Promise<void> => {
    if (!totpData) return
    try {
      await copyToClipboard(totpData.secret)
      setTotpCopied(true)
      setTimeout(() => setTotpCopied(false), 2000)
    } catch {
      toast.error(t("clipboardUnavailable"))
    }
  }

  // Sortie unique du wizard. Pas de sondage préalable de /me : /onboarding
  // porte déjà `beforeLoad: requireMe()`, qui renvoie sur /login si la session
  // a expiré. Y aller inconditionnellement évite le trou historique — le
  // premier admin n'a par construction aucun provider Git, donc c'est
  // exactement l'écran dont il a besoin.
  const finish = usePendingAction(
    async () => {
      await router.navigate({ to: "/onboarding" })
    },
    { keepPendingOnSuccess: true }
  )

  if (step === "form" && sessionDenied) {
    return (
      <AuthShell
        title={t("setup.tokenRequired")}
        subtitle={t("setup.sessionDenied")}
        eyebrow={t(SETUP_EYEBROW_KEY)}
        showcase={<FirstBootShowcase step="form" />}
      >
        <Alert variant="destructive">
          <AlertDescription className="space-y-3">
            <p>{t("setup.sessionDeniedMessage")}</p>
            <div className="rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground">
              {t("setup.sessionDeniedExample")}
            </div>
            <p>{t("setup.sessionDeniedTokenSource")}</p>
          </AlertDescription>
        </Alert>
      </AuthShell>
    )
  }

  if (step === "totp") {
    return (
      <AuthShell
        title={t("setup.totp.title")}
        subtitle={t("setup.totp.hint")}
        eyebrow={t(SETUP_EYEBROW_KEY)}
        showcase={<FirstBootShowcase step="totp" />}
      >
        {totpEnrolling || !totpData ? (
          <p className="text-sm text-muted-foreground">
            {totpError ?? t("setup.totp.generating")}
          </p>
        ) : (
          <form
            onSubmit={(e) => void handleTotpVerify(e)}
            className="flex flex-col gap-4"
            noValidate
          >
            <div className="flex justify-center">
              <div className="rounded-lg border border-border bg-white p-3">
                <QRCodeSVG value={totpData.otpauthUrl} size={180} />
              </div>
            </div>
            <div className="space-y-1">
              <p className="font-sans text-xs text-muted-foreground">
                {t("setup.totp.manualEntry")}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded border border-border bg-muted px-2 py-1.5 font-mono text-xs">
                  {totpData.secret}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCopyTotpSecret()}
                  className="shrink-0 font-sans text-[11px]"
                >
                  {totpCopied
                    ? t("setup.totp.copied")
                    : t("setup.totp.copySecret")}
                </Button>
              </div>
            </div>
            <Field
              id="totp_code"
              label={t("setup.totp.code")}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={totpCode}
              onChange={(v) => setTotpCode(v.replace(/\D/g, "").slice(0, 6))}
              placeholder={t("setup.totp.codePlaceholder")}
              inputClassName="text-center font-mono text-lg tracking-[0.4em]"
            />
            {totpError && (
              <Alert variant="destructive">
                <AlertDescription>{totpError}</AlertDescription>
              </Alert>
            )}
            <Button
              type="submit"
              loading={totpVerifying}
              disabled={!/^\d{6}$/.test(totpCode)}
              className="h-11 w-full rounded-[10px]"
            >
              {totpVerifying
                ? t("setup.totp.verifying")
                : t("setup.totp.verify")}
            </Button>
          </form>
        )}
        <Button
          type="button"
          variant="ghost"
          className="h-11 w-full rounded-[10px]"
          onClick={() => void finish.run()}
          loading={finish.pending}
          disabled={totpVerifying}
        >
          {t("setup.totp.skip")}
        </Button>
      </AuthShell>
    )
  }

  if (step === "codes") {
    return (
      <AuthShell
        title={t("setup.codes.title")}
        subtitle={t("setup.codes.hint")}
        eyebrow={t(SETUP_EYEBROW_KEY)}
        showcase={<FirstBootShowcase step="codes" />}
      >
        <div className="rounded-md border border-border bg-muted/40 p-4 font-mono text-sm">
          <ul className="grid grid-cols-2 gap-2">
            {backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => downloadBackupCodes(backupCodes, email)}
          >
            {t("setup.codes.download")}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => void copyBackupCodes(backupCodes)}
          >
            {t("setup.codes.copy")}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="size-4 rounded border-input accent-primary"
          />
          {t("setup.codes.acknowledge")}
        </label>
        <Button
          className="h-11 w-full rounded-[10px]"
          disabled={!acknowledged}
          loading={finish.pending}
          onClick={() => void finish.run()}
        >
          {t("setup.codes.continue")}
        </Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title={t("setup.title")}
      subtitle={t("setup.subtitle")}
      eyebrow={t(SETUP_EYEBROW_KEY)}
      showcase={<FirstBootShowcase step="form" />}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex flex-col gap-4"
        noValidate
      >
        {import.meta.env.DEV ? (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              title={t("login.devOnly", { email: DEV_SEED_EMAIL })}
              onClick={() => {
                setEmail(DEV_SEED_EMAIL)
                setDisplayName(DEV_SEED_NAME)
                setPassword(DEV_SEED_PASSWORD)
                setPasswordConfirm(DEV_SEED_PASSWORD)
                setErrors({})
                setError(null)
              }}
            >
              {t("setup.fillDev")}
            </Button>
          </div>
        ) : null}
        <Field
          id="email"
          error={errors["email"]}
          label={t("setup.email")}
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          placeholder={t("login.emailPlaceholder")}
        />
        <Field
          id="display_name"
          error={errors["display_name"]}
          label={t("setup.displayName")}
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
          placeholder={t("setup.displayNamePlaceholder")}
        />
        <Field
          id="password"
          error={errors["password"]}
          label={t("setup.password")}
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          minLength={12}
          maxLength={72}
          placeholder={t("setup.passwordPlaceholder")}
          adornment={
            <PasswordToggle
              visible={showPassword}
              onToggle={() => setShowPassword((v) => !v)}
            />
          }
        />
        <Field
          id="password_confirm"
          error={errors["password_confirm"]}
          label={t("setup.confirmPassword")}
          type={showPasswordConfirm ? "text" : "password"}
          value={passwordConfirm}
          onChange={setPasswordConfirm}
          autoComplete="new-password"
          minLength={12}
          maxLength={72}
          placeholder={t("setup.confirmPasswordPlaceholder")}
          adornment={
            <PasswordToggle
              visible={showPasswordConfirm}
              onToggle={() => setShowPasswordConfirm((v) => !v)}
            />
          }
        />
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          type="submit"
          loading={loading}
          className="h-11 w-full rounded-[10px]"
        >
          {loading ? t("setup.creatingAccount") : t("setup.createAccount")}
        </Button>
      </form>
    </AuthShell>
  )
}

function PasswordToggle({
  visible,
  onToggle,
}: {
  visible: boolean
  onToggle: () => void
}): React.JSX.Element {
  const { t } = useTranslation("auth")
  const label = visible ? t("setup.hidePassword") : t("setup.showPassword")
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
    >
      {visible ? (
        <RiEyeOffLine className="size-4" />
      ) : (
        <RiEyeLine className="size-4" />
      )}
    </button>
  )
}

function buildBackupCodesText(codes: Array<string>, email: string): string {
  const header = [
    "Ploydok backup codes",
    email ? `Account: ${email}` : null,
    `Generated: ${new Date().toISOString()}`,
    "Each code is single-use. Store in a password manager or print and lock away.",
    "",
  ].filter(Boolean) as Array<string>
  return [...header, ...codes].join("\n") + "\n"
}

function downloadBackupCodes(codes: Array<string>, email: string): void {
  const text = buildBackupCodesText(codes, email)
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = "ploydok-backup-codes.txt"
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function copyBackupCodes(codes: Array<string>): Promise<void> {
  try {
    await copyToClipboard(codes.join("\n"))
    toast.success(i18n.t("auth:setup.codes.copied"))
  } catch {
    toast.error(i18n.t("auth:setup.codes.clipboardUnavailable"))
  }
}
