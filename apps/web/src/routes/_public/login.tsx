// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { RiEyeLine, RiEyeOffLine } from "@remixicon/react"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { toast } from "sonner"
import { apiFetch } from "../../lib/api"
import { PasskeyButton } from "../../components/auth/PasskeyButton"
import { getGitProviderStatus } from "../../lib/git-providers"
import { resolvePostAuthPath } from "../../lib/auth-guards"
import { getRememberedOnboardingDeploymentSource } from "../../lib/onboarding"
import { usePendingAction } from "../../lib/hooks/use-pending-action"
import { AuthShell, Field } from "../../components/layout/AuthShell"
import { useTranslation } from "react-i18next"
import type { Me } from "@ploydok/shared"

// Compte seedé par `make db-seed` (packages/db/src/seed.ts). Dupliqué ici
// plutôt qu'importé : `@ploydok/db` est server-only et ne doit pas entrer dans
// le graphe client. `import.meta.env.DEV` vaut statiquement false en build prod,
// donc Vite supprime la branche et ces littéraux avec.
const DEV_SEED_EMAIL = "dev@ploydok.local"
const DEV_SEED_PASSWORD = "DEVD-EVDE-VDEV"

export const Route = createFileRoute("/_public/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  component: LoginPage,
})

export function normalizeLoginRedirect(value?: string): string | null {
  if (!value) return null
  if (!value.startsWith("/") || value.startsWith("//")) return null
  try {
    const url = new URL(value, "http://ploydok.local")
    if (url.origin !== "http://ploydok.local") return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

function LoginPage(): React.JSX.Element {
  const { t } = useTranslation("auth")
  const router = useRouter()
  const { redirect } = Route.useSearch()
  const [mode, setMode] = React.useState<"password" | "passkey" | "backup">(
    "password"
  )
  const [email, setEmail] = React.useState("")
  const [postLoginError, setPostLoginError] = React.useState<string | null>(
    null
  )

  const handleAuthSuccess = async (): Promise<void> => {
    setPostLoginError(null)
    try {
      const [me, providers] = await Promise.all([
        apiFetch<Me>("/me"),
        getGitProviderStatus(),
      ])
      const onboardingSource = await getRememberedOnboardingDeploymentSource(
        me.id
      )
      const target = resolvePostAuthPath(
        me,
        providers,
        normalizeLoginRedirect(redirect),
        onboardingSource
      )
      await router.navigate({ href: target })
    } catch {
      setPostLoginError(t("login.postLoginError"))
    }
  }

  return (
    <AuthShell
      title={t("login.title")}
      subtitle={t("login.subtitle")}
      eyebrow={t("login.eyebrow")}
      showcase
    >
      {mode === "password" ? (
        <PasswordModePanel
          onSuccess={handleAuthSuccess}
          onSwitchPasskey={() => setMode("passkey")}
          onSwitchBackup={() => setMode("backup")}
        />
      ) : mode === "passkey" ? (
        <PasskeyModePanel
          email={email}
          onEmailChange={setEmail}
          onSuccess={handleAuthSuccess}
          onSwitchPassword={() => setMode("password")}
          onSwitchBackup={() => setMode("backup")}
        />
      ) : (
        <BackupCodePanel
          onSuccess={handleAuthSuccess}
          onBack={() => setMode("password")}
        />
      )}
      {postLoginError ? (
        <div
          className="rounded-[10px] border border-destructive/20 bg-destructive/10 px-3 py-3 text-sm text-destructive"
          role="alert"
        >
          <p>{postLoginError}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 bg-background text-foreground"
            onClick={() => void handleAuthSuccess()}
          >
            {t("login.retryVerification")}
          </Button>
        </div>
      ) : null}
      <p className="mt-2 text-center text-xs leading-5 text-muted-foreground">
        {t("login.credentialsStay")}
      </p>
    </AuthShell>
  )
}

function PasswordModePanel({
  onSuccess,
  onSwitchPasskey,
  onSwitchBackup,
}: {
  onSuccess: () => Promise<void>
  onSwitchPasskey: () => void
  onSwitchBackup: () => void
}): React.JSX.Element {
  const { t } = useTranslation("auth")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // onSuccess ends in a navigation, so it has to be awaited inside the pending
  // window. Releasing before it resolves re-enables the button while the app
  // is still working.
  const { pending: loading, run } = usePendingAction(async () => {
    await apiFetch("/auth/login/password", {
      method: "POST",
      body: { email, password },
    })
    toast.success(t("login.signedIn"))
    await onSuccess()
  })

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    try {
      await run()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("login.authFailed")
      toast.error(msg)
      setError(msg)
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="space-y-4"
      noValidate
    >
      {import.meta.env.DEV ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="rounded-full border border-border text-muted-foreground"
            title={t("login.devOnly", { email: DEV_SEED_EMAIL })}
            aria-label={t("login.fillDevAccount", { email: DEV_SEED_EMAIL })}
            onClick={() => {
              setEmail(DEV_SEED_EMAIL)
              setPassword(DEV_SEED_PASSWORD)
            }}
          >
            ?
          </Button>
        </div>
      ) : null}
      <Field
        id="email"
        label={t("login.email")}
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        placeholder={t("login.emailPlaceholder")}
      />
      <Field
        id="password"
        label={t("login.password")}
        type={showPassword ? "text" : "password"}
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        placeholder={t("login.passwordPlaceholder")}
        inputClassName="pr-12"
        adornment={
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            className="absolute inset-y-0 right-0 my-auto text-muted-foreground hover:text-foreground active:not-aria-[haspopup]:translate-y-0"
            aria-label={
              showPassword ? t("setup.hidePassword") : t("setup.showPassword")
            }
            aria-controls="password"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((visible) => !visible)}
          >
            {showPassword ? (
              <RiEyeOffLine className="size-4" aria-hidden="true" />
            ) : (
              <RiEyeLine className="size-4" aria-hidden="true" />
            )}
          </Button>
        }
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      <Button
        type="submit"
        loading={loading}
        className="h-11 w-full rounded-[10px]"
      >
        {loading ? t("login.signingIn") : t("login.signIn")}
      </Button>
      <AuthSwitches
        primaryLabel={t("login.usePasskey")}
        onPrimary={onSwitchPasskey}
        secondaryLabel={t("login.useBackupCode")}
        onSecondary={onSwitchBackup}
      />
    </form>
  )
}

