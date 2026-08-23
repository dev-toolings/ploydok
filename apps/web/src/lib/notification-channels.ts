// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { apiFetch } from "./api"
import i18n from "./i18n"
import type { ApiError } from "./api"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotificationKind =
  | "discord"
  | "slack"
  | "telegram"
  | "whatsapp"
  | "email"

export type ChannelEvent =
  | "build.started"
  | "build.succeeded"
  | "build.failed"
  | "deploy.succeeded"
  | "deploy.failed"
  | "webhook.rotated"
  | "app.autohealed"
  | "app.autoheal_failed"
  | "image.auto_updated"

export interface DiscordConfig {
  webhook_url: string
}

export interface SlackConfig {
  webhook_url: string
}

export interface TelegramConfig {
  bot_token: string
  chat_id: string
}

export type WhatsAppProvider = "twilio" | "meta_cloud"

export interface TwilioConfig {
  provider: "twilio"
  account_sid: string
  auth_token: string
  phone_from: string
  phone_to: string
}

export interface MetaCloudConfig {
  provider: "meta_cloud"
}

export type WhatsAppConfig = TwilioConfig | MetaCloudConfig

export interface EmailConfig {
  to: string
}

export type ChannelConfig =
  | ({ kind: "discord" } & DiscordConfig)
  | ({ kind: "slack" } & SlackConfig)
  | ({ kind: "telegram" } & TelegramConfig)
  | ({ kind: "whatsapp" } & WhatsAppConfig)
  | ({ kind: "email" } & EmailConfig)

export interface NotificationChannel {
  id: string
  name: string
  kind: NotificationKind
  events: Array<ChannelEvent>
  enabled: boolean
  app_id?: string
  project_id?: string
  config: ChannelConfig
  created_at: string
  updated_at: string
}

export interface CreateChannelInput {
  name: string
  kind: NotificationKind
  events: Array<ChannelEvent>
  enabled: boolean
  app_id?: string
  config: Record<string, unknown>
}

export interface UpdateChannelInput {
  name?: string
  events?: Array<ChannelEvent>
  enabled?: boolean
  config?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export function channelsQueryKey(appId?: string) {
  return appId
    ? ["notifications", "channels", "app", appId]
    : ["notifications", "channels", "global"]
}

// ---------------------------------------------------------------------------
// useChannels — GET /notifications/channels[?appId=...]
// ---------------------------------------------------------------------------

interface ChannelsResponse {
  channels: Array<NotificationChannel>
}

export function useChannels(appId?: string) {
  const path = appId
    ? `/notifications/channels?appId=${encodeURIComponent(appId)}`
    : "/notifications/channels"

  return useQuery<Array<NotificationChannel>, ApiError>({
    queryKey: channelsQueryKey(appId),
    queryFn: async () => {
      const data = await apiFetch<ChannelsResponse>(path)
      return data.channels
    },
    staleTime: 30_000,
  })
}

// ---------------------------------------------------------------------------
// useCreateChannel — POST /notifications/channels
// ---------------------------------------------------------------------------

export function useCreateChannel(appId?: string) {
  const qc = useQueryClient()

  return useMutation<NotificationChannel, ApiError, CreateChannelInput>({
    mutationFn: async (input) => {
      return apiFetch<NotificationChannel>("/notifications/channels", {
        method: "POST",
        body: input,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: channelsQueryKey(appId) })
    },
  })
}

// ---------------------------------------------------------------------------
// useUpdateChannel — PATCH /notifications/channels/:id
// ---------------------------------------------------------------------------

export function useUpdateChannel(appId?: string) {
  const qc = useQueryClient()

  return useMutation<
    NotificationChannel,
    ApiError,
    { id: string } & UpdateChannelInput
  >({
    mutationFn: async ({ id, ...input }) => {
      return apiFetch<NotificationChannel>(`/notifications/channels/${id}`, {
        method: "PATCH",
        body: input,
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: channelsQueryKey(appId) })
    },
  })
}

// ---------------------------------------------------------------------------
// useDeleteChannel — DELETE /notifications/channels/:id
// ---------------------------------------------------------------------------

export function useDeleteChannel(appId?: string) {
  const qc = useQueryClient()

  return useMutation<void, ApiError, string>({
    mutationFn: async (id) => {
      await apiFetch<void>(`/notifications/channels/${id}`, {
        method: "DELETE",
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: channelsQueryKey(appId) })
    },
  })
}

// ---------------------------------------------------------------------------
// useTestChannel — POST /notifications/channels/:id/test
// ---------------------------------------------------------------------------

interface TestChannelResponse {
  success: boolean
  message?: string
}

export function useTestChannel() {
  return useMutation<TestChannelResponse, ApiError, string>({
    mutationFn: async (id) => {
      return apiFetch<TestChannelResponse>(
        `/notifications/channels/${id}/test`,
        { method: "POST" }
      )
    },
  })
}

// ---------------------------------------------------------------------------
// useToggleChannel — PATCH enabled only (convenience for the switch)
// ---------------------------------------------------------------------------

export function useToggleChannel(appId?: string) {
  const qc = useQueryClient()

  return useMutation<
    NotificationChannel,
    ApiError,
    { id: string; enabled: boolean }
  >({
    mutationFn: async ({ id, enabled }) => {
      return apiFetch<NotificationChannel>(`/notifications/channels/${id}`, {
        method: "PATCH",
        body: { enabled },
      })
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: channelsQueryKey(appId) })
    },
  })
}

// ---------------------------------------------------------------------------
// Helpers / constants
// ---------------------------------------------------------------------------

export function eventLabel(event: ChannelEvent): string {
  return i18n.t(`settings:notifications.events.${event}`)
}

export const EVENT_LABELS: Record<ChannelEvent, string> = new Proxy(
  {} as Record<ChannelEvent, string>,
  {
    get: (_target, event: string) =>
      eventLabel(event as ChannelEvent),
  }
)

export const ALL_EVENTS: ReadonlyArray<ChannelEvent> = [
  "build.started",
  "build.succeeded",
  "build.failed",
  "deploy.succeeded",
  "deploy.failed",
  "webhook.rotated",
  "app.autohealed",
  "app.autoheal_failed",
  "image.auto_updated",
]

export const KIND_LABELS: Record<NotificationKind, string> = {
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  email: "Email",
}

export const FUNCTIONAL_KINDS: ReadonlySet<NotificationKind> = new Set([
  "discord",
  "slack",
  "email",
  "telegram",
])

export function isComingSoon(kind: NotificationKind): boolean {
  return !FUNCTIONAL_KINDS.has(kind)
}
