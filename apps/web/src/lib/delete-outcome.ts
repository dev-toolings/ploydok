// SPDX-License-Identifier: AGPL-3.0-only
import i18n from "./i18n"
import type { NotificationEvent } from "./notifications"

export type DeleteOutcome = {
  level: "success" | "warning" | "error"
  text: string
}

function stepLabels(steps: unknown): string {
  if (!Array.isArray(steps)) return ""
  return steps
    .filter((step): step is string => typeof step === "string")
    .map((step) => {
      const key = `apps:deleteSteps.${step}`
      return i18n.exists(key) ? i18n.t(key) : step
    })
    .join(", ")
}

/**
 * The API reports a deletion as done once the app row is gone, with the
 * best-effort cleanup steps that did not complete. Only step names travel
 * in the event: the raw Docker error stays on the job and in the logs.
 */
export function deleteOutcome(evt: NotificationEvent): DeleteOutcome {
  const data = evt.data ?? {}
  const app =
    typeof data.appName === "string" && data.appName
      ? data.appName
      : i18n.t("apps:deleteSteps.app")
  if (evt.type === "app.delete.failed") {
    const steps = stepLabels(data.failedSteps)
    return {
      level: "error",
      text: steps
        ? i18n.t("apps:toasts.deleteFailedSteps", { app, steps })
        : evt.message || i18n.t("apps:toasts.deleteFailed"),
    }
  }
  const warnings = stepLabels(data.warnings)
  if (warnings) {
    return {
      level: "warning",
      text: i18n.t("apps:toasts.deletedWithWarnings", { app, steps: warnings }),
    }
  }
  return {
    level: "success",
    text:
      "appName" in data
        ? i18n.t("apps:toasts.deletedNamed", { app })
        : evt.message || i18n.t("apps:toasts.deleted"),
  }
}

export function toastDeleteOutcome(
  evt: NotificationEvent,
  toast: {
    success: (text: string, opts: { id: string }) => unknown
    warning: (text: string, opts: { id: string }) => unknown
    error: (text: string, opts: { id: string }) => unknown
  }
): DeleteOutcome {
  const outcome = deleteOutcome(evt)
  toast[outcome.level](outcome.text, { id: `delete-app:${evt.appId}` })
  return outcome
}
