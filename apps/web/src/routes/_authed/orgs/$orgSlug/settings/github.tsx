// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { RiGithubLine } from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { createPageHead } from "../../../../../lib/page-metadata"
import { useCurrentOrganization } from "../../../../../lib/organizations"
import { useMembers } from "../../../../../lib/memberships"
import {
  useOrganizationGitHubInstallations,
  useRevokeOrganizationGitHubInstallation,
} from "../../../../../lib/github"
import { usePendingAction } from "../../../../../lib/hooks/use-pending-action"
import type { AppInstallation } from "../../../../../lib/github"

export const Route = createFileRoute(
  "/_authed/orgs/$orgSlug/settings/github"
)({
  head: createPageHead("organizationSettings"),
  component: GitHubOrganizationSettingsPage,
})

function flowUrl(
  installUrl: string,
  organizationId: string,
  returnTo: string,
  installationId?: number
): string {
  const url = new URL(installUrl, window.location.origin)
  url.pathname = installationId
    ? `/github/installations/${encodeURIComponent(String(installationId))}/claim`
    : "/github/installations/start"
  url.search = ""
  url.searchParams.set("organizationId", organizationId)
  url.searchParams.set("return_to", returnTo)
  return url.toString()
}

function GitHubOrganizationSettingsPage(): React.JSX.Element {
  const { t } = useTranslation("workspace")
  const { orgSlug } = Route.useParams()
  const organization = useCurrentOrganization()
  const organizationId = organization?.id
  const membersQuery = useMembers(orgSlug)
  const currentMember = membersQuery.data?.members.find((member) => member.is_me)
  const isOwner = currentMember?.role === "owner"
  const installationsQuery = useOrganizationGitHubInstallations(organizationId)
  const revoke = useRevokeOrganizationGitHubInstallation()
  const [selectedInstallation, setSelectedInstallation] =
    React.useState<AppInstallation | null>(null)
  const [revokingInstallationId, setRevokingInstallationId] =
    React.useState<number | null>(null)
  const [flowMessage, setFlowMessage] = React.useState<
    | "installed"
    | "revoked"
    | "membersPermission"
    | "ownerVerification"
    | "revokeError"
    | "error"
    | null
  >(null)
  const externalFlow = usePendingAction(
    async (url: string): Promise<void> => {
      window.location.href = url
    },
    { keepPendingOnSuccess: true }
  )

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (params.get("installed") === "1") setFlowMessage("installed")
    const installError = params.get("install_error")
    if (installError === "github_members_permission_required") {
      setFlowMessage("membersPermission")
    } else if (installError === "github_org_membership_unverified") {
      setFlowMessage("ownerVerification")
    } else if (params.has("install_error")) {
      setFlowMessage("error")
    }
    if (!params.has("installed") && !params.has("install_error")) return
    params.delete("installed")
    params.delete("setup_action")
    params.delete("installation_id")
    params.delete("sync_id")
    params.delete("install_error")
    params.delete("state")
    const next = params.toString()
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${next ? `?${next}` : ""}`
    )
  }, [])

  const startInstall = (installationId?: number): void => {
    if (!organizationId || !installationsQuery.data?.installUrl) return
    const returnTo = window.location.pathname
    void externalFlow
      .run(
        flowUrl(
          installationsQuery.data.installUrl,
          organizationId,
          returnTo,
          installationId
        )
      )
      .catch(() => undefined)
  }

  const handleRevoke = async (): Promise<void> => {
    if (
      !selectedInstallation ||
      !organizationId ||
      revoke.isPending ||
      revokingInstallationId !== null
    ) {
      return
    }
    const installation = selectedInstallation
    setSelectedInstallation(null)
    setFlowMessage(null)
    setRevokingInstallationId(installation.id)
    try {
      await revoke.mutateAsync({
        organizationId,
        installationId: installation.id,
      })
      setFlowMessage("revoked")
    } catch {
      setFlowMessage("revokeError")
    } finally {
      setRevokingInstallationId(null)
    }
  }

  const openRevokeConfirmation = (installation: AppInstallation): void => {
    if (revoke.isPending || revokingInstallationId !== null) return
    setFlowMessage(null)
    setSelectedInstallation(installation)
  }

  const installations = installationsQuery.data?.installations ?? []
  const claimableInstallations =
    installationsQuery.data?.claimableInstallations ?? []

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                <RiGithubLine className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <CardTitle>{t("github.title")}</CardTitle>
                <CardDescription>{t("github.description")}</CardDescription>
              </div>
            </div>
            {isOwner && (
              <Button
                size="sm"
                className="self-start sm:shrink-0"
                loading={externalFlow.pending}
                disabled={!organizationId || !installationsQuery.data?.installUrl}
                onClick={() => startInstall()}
              >
                {t("github.install")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!membersQuery.isLoading && !isOwner && (
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {t("github.ownerOnly")}
            </p>
          )}
          {flowMessage === "installed" && (
            <p className="text-sm text-green-600 dark:text-green-400" role="status">
              {t("github.installed")}
            </p>
          )}
          {flowMessage === "revoked" && (
            <p className="text-sm text-green-600 dark:text-green-400" role="status">
              {t("github.revoked")}
            </p>
          )}
          {flowMessage === "error" && (
            <p className="text-sm text-destructive" role="alert">
              {t("github.installError")}
            </p>
          )}
          {flowMessage === "membersPermission" && (
            <p className="text-sm text-destructive" role="alert">
              {t("github.membersPermissionError")}
            </p>
          )}
          {flowMessage === "ownerVerification" && (
            <p className="text-sm text-destructive" role="alert">
              {t("github.ownerVerificationError")}
            </p>
          )}
          {flowMessage === "revokeError" && (
            <p className="text-sm text-destructive" role="alert">
              {t("github.revokeFailed")}
            </p>
          )}
          {installationsQuery.isLoading || membersQuery.isLoading ? (
            <div
              className="space-y-3"
              aria-busy="true"
              aria-label={t("github.loading")}
            >
              <Skeleton className="h-16 w-full rounded-lg" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </div>
          ) : installationsQuery.error ? (
            <p className="text-sm text-destructive" role="alert">
              {t("github.loadFailed", {
                message: installationsQuery.error.message,
              })}
            </p>
          ) : (
            <InstallationList
              installations={installations}
              isOwner={isOwner}
              pendingExternal={externalFlow.pending}
              pendingRevokeInstallationId={revokingInstallationId}
              onClaim={startInstall}
              onRevoke={openRevokeConfirmation}
              t={t}
            />
          )}
        </CardContent>
      </Card>

      {isOwner && claimableInstallations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("github.claimableTitle")}</CardTitle>
            <CardDescription>{t("github.claimableHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <InstallationList
              installations={claimableInstallations}
              isOwner
              pendingExternal={externalFlow.pending}
              pendingRevokeInstallationId={revokingInstallationId}
              onClaim={startInstall}
              onRevoke={openRevokeConfirmation}
              claimOnly
              t={t}
            />
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={selectedInstallation !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setSelectedInstallation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("github.revokeConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("github.revokeHint", {
                login: selectedInstallation?.accountLogin,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("github.cancel")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void handleRevoke()}
            >
              {t("github.revoke")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function InstallationList({
  installations,
  isOwner,
  pendingExternal,
  pendingRevokeInstallationId,
  onClaim,
  onRevoke,
  claimOnly = false,
  t,
}: {
  installations: Array<AppInstallation>
  isOwner: boolean
  pendingExternal: boolean
  pendingRevokeInstallationId: number | null
  onClaim: (installationId?: number) => void
  onRevoke: (installation: AppInstallation) => void
  claimOnly?: boolean
  t: TFunction
}): React.JSX.Element {
  if (installations.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("github.empty")}</p>
  }

  return (
    <ul className="divide-y divide-border">
      {installations.map((installation) => {
        const granted = !claimOnly && installation.granted === true
        const isRevoking = pendingRevokeInstallationId === installation.id
        const accountKind =
          installation.accountType === "User"
            ? t("github.personal")
            : t("github.organization")
        return (
          <li
            key={installation.id}
            className="flex flex-col gap-3 py-3 first:pt-0 sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              {installation.avatarUrl ? (
                <img
                  src={installation.avatarUrl}
                  alt={installation.accountLogin}
                  className="size-9 shrink-0 rounded-full"
                />
              ) : (
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                  {installation.accountLogin.slice(0, 1).toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  @{installation.accountLogin}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {accountKind}
                </p>
              </div>
            </div>
            {isOwner && (
              <Button
                size="sm"
                variant="outline"
                loading={pendingExternal || isRevoking}
                disabled={
                  pendingRevokeInstallationId !== null && !isRevoking
                }
                onClick={() =>
                  pendingRevokeInstallationId !== null
                    ? undefined
                    : granted
                    ? onRevoke(installation)
                    : onClaim(installation.id)
                }
              >
                {claimOnly
                  ? t("github.claim")
                  : granted
                    ? t("github.revoke")
                    : t("github.grant")}
              </Button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
