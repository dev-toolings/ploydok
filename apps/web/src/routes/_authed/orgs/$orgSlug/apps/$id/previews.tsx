// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router"
import { useTranslation } from "react-i18next"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createPageHead } from "../../../../../../lib/page-metadata"
import { apiFetch } from "../../../../../../lib/api/client"
import { ApiError } from "../../../../../../lib/api/errors"

export const Route = createFileRoute(
  "/_authed/orgs/$orgSlug/apps/$id/previews"
)({
  head: createPageHead("previews"),
  component: PreviewsPage,
})

interface PreviewDeployment {
  id: string
  pr_number: number
  head_sha: string
  domain: string | null
  container_id: string | null
  status: "pending" | "building" | "running" | "torn_down" | "failed"
  created_at: string
  expires_at: string | null
}

function PreviewsPage() {
  const { t } = useTranslation("apps")
  const { id: appId } = Route.useParams()

  const {
    data: previews = [],
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["apps", appId, "previews"],
    queryFn: async () => {
      try {
        return await apiFetch<Array<PreviewDeployment>>(`/apps/${appId}/previews`)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return []
        throw err
      }
    },
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false
      return failureCount < 2
    },
  })

  if (isError) {
    return (
      <div className="flex items-center justify-center p-8">
        <p className="text-sm text-red-600">
          {t("previews.loadFailed")}
        </p>
      </div>
    )
  }

  const activePreview = previews.filter((p) => p.status === "running")
  const inactivePreview = previews.filter((p) => p.status !== "running")

  return (
    <div className="w-full space-y-6 px-4 py-6 md:px-8 md:py-8">
      <div>
        <h1 className="text-xl leading-[26px] font-medium text-foreground">{t("previews.title")}</h1>
        <p className="text-sm text-gray-600">
          {t("previews.description")}
        </p>
      </div>

      {isLoading && (
        <Card>
          <CardContent className="pt-6">
            <Skeleton className="h-5 w-40" />
          </CardContent>
        </Card>
      )}

      {!isLoading && previews.length === 0 && (
        <div className="rounded-lg border border-dashed border-panel-border bg-panel-inset px-6 py-10">
          <div className="mx-auto max-w-xl space-y-4 text-center">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              <svg
                aria-hidden="true"
                className="h-5 w-5 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                />
              </svg>
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium">
                {t("previews.notWired")}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("previews.plan")}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("previews.backendHint")}
              </p>
            </div>

            <div className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1 text-xs">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
              />
              <span className="text-muted-foreground">
                {t("previews.planned")}
              </span>
            </div>
          </div>
        </div>
      )}

      {activePreview.length > 0 && (
        <div>
          <h2 className="mb-3 text-base font-medium">{t("previews.active")}</h2>
          <div className="space-y-3">
            {activePreview.map((p) => (
              <PreviewCard key={p.id} preview={p} appId={appId} />
            ))}
          </div>
        </div>
      )}

      {inactivePreview.length > 0 && (
        <div>
          <h2 className="mb-3 text-base font-medium">{t("previews.inactive")}</h2>
          <div className="space-y-3">
            {inactivePreview.map((p) => (
              <PreviewCard key={p.id} preview={p} appId={appId} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PreviewCard({
  preview,
  appId,
}: {
  preview: PreviewDeployment
  appId: string
}) {
  const { t } = useTranslation("apps")
  const queryClient = useQueryClient()
  const teardownPreview = useMutation({
    mutationFn: () =>
      apiFetch(`/apps/${appId}/previews/${preview.pr_number}/teardown`, {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["apps", appId, "previews"],
      })
    },
    onError: (err) => {
      console.error("Failed to teardown preview:", err)
    },
  })

  const statusColor: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    building: "bg-blue-100 text-blue-800",
    running: "bg-green-100 text-green-800",
    torn_down: "bg-gray-100 text-gray-800",
    failed: "bg-red-100 text-red-800",
  }

  const expiresAt = preview.expires_at
    ? new Date(preview.expires_at).toLocaleString()
    : "—"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">PR #{preview.pr_number}</CardTitle>
            <p className="font-mono text-xs text-gray-600">
              {preview.head_sha.slice(0, 7)}
            </p>
          </div>
          <Badge className={statusColor[preview.status]}>
            {preview.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {preview.domain && preview.status === "running" && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-600">{t("previews.previewUrl")}</p>
            <a
              href={`https://${preview.domain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm break-all text-blue-600 hover:underline"
            >
              https://{preview.domain}
            </a>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-600">Created</p>
          <p className="text-sm">
            {new Date(preview.created_at).toLocaleString()}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-600">Expires</p>
          <p className="text-sm">{expiresAt}</p>
        </div>

        {preview.status === "running" && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => teardownPreview.mutate()}
            loading={teardownPreview.isPending}
            className="w-full"
          >
            {teardownPreview.isPending ? t("previews.teardown") : t("previews.teardown")}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
