// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { startAuthentication } from "@simplewebauthn/browser"
import { Button } from "@workspace/ui/components/button"
import { useTranslation } from "react-i18next"
import { apiFetch } from "../../lib/api"
import { useLogin } from "../../lib/auth"
import { usePendingAction } from "../../lib/hooks/use-pending-action"

interface LoginOptionsResponse {
  options: Parameters<typeof startAuthentication>[0]["optionsJSON"]
  _challengeKey: string
}

interface PasskeyButtonProps {
  email?: string
  /** Awaited inside the pending window, so it may navigate. */
  onSuccess?: () => void | Promise<void>
  onError?: (err: Error) => void
}

export function PasskeyButton({
  email = "",
  onSuccess,
  onError,
}: PasskeyButtonProps): React.JSX.Element {
  const { t } = useTranslation("auth")
  const login = useLogin()
  const [error, setError] = React.useState<string | null>(null)

  const { pending: loading, run } = usePendingAction(
    async (normalizedEmail: string) => {
      // 1. Get challenge from server
      const { options, _challengeKey } = await apiFetch<LoginOptionsResponse>(
        `/auth/login/options?email=${encodeURIComponent(normalizedEmail)}`
      )

      // 2. Browser WebAuthn
      const credential = await startAuthentication({ optionsJSON: options })

      // 3. Verify with server
      await login.mutateAsync({ credential, _challengeKey })

      await onSuccess?.()
    }
  )

  const handleClick = async (): Promise<void> => {
    const normalizedEmail = email.trim().toLowerCase()
    if (!normalizedEmail) {
      setError(t("passkey.enterEmail"))
      return
    }

    setError(null)
    try {
      await run(normalizedEmail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("login.authFailed")
      setError(msg)
      onError?.(err instanceof Error ? err : new Error(msg))
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        onClick={() => void handleClick()}
        loading={loading}
        className="w-full"
        size="lg"
      >
        {loading ? (
          t("passkey.authenticating")
        ) : (
          <span className="flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" />
              <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
            </svg>
            {t("passkey.signIn")}
          </span>
        )}
      </Button>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
