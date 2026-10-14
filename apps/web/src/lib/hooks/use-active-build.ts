// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react"
import { useEventsSubscription } from "../events-provider"
import { useApp } from "../apps"
import type { BuildStatus } from "@ploydok/shared"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActiveBuildState {
  isActive: boolean
  buildId?: string
  status?: BuildStatus
}

// ---------------------------------------------------------------------------
// SSE event shapes (partial — only what we need)
// ---------------------------------------------------------------------------

interface BuildStartedEvent {
  appId: string
  buildId: string
}

interface BuildDoneEvent {
  appId: string
  buildId: string
  status: BuildStatus
}

// ---------------------------------------------------------------------------
// useActiveBuild
//
// Strategy: SSE events are the primary signal for build transitions.
// On mount, if `app.status` is already 'building' we pre-populate the state
// to avoid a false-negative before the first SSE arrives.
// Scoped by appId so events from other apps are ignored.
// ---------------------------------------------------------------------------

export function useActiveBuild(appId: string): ActiveBuildState {
  const { data: app } = useApp(appId)

  const [state, setState] = React.useState<ActiveBuildState>(() => {
    // Pre-populate from server state to avoid a flash of "not building"
    // when the component mounts mid-build.
    if (app?.status === "building") {
      return {
        isActive: true,
        buildId: app.latestBuildId,
        status: "running",
      }
    }
    return { isActive: false }
  })

  // Keep state in sync when app query updates externally (e.g. SSE triggers
  // a refetch and the status flips back to 'running' from 'building').
  React.useEffect(() => {
    if (!app) return
    if (app.status === "building" && !state.isActive) {
      setState({
        isActive: true,
        buildId: app.latestBuildId,
        status: "running" as BuildStatus,
      })
    }
    if (app.status !== "building" && state.isActive && !state.buildId) {
      // Only auto-clear if we don't have a specific buildId tracked via SSE.
      // If we do, let the build.succeeded/failed event clear it.
      setState({ isActive: false })
    }
  }, [app?.status, app?.latestBuildId])

  useEventsSubscription<BuildStartedEvent>("build.started", (ev) => {
    if (ev.appId !== appId) return
    setState({ isActive: true, buildId: ev.buildId, status: "running" })
  })

  useEventsSubscription<BuildDoneEvent>("build.succeeded", (ev) => {
    if (ev.appId !== appId) return
    setState({ isActive: false, buildId: ev.buildId, status: "succeeded" })
  })

  useEventsSubscription<BuildDoneEvent>("build.failed", (ev) => {
    if (ev.appId !== appId) return
    setState({ isActive: false, buildId: ev.buildId, status: "failed" })
  })

  useEventsSubscription<BuildDoneEvent>("build.cancelled", (ev) => {
    if (ev.appId !== appId) return
    setState({ isActive: false, buildId: ev.buildId, status: "cancelled" })
  })

  return state
}
