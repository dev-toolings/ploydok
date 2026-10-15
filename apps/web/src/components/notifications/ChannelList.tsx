// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { toast } from "sonner"
import {
  RiAddLine,
  RiBellLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFlashlightLine,
} from "@remixicon/react"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { Switch } from "@workspace/ui/components/switch"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  EVENT_LABELS,
  FUNCTIONAL_KINDS,
  KIND_LABELS,
  useChannels,
  useDeleteChannel,
  useTestChannel,
  useToggleChannel,
} from "../../lib/notification-channels"
import { ChannelDialog } from "./ChannelDialog"
import type { NotificationChannel } from "../../lib/notification-channels"

interface ChannelListProps {
  appId?: string
  showHeader?: boolean
}

function KindBadge({ kind }: { kind: NotificationChannel["kind"] }) {
  if (FUNCTIONAL_KINDS.has(kind)) {
    return (
      <Badge
        variant="outline"
        className="border-green-600/40 text-green-700 dark:text-green-400"
      >
        {KIND_LABELS[kind]}
      </Badge>
    )
  }
  return <Badge variant="secondary">{KIND_LABELS[kind]} · Coming soon</Badge>
}

interface ChannelRowProps {
  channel: NotificationChannel
  appId?: string
  onEdit: (channel: NotificationChannel) => void
}

function ChannelRow({ channel, appId, onEdit }: ChannelRowProps) {
  const deleteChannel = useDeleteChannel(appId)
  const testChannel = useTestChannel()
  const toggleChannel = useToggleChannel(appId)

  async function handleDelete() {
    if (!confirm(`Delete "${channel.name}"?`)) return
    try {
      await deleteChannel.mutateAsync(channel.id)
      toast.success("Channel deleted")
    } catch {
      toast.error("Could not delete the channel")
    }
  }

  async function handleTest() {
    try {
      const result = await testChannel.mutateAsync(channel.id)
      if (result.success) {
        toast.success("Test message sent")
      } else {
        toast.error(result.message ?? "The test message failed to send")
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The test message failed to send"
      toast.error(message)
    }
  }

  async function handleToggle(enabled: boolean) {
    try {
      await toggleChannel.mutateAsync({ id: channel.id, enabled })
    } catch {
      toast.error("Could not update the channel")
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-panel-inset p-4 sm:flex-row sm:items-center sm:justify-between shadow-[0_1px_1px_0_#0000000d] dark:shadow-[0_1px_1px_0_#00000024]">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{channel.name}</span>
          <KindBadge kind={channel.kind} />
        </div>
        <p className="text-xs text-muted-foreground">
          {channel.events.length === 0
            ? "No events selected"
            : channel.events.map((e) => EVENT_LABELS[e]).join(", ")}
        </p>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        {channel.enabled && FUNCTIONAL_KINDS.has(channel.kind) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void handleTest()}
            loading={testChannel.isPending}
            title="Send a test message"
          >
            <RiFlashlightLine className="size-4" />
            <span className="sr-only sm:not-sr-only">Test</span>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onEdit(channel)}
          title="Edit"
        >
          <RiEditLine className="size-4" />
          <span className="sr-only">Edit {channel.name}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void handleDelete()}
          loading={deleteChannel.isPending}
          className="text-destructive hover:text-destructive"
          title="Delete"
        >
          <RiDeleteBinLine className="size-4" />
          <span className="sr-only">Delete {channel.name}</span>
        </Button>
        <Switch
          checked={channel.enabled}
          onCheckedChange={(v) => void handleToggle(v)}
          disabled={toggleChannel.isPending}
          size="sm"
          aria-label={`${channel.enabled ? "Disable" : "Enable"} ${channel.name}`}
          title={channel.enabled ? "Disable" : "Enable"}
        />
      </div>
    </div>
  )
}

export function ChannelList({
  appId,
  showHeader = true,
}: ChannelListProps): React.JSX.Element {
  const { data: channels, isLoading } = useChannels(appId)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editingChannel, setEditingChannel] = React.useState<
    NotificationChannel | undefined
  >(undefined)

  function openCreate() {
    setEditingChannel(undefined)
    setDialogOpen(true)
  }

  function openEdit(channel: NotificationChannel) {
    setEditingChannel(channel)
    setDialogOpen(true)
  }

  const isEmpty = !isLoading && (channels?.length ?? 0) === 0

  return (
    <div className="flex flex-col gap-4">
      {showHeader ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-medium">
              Notification channels
            </h2>
            <p className="text-sm text-muted-foreground">
              Get alerted on the tools you already use when something happens.
            </p>
          </div>
          {isEmpty ? null : (
            <Button type="button" size="sm" onClick={openCreate}>
              <RiAddLine className="size-4" />
              Add channel
            </Button>
          )}
        </div>
      ) : isEmpty ? null : (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={openCreate}>
            <RiAddLine className="size-4" />
            Add channel
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      ) : channels && channels.length > 0 ? (
        <div className="flex flex-col gap-3">
          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              appId={appId}
              onEdit={openEdit}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-panel-border bg-panel-inset px-6 py-10 text-center">
          <RiBellLine
            className="mb-3 size-7 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="text-sm font-medium">No channels yet</p>
          <p className="mt-1 mb-4 max-w-xs text-xs text-muted-foreground">
            Add a channel and every build and deployment event lands in
            Discord, Telegram, or your inbox.
          </p>
          <Button type="button" size="sm" onClick={openCreate}>
            <RiAddLine className="size-4" />
            Add channel
          </Button>
        </div>
      )}

      <ChannelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        channel={editingChannel}
        appId={appId}
      />
    </div>
  )
}
