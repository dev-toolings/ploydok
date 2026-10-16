// SPDX-License-Identifier: AGPL-3.0-only
import type { CaddyHandler, CaddyRoute, CaddyServer } from "./types"

export const REQUEST_LOGGER = "ploydok_requests"
export const REQUEST_LOG_NAME = `http.log.access.${REQUEST_LOGGER}`
export const requestLogOutput = {
  writer: { output: "stdout" },
  encoder: { format: "json" },
  include: [REQUEST_LOG_NAME],
}

export function requestDefaultLogOutput(log: Record<string, unknown> = {}) {
  const exclude = (log.exclude ?? []) as string[]
  return {
    ...log,
    exclude: exclude.includes(REQUEST_LOG_NAME)
      ? exclude
      : [...exclude, REQUEST_LOG_NAME],
  }
}

/** Mutate the actual request before proxying, so upstream and access log agree. */
export function requestIdHandlers(): CaddyHandler[] {
  return [
    {
      handler: "subroute",
      routes: [
        {
          match: [{ header: { "X-Request-Id": null } }],
          handle: [
            {
              handler: "headers",
              request: { set: { "X-Request-Id": ["{http.request.uuid}"] } },
            },
          ],
        },
      ],
    },
    {
      handler: "log_append",
      key: "request_id",
      value: "{http.request.header.X-Request-Id}",
    },
  ]
}

export function withRequestId(route: CaddyRoute): CaddyRoute {
  if (
    route.handle?.some(
      (h) => h.handler === "log_append" && "key" in h && h.key === "request_id"
    )
  )
    return route
  return { ...route, handle: [...requestIdHandlers(), ...(route.handle ?? [])] }
}

export function requestServerLogs(server: CaddyServer, hosts: string[]) {
  const names = { ...server.logs?.logger_names }
  for (const [host, value] of Object.entries(names)) {
    if ((Array.isArray(value) ? value : [value]).includes(REQUEST_LOGGER))
      delete names[host]
  }
  for (const host of hosts) names[host] = [REQUEST_LOGGER]
  return {
    ...server.logs,
    logger_names: names,
    skip_unmapped_hosts: true,
    should_log_credentials: false,
  }
}
