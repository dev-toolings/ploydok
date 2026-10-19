// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { BuildStatusSchema } from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"
import type { ApiCaller, ApiRequest } from "./call"
import { PolicyError, TokenPolicy } from "./policy"
import type { PolicyStore } from "./policy"

export const BUILD_LOG_DEFAULT_BYTES = 64 * 1024
export const BUILD_LOG_MAX_BYTES = 256 * 1024

export type McpAuditEntry = {
  tool: string
  targetType: string
  targetId: string
  ok: boolean
  code?: string
}

export type McpServerDeps = {
  user: AuthUser
  callApi: ApiCaller
  store: PolicyStore
  /** Resolves false when the token exhausted its action budget. */
  allowAction: (tokenId: string) => Promise<boolean>
  audit: (entry: McpAuditEntry) => Promise<void>
}

type ToolOutcome = { payload: unknown } | { error: ToolError }
type ToolError = { code: string; message: string; status?: number }

const ACCEPTED_NOTE =
  "Accepted, not finished. Follow progress with list_builds then get_build_logs."

const appId = z.string().min(1).describe("App id")
const tail = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(200)
  .describe("Number of most recent lines")

export function createPloydokMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: "ploydok", version: "1.0.0" },
    {
      instructions:
        "Ploydok control plane. Read app state, builds and logs, and run " +
        "deployment actions when the token allows them. Every action is " +
        "asynchronous: a success means accepted, not completed.",
    }
  )
  const policy = new TokenPolicy(deps.user, deps.store)

  const call = async (req: ApiRequest): Promise<ToolOutcome> => {
    const res = await deps.callApi(req)
    if (!res.ok) return { error: res.error }
    if ("json" in res) return { payload: res.json }
    return { payload: { text: res.text, omittedBytes: res.omittedBytes } }
  }

  const run = async (
    tool: string,
    target: { type: string; id: string },
    fn: () => Promise<ToolOutcome>
  ): Promise<CallToolResult> => {
    let outcome: ToolOutcome
    try {
      outcome = await fn()
    } catch (err) {
      if (!(err instanceof PolicyError)) throw err
      outcome = { error: { code: err.code, message: err.message } }
    }
    const audited = { tool, targetType: target.type, targetId: target.id }
    if ("error" in outcome) {
      await deps.audit({ ...audited, ok: false, code: outcome.error.code })
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(outcome.error) }],
      }
    }
    await deps.audit({ ...audited, ok: true })
    return {
      content: [{ type: "text", text: JSON.stringify(outcome.payload) }],
    }
  }

  const org = { type: "organization", id: policy.orgId }
  const app = (id: string) => ({ type: "app", id })

  // -- Read -----------------------------------------------------------------

  const readOnly = { readOnlyHint: true, openWorldHint: false }

  server.registerTool(
    "list_apps",
    {
      description: "List the apps of the token's organization.",
      annotations: readOnly,
    },
    () =>
      run("list_apps", org, async () => {
        policy.requireScope("apps:read")
        const out = await call({
          path: "/apps",
          query: { organizationId: policy.orgId },
        })
        if ("error" in out) return out
        const list = (out.payload as { apps?: Array<{ id: string }> }).apps
        return {
          payload: {
            apps: (list ?? []).filter((a) => policy.allowsApp(a.id)),
          },
        }
      })
  )

  server.registerTool(
    "get_app",
    {
      description: "Get one app: configuration, status and domains.",
      inputSchema: { appId },
      annotations: readOnly,
    },
    ({ appId }) =>
      run("get_app", app(appId), async () => {
        policy.requireScope("apps:read")
        await policy.assertApp(appId)
        return call({ path: `/apps/${enc(appId)}` })
      })
  )

  server.registerTool(
    "list_builds",
    {
      description: "List the most recent builds of an app, newest first.",
      inputSchema: {
        appId,
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: readOnly,
    },
    ({ appId, limit }) =>
      run("list_builds", app(appId), async () => {
        policy.requireScope("apps:read")
        await policy.assertApp(appId)
        return call({ path: `/apps/${enc(appId)}/builds`, query: { limit } })
      })
  )

  server.registerTool(
    "get_build_logs",
    {
      description:
        "Get the end of a build's log. `omittedBytes` > 0 means the " +
        "beginning was cut; raise maxBytes to read more.",
      inputSchema: {
        appId,
        buildId: z.string().min(1),
        maxBytes: z
          .number()
          .int()
          .min(1024)
          .max(BUILD_LOG_MAX_BYTES)
          .default(BUILD_LOG_DEFAULT_BYTES),
      },
      annotations: readOnly,
    },
    ({ appId, buildId, maxBytes }) =>
      run("get_build_logs", app(appId), async () => {
        policy.requireScope("apps:read")
        await policy.assertApp(appId)
        return call({
          path: `/apps/${enc(appId)}/logs`,
          query: { buildId },
          tailBytes: maxBytes,
        })
      })
  )

  server.registerTool(
    "get_runtime_logs",
    {
      description:
        "Get recent runtime logs of a running app. source=requests and " +
        "source=all need an organization owner.",
      inputSchema: {
        appId,
        source: z.enum(["app", "requests", "all"]).default("app"),
        tail,
        container: z
          .string()
          .optional()
          .describe("Container id from a previous response"),
      },
      annotations: readOnly,
    },
    ({ appId, source, tail, container }) =>
      run("get_runtime_logs", app(appId), async () => {
        policy.requireScope("apps:read")
        await policy.assertApp(appId)
        return call({
          path: `/apps/${enc(appId)}/runtime-logs`,
          query: { source, tail, container },
        })
      })
  )

  server.registerTool(
    "list_deployments",
    {
      description:
        "List deployments of the organization, newest first. Tokens " +
        "limited to several apps must pass appId.",
      inputSchema: {
        appId: appId.optional(),
        status: z.enum(BuildStatusSchema.options).optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(50).default(20),
      },
      annotations: readOnly,
    },
    ({ appId, status, page, pageSize }) =>
      run("list_deployments", appId ? app(appId) : org, async () => {
        policy.requireScope("apps:read")
        let scopedAppId = appId
        if (scopedAppId) {
          await policy.assertApp(scopedAppId)
        } else if (policy.appIds) {
          if (policy.appIds.length !== 1) {
            throw new PolicyError(
              "APP_ID_REQUIRED",
              "This token is limited to several apps: pass appId"
            )
          }
          scopedAppId = policy.appIds[0]
        }
        const out = await call({
          path: `/organizations/${enc(await policy.orgSlug())}/deployments`,
          query: { appId: scopedAppId, status, page, pageSize },
        })
        if ("error" in out || !policy.appIds) return out
        // The summary counts every app of the organization.
        const { summary: _summary, ...rest } = out.payload as Record<
          string,
          unknown
        >
        return { payload: rest }
      })
  )

  server.registerTool(
    "get_monitoring",
    {
      description:
        "Live container metrics (CPU, memory, restarts) for the organization.",
      annotations: readOnly,
    },
    () =>
      run("get_monitoring", org, async () => {
        policy.requireScope("apps:read")
        const out = await call({
          path: `/organizations/${enc(await policy.orgSlug())}/monitoring/overview`,
        })
        if ("error" in out || !policy.appIds) return out
        const body = out.payload as {
          containers?: Array<{ kind?: string; app_id?: string }>
        }
        return {
          payload: {
            ...body,
            containers: (body.containers ?? []).filter(
              (ct) =>
                (ct.kind === undefined || ct.kind === "app") &&
                !!ct.app_id &&
                policy.allowsApp(ct.app_id)
            ),
          },
        }
      })
  )

  server.registerTool(
    "list_services",
    {
      description: "List the services of the token's organization.",
      annotations: readOnly,
    },
    () =>
      run("list_services", org, async () => {
        policy.requireScope("services:read")
        policy.assertOrgWide()
        return call({
          path: "/services",
          query: { projectId: policy.orgId },
        })
      })
  )

  server.registerTool(
    "get_service_logs",
    {
      description: "Get recent logs of a service container.",
      inputSchema: {
        serviceId: z.string().min(1),
        tail,
        container: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Container index"),
      },
      annotations: readOnly,
    },
    ({ serviceId, tail, container }) =>
      run("get_service_logs", { type: "service", id: serviceId }, async () => {
        policy.requireScope("services:read")
        await policy.assertOrgResource("service", serviceId)
        return call({
          path: `/services/${enc(serviceId)}/logs`,
          query: { tail, container },
        })
      })
  )

  server.registerTool(
    "list_databases",
    {
      description: "List the databases of the token's organization.",
      annotations: readOnly,
    },
    () =>
      run("list_databases", org, async () => {
        policy.requireScope("databases:read")
        policy.assertOrgWide()
        const out = await call({
          path: "/databases",
          query: { organizationId: policy.orgId },
        })
        if ("error" in out) return out
        return { payload: { databases: out.payload } }
      })
  )

  server.registerTool(
    "get_database_logs",
    {
      description: "Get recent logs of a database container.",
      inputSchema: { databaseId: z.string().min(1), tail },
      annotations: readOnly,
    },
    ({ databaseId, tail }) =>
      run(
        "get_database_logs",
        { type: "database", id: databaseId },
        async () => {
          policy.requireScope("databases:read")
          await policy.assertOrgResource("database", databaseId)
          return call({
            path: `/databases/${enc(databaseId)}/logs`,
            query: { tail },
          })
        }
      )
  )

  // -- Actions ----------------------------------------------------------------

  const destructive = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  }

  const action = async (
    appId: string,
    req: ApiRequest,
    scope = "apps:deploy",
    note = ACCEPTED_NOTE
  ): Promise<ToolOutcome> => {
    policy.requireScope(scope)
    await policy.assertApp(appId)
    if (!(await deps.allowAction(deps.user.pat_id ?? deps.user.id))) {
      throw new PolicyError(
        "RATE_LIMITED",
        "Too many actions for this token; retry in a minute"
      )
    }
    const out = await call({ method: "POST", ...req })
    if ("error" in out) return out
    return { payload: { ...(out.payload as object), note } }
  }

  // A tool the token cannot use is not listed: an agent would only try it
  // and be refused. The scope is still checked again inside each call.
  if (policy.hasScope("apps:write")) {
    server.registerTool(
      "update_app",
      {
        description:
          "Change an app's image, runtime port or HTTP healthcheck. Saved " +
          "only: run deploy_app afterwards to apply it.",
        inputSchema: {
          appId,
          imageRef: z
            .string()
            .min(1)
            .max(512)
            .optional()
            .describe("Image apps only, e.g. nginx:1.27-alpine"),
          runtimePort: z.number().int().min(1).max(65535).optional(),
          healthcheck: z
            .object({
              path: z.string().startsWith("/").max(512).optional(),
              port: z.number().int().min(1).max(65535).nullable().optional(),
              intervalS: z.number().int().min(1).max(300).optional(),
              timeoutS: z.number().int().min(1).max(120).optional(),
              retries: z.number().int().min(1).max(20).optional(),
              startPeriodS: z.number().int().min(0).max(600).optional(),
            })
            .optional()
            .describe(
              "Probed over HTTP from inside the container, which needs a " +
                "shell and curl, wget, node, bun or python3"
            ),
        },
        annotations: destructive,
      },
      ({ appId, imageRef, runtimePort, healthcheck }) =>
        run("update_app", app(appId), async () => {
          const body = {
            ...(imageRef !== undefined ? { imageRef } : {}),
            ...(runtimePort !== undefined ? { runtimePort } : {}),
            ...(healthcheck !== undefined ? { healthcheck } : {}),
          }
          if (Object.keys(body).length === 0) {
            throw new PolicyError(
              "VALIDATION_ERROR",
              "Pass imageRef, runtimePort or healthcheck"
            )
          }
          return action(
            appId,
            { method: "PATCH", path: `/apps/${enc(appId)}`, body },
            "apps:write",
            "Saved, not applied. Run deploy_app to roll it out."
          )
        })
    )
  }

  if (!policy.hasScope("apps:deploy")) return server

  server.registerTool(
    "deploy_app",
    {
      description:
        "Build and deploy the app's current source. Each call starts a new " +
        "build: do not retry on success.",
      inputSchema: { appId },
      annotations: destructive,
    },
    ({ appId }) =>
      run("deploy_app", app(appId), () =>
        action(appId, { path: `/apps/${enc(appId)}/deploy` })
      )
  )

  server.registerTool(
    "restart_app",
    {
      description: "Restart the app's running containers.",
      inputSchema: { appId },
      annotations: destructive,
    },
    ({ appId }) =>
      run("restart_app", app(appId), () =>
        action(appId, { path: `/apps/${enc(appId)}/restart` })
      )
  )

  server.registerTool(
    "stop_app",
    {
      description: "Stop the app. It stays down until deployed or restarted.",
      inputSchema: { appId },
      annotations: destructive,
    },
    ({ appId }) =>
      run("stop_app", app(appId), () =>
        action(appId, { path: `/apps/${enc(appId)}/stop` })
      )
  )

  server.registerTool(
    "rollback_app",
    {
      description:
        "Route traffic back to a previous successful build (the previous " +
        "one when buildId is omitted).",
      inputSchema: { appId, buildId: z.string().min(1).optional() },
      annotations: destructive,
    },
    ({ appId, buildId }) =>
      run("rollback_app", app(appId), () =>
        action(appId, {
          path: `/apps/${enc(appId)}/rollback`,
          body: buildId ? { buildId } : {},
        })
      )
  )

  server.registerTool(
    "scale_app",
    {
      description:
        "Set the app's replica count. Outside Swarm the value applies at " +
        "the next deploy (pendingDeploy: true).",
      inputSchema: { appId, replicas: z.number().int().min(1).max(10) },
      annotations: destructive,
    },
    ({ appId, replicas }) =>
      run("scale_app", app(appId), () =>
        action(appId, {
          path: `/apps/${enc(appId)}/scale`,
          body: { replicas },
        })
      )
  )

  return server
}

function enc(segment: string): string {
  return encodeURIComponent(segment)
}
