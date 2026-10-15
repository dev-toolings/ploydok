// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod"

export const NotificationEventEnum = z.enum([
  "build.started",
  "build.succeeded",
  "build.failed",
  "deploy.succeeded",
  "deploy.failed",
  "webhook.rotated",
  "db.rotated",
  "backup.succeeded",
  "backup.failed",
  "backup.stale",
  "cve.detected",
  "app.autohealed",
  "app.autoheal_failed",
  "image.auto_updated",
])
export type NotificationEvent = z.infer<typeof NotificationEventEnum>

// ── Per-kind config schemas ──────────────────────────────────────────────────

export const DiscordConfigSchema = z.object({
  kind: z.literal("discord"),
  webhook_url: z.string().url(),
})
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>

export const SlackConfigSchema = z.object({
  kind: z.literal("slack"),
  webhook_url: z.string().url(),
})
export type SlackConfig = z.infer<typeof SlackConfigSchema>

export const TelegramConfigSchema = z.object({
  kind: z.literal("telegram"),
  bot_token: z.string().min(1),
  chat_id: z.string().min(1),
})
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

export const WhatsAppConfigSchema = z.object({
  kind: z.literal("whatsapp"),
  provider: z.enum(["twilio", "meta_cloud"]),
  account_sid: z.string().optional(),
  auth_token: z.string().optional(),
  phone_from: z.string().optional(),
  phone_to: z.string().optional(),
})
export type WhatsAppConfig = z.infer<typeof WhatsAppConfigSchema>

export const EmailConfigSchema = z.object({
  kind: z.literal("email"),
  to: z.string().email(),
})
export type EmailConfig = z.infer<typeof EmailConfigSchema>

// ── Discriminated union ──────────────────────────────────────────────────────

export const NotificationConfigSchema = z.discriminatedUnion("kind", [
  DiscordConfigSchema,
  SlackConfigSchema,
  TelegramConfigSchema,
  WhatsAppConfigSchema,
  EmailConfigSchema,
])
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>

// ── Channel shape (as stored/returned by API) ────────────────────────────────

export const NotificationChannelSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  project_id: z.string().nullable(),
  kind: z.enum(["discord", "slack", "telegram", "whatsapp", "email"]),
  name: z.string(),
  config: NotificationConfigSchema,
  events: z.array(NotificationEventEnum),
  enabled: z.boolean(),
  last_error: z.string().nullable(),
  last_sent_at: z.string().nullable(),
  created_at: z.string(),
})
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>
