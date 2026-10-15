// SPDX-License-Identifier: AGPL-3.0-only
import { TelegramConfigSchema } from "@ploydok/shared"
import type { NotificationEvent } from "@ploydok/shared"
import type { NotificationAdapter, ChannelRow, NotificationPayload } from "./types"
import { childLogger } from "../logger"

const log = childLogger("notify.telegram")

const EVENT_EMOJI: Record<NotificationEvent, string> = {
  "build.started": "🔨",
  "build.succeeded": "✅",
  "build.failed": "❌",
  "deploy.succeeded": "🚀",
  "deploy.failed": "💥",
  "webhook.rotated": "🔑",
  "db.rotated": "🔐",
  "backup.succeeded": "💾",
  "backup.failed": "💥",
  "backup.stale": "⚠️",
  "cve.detected": "🚨",
  "app.autohealed": "🩹",
  "app.autoheal_failed": "🚑",
  "image.auto_updated": "⬆️",
}

// Telegram HTML parse_mode allows a small tag subset. We escape &, <, > on any
// user-controlled string that is interpolated outside of tags.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function buildTelegramMessage(
  event: NotificationEvent,
  payload: NotificationPayload,
): string {
  const lines: string[] = []
  const emoji = EVENT_EMOJI[event] ?? "🔔"
  lines.push(`${emoji} <b>${escapeHtml(event)}</b>`)
  lines.push("")
  lines.push(`<b>App</b>: ${escapeHtml(payload.appName)}`)
  if (payload.commitSha) {
    lines.push(`<b>SHA</b>: <code>${escapeHtml(payload.commitSha.slice(0, 8))}</code>`)
  }
  if (payload.durationMs != null) {
    lines.push(`<b>Durée</b>: ${Math.round(payload.durationMs / 1000)}s`)
  }
  if (payload.appDomain) {
    const url = `https://${payload.appDomain}`
    lines.push(`<b>URL</b>: <a href="${escapeHtml(url)}">${escapeHtml(payload.appDomain)}</a>`)
  }
  if (payload.errorMessage) {
    const truncated = payload.errorMessage.slice(0, 500)
    lines.push("")
    lines.push(`<b>Erreur</b>:`)
    lines.push(`<pre>${escapeHtml(truncated)}</pre>`)
  }
  if (payload.advisoryId) {
    lines.push("")
    lines.push(`<b>Advisory</b>: <code>${escapeHtml(payload.advisoryId)}</code>`)
    lines.push(`<b>Sévérité</b>: ${escapeHtml(payload.advisorySeverity ?? "UNKNOWN")}`)
    lines.push(
      `<b>Package</b>: ${escapeHtml(payload.packageName ?? "unknown")}@${escapeHtml(payload.currentVersion ?? "unknown")}`
    )
    if (payload.advisoryUrl) {
      lines.push(`<b>Détail</b>: <a href="${escapeHtml(payload.advisoryUrl)}">${escapeHtml(payload.advisoryUrl)}</a>`)
    }
  }
  return lines.join("\n")
}

type FetchFn = typeof fetch

export function createTelegramAdapter(fetchFn: FetchFn = fetch): NotificationAdapter {
  return {
    async send(channel: ChannelRow, event: NotificationEvent, payload: NotificationPayload) {
      const parsed = TelegramConfigSchema.safeParse(channel.config)
      if (!parsed.success) {
        return { ok: false, reason: "invalid telegram config" }
      }
      const { bot_token, chat_id } = parsed.data

      const url = `https://api.telegram.org/bot${bot_token}/sendMessage`
      const body = {
        chat_id,
        text: buildTelegramMessage(event, payload),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }

      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          log.warn(
            { status: res.status, channelId: channel.id },
            `Telegram API returned ${res.status}: ${text}`,
          )
          return { ok: false, reason: `HTTP ${res.status}` }
        }
        // Telegram returns { ok: true, result: {...} } on success; parse defensively
        const payloadRes = (await res.json().catch(() => null)) as
          | { ok?: boolean; description?: string }
          | null
        if (payloadRes && payloadRes.ok === false) {
          log.warn(
            { channelId: channel.id, description: payloadRes.description },
            "Telegram API responded ok=false",
          )
          return { ok: false, reason: payloadRes.description ?? "telegram error" }
        }
        return { ok: true }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        log.warn({ err, channelId: channel.id }, "Telegram sendMessage failed")
        return { ok: false, reason }
      }
    },
  }
}

export const telegramAdapter: NotificationAdapter = createTelegramAdapter()
