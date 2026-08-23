// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../i18n/dialog"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Switch } from "@workspace/ui/components/switch"
import { Badge } from "@workspace/ui/components/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  ALL_EVENTS,
  EVENT_LABELS,
  FUNCTIONAL_KINDS,
  KIND_LABELS,
  isComingSoon,
  useCreateChannel,
  useUpdateChannel,
} from "../../lib/notification-channels"
import { DiscordForm } from "./DiscordForm"
import { SlackForm } from "./SlackForm"
import { TelegramForm } from "./TelegramForm"
import { WhatsAppForm } from "./WhatsAppForm"
import { EmailForm } from "./EmailForm"
import type {
  ChannelEvent,
  NotificationChannel,
  NotificationKind,
} from "../../lib/notification-channels"
import type { WhatsAppProvider } from "./WhatsAppForm"

const ALL_KINDS: ReadonlyArray<NotificationKind> = [
  "discord",
  "slack",
  "email",
  "telegram",
]

interface ChannelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  channel?: NotificationChannel
  appId?: string
}

interface FormState {
  name: string
  kind: NotificationKind
  events: Array<ChannelEvent>
  enabled: boolean
  // discord / slack
  webhookUrl: string
  // telegram
  botToken: string
  chatId: string
  // whatsapp
  waProvider: WhatsAppProvider
  waAccountSid: string
  waAuthToken: string
  waPhoneFrom: string
  waPhoneTo: string
  // email
  emailTo: string
}

function buildInitialState(channel?: NotificationChannel): FormState {
  if (!channel) {
    return {
      name: "",
      kind: "discord",
      events: ["build.failed", "deploy.failed"],
      enabled: true,
      webhookUrl: "",
      botToken: "",
      chatId: "",
      waProvider: "twilio",
      waAccountSid: "",
      waAuthToken: "",
      waPhoneFrom: "",
      waPhoneTo: "",
      emailTo: "",
    }
  }

  const cfg = channel.config
  return {
    name: channel.name,
    kind: channel.kind,
    events: channel.events,
    enabled: channel.enabled,
    webhookUrl:
      cfg.kind === "discord" || cfg.kind === "slack" ? cfg.webhook_url : "",
    botToken: cfg.kind === "telegram" ? cfg.bot_token : "",
    chatId: cfg.kind === "telegram" ? cfg.chat_id : "",
    waProvider:
      cfg.kind === "whatsapp" && "provider" in cfg ? cfg.provider : "twilio",
    waAccountSid:
      cfg.kind === "whatsapp" && "account_sid" in cfg ? cfg.account_sid : "",
    waAuthToken:
      cfg.kind === "whatsapp" && "auth_token" in cfg ? cfg.auth_token : "",
    waPhoneFrom:
      cfg.kind === "whatsapp" && "phone_from" in cfg ? cfg.phone_from : "",
    waPhoneTo:
      cfg.kind === "whatsapp" && "phone_to" in cfg ? cfg.phone_to : "",
    emailTo: cfg.kind === "email" ? cfg.to : "",
  }
}

function buildConfig(state: FormState): Record<string, unknown> {
  switch (state.kind) {
    case "discord":
    case "slack":
      return { webhook_url: state.webhookUrl }
    case "telegram":
      return { bot_token: state.botToken, chat_id: state.chatId }
    case "whatsapp":
      if (state.waProvider === "twilio") {
        return {
          provider: "twilio",
          account_sid: state.waAccountSid,
          auth_token: state.waAuthToken,
          phone_from: state.waPhoneFrom,
          phone_to: state.waPhoneTo,
        }
      }
      return { provider: "meta_cloud" }
    case "email":
      return { to: state.emailTo }
  }
}