function PasskeyModePanel({
  email,
  onEmailChange,
  onSuccess,
  onSwitchPassword,
  onSwitchBackup,
}: {
  email: string
  onEmailChange: (value: string) => void
  onSuccess: () => Promise<void>
  onSwitchPassword: () => void
  onSwitchBackup: () => void
}): React.JSX.Element {
  const { t } = useTranslation("auth")
  return (
    <div className="space-y-4">
      <Field
        id="passkey-email"
        label={t("login.email")}
        type="email"
        autoComplete="email webauthn"
        value={email}
        onChange={onEmailChange}
        placeholder={t("login.emailPlaceholder")}
      />
      <PasskeyButton email={email} onSuccess={onSuccess} />
      <AuthSwitches
        primaryLabel={t("login.usePassword")}
        onPrimary={onSwitchPassword}
        secondaryLabel={t("login.useBackupCode")}
        onSecondary={onSwitchBackup}
      />
    </div>
  )
}

function BackupCodePanel({
  onSuccess,
  onBack,
}: {
  onSuccess: () => Promise<void>
  onBack: () => void
}): React.JSX.Element {
  const { t } = useTranslation("auth")
  const [email, setEmail] = React.useState("")
  const [code, setCode] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  const { pending: loading, run } = usePendingAction(async () => {
    await apiFetch("/auth/backup-codes/consume", {
      method: "POST",
      body: { email, code },
    })
    toast.success(t("login.signedIn"))
    await onSuccess()
  })

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    try {
      await run()
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("login.authFailed")
      toast.error(msg)
      setError(msg)
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="space-y-4"
      noValidate
    >
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("login.backup.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("login.backup.hint")}
        </p>
      </div>
      <Field
        id="email"
        label={t("login.email")}
        type="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        placeholder={t("login.emailPlaceholder")}
      />
      <Field
        id="code"
        label={t("login.backup.code")}
        autoComplete="one-time-code"
        mono
        value={code}
        onChange={(v) => setCode(v.toUpperCase())}
        placeholder={t("login.backup.codePlaceholder")}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription className="break-words">{error}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Button
          type="submit"
          loading={loading}
          className="h-11 w-full rounded-[10px]"
        >
          {loading ? t("login.signingIn") : t("login.signIn")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="w-full"
        >
          {t("login.backup.backToPassword")}
        </Button>
      </div>
    </form>
  )
}

function AuthSwitches({
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
}: {
  primaryLabel: string
  onPrimary: () => void
  secondaryLabel: string
  onSecondary: () => void
}): React.JSX.Element {
  const { t } = useTranslation("common")
  return (
    <div className="space-y-3">
      <div className="relative">
        <div className="absolute inset-0 flex items-center border-border">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center">
          <span className="bg-panel-inset px-2 text-[10px] tracking-wide text-neutral-400 uppercase">
            {t("or")}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onPrimary}
          className="h-auto py-2 text-center text-xs whitespace-normal"
        >
          {primaryLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onSecondary}
          className="h-auto py-2 text-center text-xs whitespace-normal"
        >
          {secondaryLabel}
        </Button>
      </div>
    </div>
  )
}
