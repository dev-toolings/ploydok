// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { useTranslation } from "react-i18next"
import {

  CaddyExtraHandlersSchema
} from "@ploydok/shared"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { createPageHead } from "../../../../../../lib/page-metadata"
import {
  useAppCaddyExtra,
  useUpdateAppCaddyExtra,
} from "../../../../../../lib/apps"
import type {CaddyExtraHandlers} from "@ploydok/shared";

export const Route = createFileRoute(
  "/_authed/orgs/$orgSlug/apps/$id/advanced"
)({
  head: createPageHead("advanced"),
  component: AdvancedSettingsPage,
})

function AdvancedSettingsPage() {
  const { t } = useTranslation(["apps", "common"])
  const { id: appId } = Route.useParams()
  const { data, isLoading } = useAppCaddyExtra(appId)
  const updateMutation = useUpdateAppCaddyExtra()

  const [jsonText, setJsonText] = useState(
    data?.handlers ? JSON.stringify(data.handlers, null, 2) : ""
  )
  const [validationError, setValidationError] = useState<string | null>(null)

  const validateJson = (text: string) => {
    if (!text.trim()) {
      setValidationError(null)
      return true
    }

    try {
      const parsed = JSON.parse(text)
      const result = CaddyExtraHandlersSchema.safeParse(parsed)
      if (!result.success) {
        setValidationError(result.error.message)
        return false
      }
      setValidationError(null)
      return true
    } catch (err) {
      setValidationError(String(err))
      return false
    }
  }

  const handleJsonChange = (value: string) => {
    setJsonText(value)
    validateJson(value)
  }

  const handleSave = async () => {
    let handlers: CaddyExtraHandlers | null = null

    if (jsonText.trim()) {
      try {
        const parsed = JSON.parse(jsonText)
        const result = CaddyExtraHandlersSchema.safeParse(parsed)
        if (!result.success) {
          setValidationError(result.error.message)
          return
        }
        handlers = result.data
      } catch (err) {
        setValidationError(String(err))
        return
      }
    }

    await updateMutation.mutateAsync({ appId, handlers })
    setJsonText(handlers ? JSON.stringify(handlers, null, 2) : "")
  }

  if (isLoading) {
    return (
      <div className="w-full space-y-6 px-4 py-6 md:px-8 md:py-8">
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-16 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      </div>
    )
  }

  const isValid = validationError === null

  return (
    <div className="w-full space-y-6 px-4 py-6 md:px-8 md:py-8">
      <div>
        <h2 className="mb-2 text-base font-medium">{t("advanced.title")}</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          {t("advanced.description", {
            docs: t("advanced.docs"),
          })}{" "}
          (
          <a
            href="https://caddyserver.com/docs/json/apps/http/servers/routes/handle/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:text-primary/80"
          >
            {t("advanced.docs")}
          </a>
          )
        </p>
      </div>

      <Alert
        variant="destructive"
        className="border-orange-200 bg-orange-50 dark:border-orange-900 dark:bg-orange-950"
      >
        <AlertDescription className="text-sm text-orange-900 dark:text-orange-100">
          <strong>⚠️ {t("advanced.howItWorks")}</strong>
          {t("advanced.howItWorksBody")}
        </AlertDescription>
      </Alert>

      <div className="space-y-2">
        <label className="block text-sm font-medium">{t("advanced.jsonConfig")}</label>
        <Textarea
          value={jsonText}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            handleJsonChange(e.target.value)
          }
          placeholder={`[\n  { "handler": "headers", "response": { "headers": { "X-Custom": ["value"] } } }\n]`}
          className="h-64 font-mono text-sm"
        />
        {validationError && (
          <div className="text-sm text-destructive">
            <strong>{t("advanced.validationError")}</strong> {validationError}
          </div>
        )}
      </div>

      <details className="rounded-lg border border-border bg-muted/20 p-4 text-sm">
        <summary className="cursor-pointer font-medium">
          {t("advanced.examples")}
        </summary>
        <div className="mt-3 space-y-4">
          <div>
            <p className="mb-1 font-medium">
              {t("advanced.example1")}
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{`[
  {
    "handler": "headers",
    "response": {
      "headers": {
        "Strict-Transport-Security": ["max-age=63072000; includeSubDomains"]
      }
    }
  }
]`}</pre>
          </div>
          <div>
            <p className="mb-1 font-medium">{t("advanced.example2")}</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{`[
  {
    "handler": "static_response",
    "status_code": 301,
    "headers": { "Location": ["/docs"] }
  }
]`}</pre>
          </div>
          <div>
            <p className="mb-1 font-medium">{t("advanced.example3")}</p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">{`[
  {
    "handler": "rewrite",
    "uri": "/v1{http.request.uri.path}"
  }
]`}</pre>
          </div>
        </div>
      </details>

      <div className="flex gap-2">
        <Button
          onClick={handleSave}
          loading={updateMutation.isPending} disabled={!isValid}
          className="w-fit"
        >
          {updateMutation.isPending ? t("advanced.saving") : t("common:save")}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setJsonText(
              data?.handlers ? JSON.stringify(data.handlers, null, 2) : ""
            )
            setValidationError(null)
          }}
          className="w-fit"
        >
          {t("advanced.reset")}
        </Button>
      </div>
    </div>
  )
}