export function ChannelDialog({
  open,
  onOpenChange,
  channel,
  appId,
}: ChannelDialogProps): React.JSX.Element {
  const { t } = useTranslation("settings")
  const isEditing = Boolean(channel)
  const [form, setForm] = React.useState<FormState>(() =>
    buildInitialState(channel)
  )

  React.useEffect(() => {
    if (open) {
      setForm(buildInitialState(channel))
    }
  }, [open, channel])

  const createChannel = useCreateChannel(appId)
  const updateChannel = useUpdateChannel(appId)

  const isPending = createChannel.isPending || updateChannel.isPending
  const comingSoon = isComingSoon(form.kind)

  function toggleEvent(event: ChannelEvent) {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (comingSoon) return

    const config = buildConfig(form)

    try {
      if (isEditing && channel) {
        await updateChannel.mutateAsync({
          id: channel.id,
          name: form.name,
          events: form.events,
          enabled: form.enabled,
          config,
        })
        toast.success(t("notifications.channelUpdated"))
      } else {
        await createChannel.mutateAsync({
          name: form.name,
          kind: form.kind,
          events: form.events,
          enabled: form.enabled,
          app_id: appId,
          config,
        })
        toast.success(t("notifications.channelCreated"))
      }
      onOpenChange(false)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : t("notifications.unexpectedError")
      toast.error(message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? t("notifications.editChannel")
              : t("notifications.addChannel")}
          </DialogTitle>
          <DialogDescription>
            {t("notifications.configureChannel")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-5 py-2">
          {/* Nom */}
          <Field>
            <FieldLabel htmlFor="channel-name">
              {t("notifications.name")}
            </FieldLabel>
            <FieldContent>
              <Input
                id="channel-name"
                type="text"
                placeholder={t("notifications.namePlaceholder")}
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                required
              />
            </FieldContent>
          </Field>

          {/* Kind — masqué en édition */}
          {!isEditing && (
            <Field>
              <FieldLabel htmlFor="channel-kind">
                {t("notifications.type")}
              </FieldLabel>
              <FieldContent>
                <Select
                  value={form.kind}
                  onValueChange={(v) =>
                    setForm((p) => ({ ...p, kind: v as NotificationKind }))
                  }
                >
                  <SelectTrigger id="channel-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        <span className="flex items-center gap-2">
                          {KIND_LABELS[k]}
                          {FUNCTIONAL_KINDS.has(k) ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] text-green-600 border-green-600/40 py-0 px-1"
                            >
                              {t("notifications.functional")}
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px] py-0 px-1">
                              {t("notifications.comingSoon")}
                            </Badge>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FieldContent>
              <FieldDescription>
                {t("notifications.kindsReady")}
              </FieldDescription>
            </Field>
          )}

          {/* Config spécifique au kind */}
          {form.kind === "discord" && (
            <DiscordForm
              webhookUrl={form.webhookUrl}
              onChange={(v) => setForm((p) => ({ ...p, webhookUrl: v }))}
            />
          )}
          {form.kind === "slack" && (
            <SlackForm
              webhookUrl={form.webhookUrl}
              onChange={(v) => setForm((p) => ({ ...p, webhookUrl: v }))}
            />
          )}
          {form.kind === "telegram" && (
            <TelegramForm
              botToken={form.botToken}
              chatId={form.chatId}
              onBotTokenChange={(v) => setForm((p) => ({ ...p, botToken: v }))}
              onChatIdChange={(v) => setForm((p) => ({ ...p, chatId: v }))}
            />
          )}
          {form.kind === "whatsapp" && (
            <WhatsAppForm
              provider={form.waProvider}
              twilio={{
                account_sid: form.waAccountSid,
                auth_token: form.waAuthToken,
                phone_from: form.waPhoneFrom,
                phone_to: form.waPhoneTo,
              }}
              onProviderChange={(v) =>
                setForm((p) => ({ ...p, waProvider: v }))
              }
              onTwilioChange={(fields) =>
                setForm((p) => ({
                  ...p,
                  waAccountSid: fields.account_sid ?? p.waAccountSid,
                  waAuthToken: fields.auth_token ?? p.waAuthToken,
                  waPhoneFrom: fields.phone_from ?? p.waPhoneFrom,
                  waPhoneTo: fields.phone_to ?? p.waPhoneTo,
                }))
              }
            />
          )}
          {form.kind === "email" && (
            <EmailForm
              to={form.emailTo}
              onChange={(v) => setForm((p) => ({ ...p, emailTo: v }))}
            />
          )}

          {/* Événements */}
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">
              {t("notifications.eventsTitle")}
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ALL_EVENTS.map((event) => {
                const checked = form.events.includes(event)
                return (
                  <label
                    key={event}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm transition-colors hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      className="size-4 rounded border-border accent-primary"
                      checked={checked}
                      onChange={() => toggleEvent(event)}
                    />
                    <span>{EVENT_LABELS[event]}</span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Enabled switch */}
          <div className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2.5">
            <label htmlFor="channel-enabled" className="text-sm font-medium cursor-pointer">
              {t("notifications.enableChannel")}
            </label>
            <Switch
              id="channel-enabled"
              checked={form.enabled}
              onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common:cancel")}
            </Button>
            <Button type="submit" loading={isPending} disabled={comingSoon}>
              {isPending
                ? t("common:saving")
                : isEditing
                  ? t("notifications.update")
                  : t("notifications.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
