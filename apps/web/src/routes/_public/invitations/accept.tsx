// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useRouter, useSearch } from "@tanstack/react-router"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useTranslation } from "react-i18next"
import { apiFetch } from "../../../lib/api"
import { useLogout } from "../../../lib/auth"
import {
  invitationLoginPath,
  useAcceptInvitation,
  useInvitationPreview,
  useRegisterFromInvitation,
  validateInvitationPasswords,
} from "../../../lib/memberships"
import { InvitationTokenLifecycle } from "../../../components/invitations/InvitationTokenLifecycle"
import type { Me } from "@ploydok/shared"

export const Route = createFileRoute("/_public/invitations/accept")({
  validateSearch: (search: Record<string, unknown>) => {
    return {
      token: (search.token as string) || "",
    }
  },
  component: AcceptInvitationPage,
})

function AcceptInvitationPage(): React.JSX.Element {
  const { t } = useTranslation("auth")
  const { token: urlToken } = useSearch({ from: Route.id })
  const [token] = React.useState(() => {
    if (urlToken) return urlToken
    if (typeof window === "undefined") return ""
    return window.sessionStorage.getItem("ploydok.invitation-token") ?? ""
  })
  const router = useRouter()
  const [authenticatedEmail, setAuthenticatedEmail] = React.useState<
    string | null
  >(null)
  const [meLoading, setMeLoading] = React.useState(true)
  const [registering, setRegistering] = React.useState(false)
  const [displayName, setDisplayName] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [passwordConfirmation, setPasswordConfirmation] = React.useState("")
  const [registerError, setRegisterError] = React.useState<string | null>(null)

  React.useEffect(() => {
    apiFetch<Me>("/me")
      .then((user) => setAuthenticatedEmail(user.email))
      .catch(() => {
        setAuthenticatedEmail(null)
      })
      .finally(() => {
        setMeLoading(false)
      })
  }, [])

  const { data: preview, isLoading, error } = useInvitationPreview(token)
  const acceptMutation = useAcceptInvitation()
  const registerMutation = useRegisterFromInvitation()
  const logout = useLogout()

  const tokenLifecycle = (
    <InvitationTokenLifecycle urlToken={urlToken} error={error} />
  )

  const acceptAndRedirect = async (): Promise<void> => {
    const data = await acceptMutation.mutateAsync({ token })
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem("ploydok.invitation-token")
    }
    await router.navigate({
      to: `/orgs/${data.organization.slug}/dashboard`,
    })
  }

  const handleRegister = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault()
    setRegisterError(null)
    const passwordError = validateInvitationPasswords(
      password,
      passwordConfirmation
    )
    if (passwordError) {
      setRegisterError(passwordError)
      return
    }
    try {
      const registration = await registerMutation.mutateAsync({
        token,
        display_name: displayName,
        password,
      })
      setAuthenticatedEmail(registration.user.email)
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem("ploydok.invitation-token")
      }
      await router.navigate({
        to: `/orgs/${registration.organization.slug}/dashboard`,
      })
    } catch (registrationError) {
      if (registrationError instanceof Error) {
        setRegisterError(registrationError.message)
      }
    }
  }

  const handleSignIn = () => {
    void router.navigate({
      to: invitationLoginPath(token),
    })
  }

  const handleSwitchAccount = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        setAuthenticatedEmail(null)
        setRegistering(false)
      },
    })
  }

  if (isLoading || meLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background p-4 text-foreground">
        {tokenLifecycle}
        <div className="w-full max-w-sm">
          <div className="h-8 w-48 skeleton-surface rounded" />
          <div className="mt-4 h-32 w-full skeleton-surface rounded" />
        </div>
      </div>
    )
  }

  if (error || !preview) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background p-4 text-foreground">
        {tokenLifecycle}
        <div className="w-full max-w-sm space-y-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex size-10 items-center justify-center rounded-[10px] bg-primary text-base font-bold text-primary-foreground">
              P
            </div>
            <div className="space-y-1">
              <h1 className="text-2xl leading-tight font-semibold tracking-tight">
                {t("invitation.invalidTitle")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("invitation.invalid")}
              </p>
            </div>
          </div>

          <div className="flex justify-center gap-2">
            <Button onClick={() => void router.navigate({ to: "/login" })}>
              {t("invitation.backToLogin")}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const emailMismatch =
    authenticatedEmail !== null &&
    authenticatedEmail.trim().toLowerCase() !==
      preview.email.trim().toLowerCase()

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4 text-foreground">
      {tokenLifecycle}
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-[10px] bg-primary text-base font-bold text-primary-foreground">
            P
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl leading-tight font-semibold tracking-tight">
              {t("invitation.join", { org: preview.org_name })}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("invitation.invitedToCollaborate")}
            </p>
          </div>
        </div>

        <div className="rounded-2xl bg-panel p-5 shadow-[var(--shadow-card)]">
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {t("invitation.invitedBy", {
                  inviter: preview.inviter_email,
                  org: preview.org_name,
                  role: preview.role,
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("invitation.invitationEmail")}{" "}
                <span className="font-mono">{preview.email}</span>
              </p>
            </div>

            {emailMismatch && (
              <div className="rounded-md border border-yellow-600/30 bg-yellow-600/10 px-4 py-3">
                <p className="text-sm text-yellow-600">
                  <strong>{t("invitation.note")}</strong>{" "}
                  {t("invitation.wrongAccount", {
                    expected: preview.email,
                    actual: authenticatedEmail,
                  })}
                </p>
              </div>
            )}

            {!authenticatedEmail && registering ? (
              <form
                className="space-y-4"
                onSubmit={(event) => void handleRegister(event)}
              >
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="invite-email">
                    {t("login.email")}
                  </label>
                  <Input id="invite-email" value={preview.email} disabled />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="display-name">
                    {t("invitation.displayName")}
                  </label>
                  <Input
                    id="display-name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="name"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="invite-password"
                  >
                    {t("invitation.password")}
                  </label>
                  <Input
                    id="invite-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    minLength={12}
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("invitation.passwordHint")}
                  </p>
                </div>
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="invite-password-confirmation"
                  >
                    {t("invitation.confirmPassword")}
                  </label>
                  <Input
                    id="invite-password-confirmation"
                    type="password"
                    value={passwordConfirmation}
                    onChange={(event) =>
                      setPasswordConfirmation(event.target.value)
                    }
                    autoComplete="new-password"
                    required
                  />
                </div>
                {registerError ? (
                  <p className="text-sm text-destructive" role="alert">
                    {registerError}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  loading={
                    registerMutation.isPending || acceptMutation.isPending
                  }
                >
                  {t("invitation.createAndAccept")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full"
                  onClick={() => setRegistering(false)}
                  disabled={
                    registerMutation.isPending || acceptMutation.isPending
                  }
                >
                  {t("common:back")}
                </Button>
              </form>
            ) : !authenticatedEmail ? (
              <div className="space-y-2">
                <Button onClick={handleSignIn} size="lg" className="w-full">
                  {t("invitation.signInToAccept")}
                </Button>
                <Button
                  onClick={() => setRegistering(true)}
                  size="lg"
                  className="w-full"
                  variant="outline"
                >
                  {t("invitation.createAccount")}
                </Button>
              </div>
            ) : emailMismatch ? (
              <Button
                onClick={handleSwitchAccount}
                size="lg"
                className="w-full"
                variant="outline"
                loading={logout.isPending}
              >
                {t("invitation.signOutSwitch")}
              </Button>
            ) : (
              <Button
                onClick={() => void acceptAndRedirect()}
                loading={acceptMutation.isPending}
                size="lg"
                className="w-full"
              >
                {acceptMutation.isPending
                  ? t("invitation.accepting")
                  : t("invitation.accept")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
