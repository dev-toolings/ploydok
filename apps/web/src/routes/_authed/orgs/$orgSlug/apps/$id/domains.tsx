// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { createFileRoute, useParams } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Separator } from "@workspace/ui/components/separator"
import { Button } from "@workspace/ui/components/button"
import { RiBookOpenLine } from "@remixicon/react"
import { createPageHead } from "../../../../../../lib/page-metadata"
import {
  useCreateDomain,
  useDeleteDomain,
  useDomains,
  useRetryVerification,
  useSwitchTlsMode,
} from "../../../../../../lib/domains"
import { DomainCard } from "../../../../../../components/domains/DomainCard"
import { AddDomainDialog } from "../../../../../../components/domains/AddDomainDialog"
import { TlsModeSwitcher } from "../../../../../../components/domains/TlsModeSwitcher"
import { CdnSection } from "../../../../../../components/apps/CdnSection"
import { ProtectionSection } from "../../../../../../components/apps/ProtectionSection"
import { useMe } from "../../../../../../lib/auth"
import type { Domain } from "../../../../../../lib/domains"

const DOCS_BASE_URL = import.meta.env.VITE_DOCS_URL ?? "http://localhost:4321"

function AppDomainsTab(): React.JSX.Element {
  const { t } = useTranslation("apps")
  const { id: routeAppId } = useParams({ strict: false })
  const appId = routeAppId!

  const { data: domains, isLoading, isError } = useDomains(appId)
  const { mutate: createDomain, isPending: isAdding } = useCreateDomain(appId)
  const { mutate: deleteDomain, isPending: isDeleting } = useDeleteDomain(appId)
  const { mutate: switchTlsMode, isPending: isSwitching } =
    useSwitchTlsMode(appId)
  const { mutate: retryVerification, isPending: isRetrying } =
    useRetryVerification(appId)
  const { data: me } = useMe()

  const lockReason = me?.needs_second_factor
    ? t("domains.need2fa")
    : undefined

  const [switchTarget, setSwitchTarget] = React.useState<Domain | null>(null)

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-destructive/40 bg-destructive/5 py-12 text-center">
        <p className="text-sm font-medium text-destructive">
          {t("domains.loadFailed")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("domains.loadFailedHint")}
        </p>
      </div>
    )
  }

  return (
    <div className="w-full space-y-4 px-4 py-6 md:px-8 md:py-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium">{t("domains.customTitle")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("domains.customHint")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            asChild
            size="sm"
            variant="outline"
            className="gap-1.5"
            title={t("domains.docsTitle")}
          >
            <a
              href={`${DOCS_BASE_URL}/docs/domains-tls`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <RiBookOpenLine className="size-4" aria-hidden="true" />
              {t("domains.docs")}
            </a>
          </Button>
          <AddDomainDialog
            onAdd={(params) => createDomain(params)}
            isAdding={isAdding}
            lockReason={lockReason}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex flex-col gap-2 rounded-2xl bg-panel px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-14 rounded" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Skeleton className="h-5 w-16 rounded" />
                  <Skeleton className="h-6 w-20 rounded" />
                  <Skeleton className="h-6 w-16 rounded" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : domains && domains.length > 0 ? (
        <div className="space-y-2">
          {domains.map((domain) => (
            <DomainCard
              key={domain.id}
              domain={domain}
              onDelete={(id) => deleteDomain({ domainId: id })}
              onRetry={(id) => retryVerification({ domainId: id })}
              onSwitchMode={(id) => {
                const targetDomain = domains.find((item) => item.id === id)
                if (targetDomain) setSwitchTarget(targetDomain)
              }}
              isDeleting={isDeleting}
              isRetrying={isRetrying}
              lockReason={lockReason}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-panel-border bg-panel-inset py-12 text-center">
          <p className="text-sm font-medium text-muted-foreground">
            {t("domains.emptyCustomTitle")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("domains.emptyCustomHint")}
          </p>
        </div>
      )}

      <p className="px-1 text-[11px] text-muted-foreground">
        {t("domains.verifyHint")}
      </p>

      {switchTarget && (
        <TlsModeSwitcher
          domainId={switchTarget.id}
          currentMode={switchTarget.tlsMode}
          currentProvider={switchTarget.dns01Provider}
          open={Boolean(switchTarget)}
          onOpenChange={(open) => {
            if (!open) setSwitchTarget(null)
          }}
          onSwitch={(params) => switchTlsMode(params)}
          isSwitching={isSwitching}
        />
      )}

      <Separator className="my-4" />

      <section className="flex flex-col gap-3">
        <header>
          <h2 className="text-sm font-medium">{t("domains.cdnSection")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("domains.cdnSectionHint")}
          </p>
        </header>
        <CdnSection appId={appId} />
      </section>

      <Separator className="my-4" />

      <section className="flex flex-col gap-3">
        <header>
          <h2 className="text-sm font-medium">{t("domains.protectionSection")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("domains.protectionSectionHint")}
          </p>
        </header>
        <ProtectionSection appId={appId} />
      </section>
    </div>
  )
}

export const Route = createFileRoute("/_authed/orgs/$orgSlug/apps/$id/domains")(
  {
  head: createPageHead("domains"),
    component: AppDomainsTab,
  }
)
