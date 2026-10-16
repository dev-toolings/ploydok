// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CaddyConfig,
  CaddyHandler,
  CaddyLayer4Route,
  CaddyLayer4Server,
  CaddyMiddlewares,
  CaddyRoute,
  CaddyTlsOptions,
} from "./types.js"
import {
  requestDefaultLogOutput,
  requestLogOutput,
  REQUEST_LOGGER,
  requestServerLogs,
  withRequestId,
} from "./access-logging"
import { applyCdnHandlers } from "./cdn.js"

function defaultCaddyAdminUrl(): string {
  return process.env["CADDY_ADMIN_URL"] ?? "http://127.0.0.1:2020"
}

export class CaddyClient {
  private readonly baseUrl: string
  private bootstrapL4InFlight: Promise<void> | null = null
  private ingressUpdate: Promise<void> = Promise.resolve()

  private serializeIngress(update: () => Promise<void>): Promise<void> {
    const result = this.ingressUpdate.then(update)
    this.ingressUpdate = result.catch(() => {})
    return result
  }

  constructor(baseUrl = defaultCaddyAdminUrl()) {
    // Remove trailing slash for consistent URL building
    this.baseUrl = baseUrl.replace(/\/$/, "")
  }

  /**
   * GET /config/ — returns the full Caddy runtime config.
   */
  async getConfig(): Promise<CaddyConfig> {
    const res = await fetch(`${this.baseUrl}/config/`)
    if (!res.ok) {
      throw new Error(
        `CaddyClient.getConfig failed: ${res.status} ${await res.text()}`
      )
    }
    // Caddy returns null when config is empty
    const body = (await res.json()) as CaddyConfig | null
    return body ?? {}
  }

  /**
   * Upsert a reverse-proxy route.
   * - If a route with @id `ploydok-{appId}` already exists → PATCH to replace it.
   * - Otherwise → POST to append it to srv0 routes.
   */
  /**
   * Build the handler array for a route, injecting middlewares before reverse_proxy.
   * Order: rate_limit → ip_allowlist (subroute) → basicauth → reverse_proxy
   */
  buildHandlers(
    upstream: string,
    middlewares?: CaddyMiddlewares
  ): CaddyHandler[] {
    const handlers: CaddyHandler[] = []

    if (middlewares?.rateLimit && middlewares.rateLimit.rps > 0) {
      handlers.push({
        handler: "rate_limit",
        rate_limits: {
          default: {
            key: "{http.request.remote_ip}",
            window: "1s",
            max_events: middlewares.rateLimit.rps,
          },
        },
      })
    }

    if (middlewares?.ipAllowlist && middlewares.ipAllowlist.length > 0) {
      handlers.push({
        handler: "subroute",
        routes: [
          {
            match: [{ remote_ip: { ranges: middlewares.ipAllowlist } }],
            handle: [],
            terminal: false,
          },
          {
            handle: [{ handler: "static_response", status_code: 403 }],
            terminal: true,
          },
        ],
      })
    }

    if (middlewares?.basicAuth) {
      handlers.push({
        handler: "authentication",
        providers: {
          http_basic: {
            accounts: [
              {
                username: middlewares.basicAuth.user,
                password: middlewares.basicAuth.pass_hash,
              },
            ],
          },
        },
      })
    }

    if (middlewares?.extraHandlers && middlewares.extraHandlers.length > 0) {
      handlers.push(...(middlewares.extraHandlers as CaddyHandler[]))
    }

    handlers.push({
      handler: "reverse_proxy",
      upstreams: [{ dial: upstream }],
    })

    return handlers
  }

  async upsertRoute({
    host,
    upstream,
    appId,
    tls,
    middlewares,
    accessLogs = true,
  }: {
    host: string
    upstream: string
    appId: string
    tls?: CaddyTlsOptions
    middlewares?: CaddyMiddlewares
    accessLogs?: boolean
  }): Promise<void> {
    const routeId = `ploydok-${appId}`

    // Idempotent : garantit que la structure srv0 existe avant PATCH/POST.
    // Sans ça, Caddy renvoie "invalid traversal path" au premier upsert.
    await this.ensureBootstrap()

    // When DNS-01 is requested, register the TLS automation policy in Caddy
    // so the ACME client uses the DNS challenge for this hostname.
    if (tls?.mode === "dns01" && tls.provider) {
      await this.upsertDns01TlsPolicy(
        host,
        tls.provider,
        tls.providerConfig ?? {}
      )
    }

    const route: CaddyRoute = {
      "@id": routeId,
      match: [{ host: [host] }],
      handle: this.buildHandlers(upstream, middlewares),
      terminal: true,
    }
    const routeWithCdn = middlewares?.cdn
      ? applyCdnHandlers(middlewares.cdn, route)
      : route

    await this.putRouteFirst(
      accessLogs ? withRequestId(routeWithCdn) : routeWithCdn,
      "upsertRoute",
      accessLogs
    )
  }

  buildStaticHandlers(root: string, spaFallback: boolean): CaddyHandler[] {
    if (!spaFallback) {
      return [{ handler: "file_server", root }]
    }

    return [
      {
        handler: "subroute",
        routes: [
          {
            match: [
              {
                file: {
                  root,
                  try_files: ["{http.request.uri.path}", "/index.html"],
                },
              },
            ],
            handle: [
              {
                handler: "rewrite",
                uri: "{http.matchers.file.relative}",
              },
            ],
          },
          {
            handle: [{ handler: "file_server", root }],
          },
        ],
      },
    ]
  }

  async upsertStaticRoute({
    host,
    root,
    appId,
    spaFallback = true,
    cdn,
  }: {
    host: string
    root: string
    appId: string
    spaFallback?: boolean
    cdn?: CaddyMiddlewares["cdn"]
  }): Promise<void> {
    const routeId = `ploydok-${appId}`

    await this.ensureBootstrap()

    const route: CaddyRoute = {
      "@id": routeId,
      match: [{ host: [host] }],
      handle: this.buildStaticHandlers(root, spaFallback),
      terminal: true,
    }
    const routeWithCdn = cdn
      ? applyCdnHandlers(cdn, route, { staticRoot: root })
      : route

    await this.putRouteFirst(
      withRequestId(routeWithCdn),
      "upsertStaticRoute",
      true
    )
  }

  private async putRouteFirst(
    route: CaddyRoute,
    label: string,
    accessLogs = false
  ): Promise<void> {
    return this.serializeIngress(() =>
      this.writeRouteFirst(route, label, accessLogs)
    )
  }

  private async writeRouteFirst(
    route: CaddyRoute,
    label: string,
    accessLogs: boolean
  ): Promise<void> {
    const routeId = route["@id"]
    const res = await fetch(
      `${this.baseUrl}/config/apps/http/servers/srv0/routes`
    )
    if (!res.ok) {
      throw new Error(
        `CaddyClient.${label} GET routes failed: ${res.status} ${await res.text()}`
      )
    }
    const routes = ((await res.json()) ?? []) as CaddyRoute[]
    const nextRoutes = [
      route,
      ...routes.filter((candidate) => candidate["@id"] !== routeId),
    ]
    const patchRes = await fetch(
      `${this.baseUrl}/config/apps/http/servers/srv0/routes`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextRoutes),
      }
    )
    if (patchRes.ok) {
      if (accessLogs)
        await this.writeRequestLogging(
          route.match?.flatMap((m) => m.host ?? []) ?? [],
          false
        )
      return
    }
    throw new Error(
      `CaddyClient.${label} PATCH routes failed: ${patchRes.status} ${await patchRes.text()}`
    )
  }

  /** Rebuilt by ingress reconciliation after Caddy reloads its base Caddyfile. */
  async ensureRequestLogging(
    hosts: string[],
    authoritative = true
  ): Promise<void> {
    return this.serializeIngress(() =>
      this.writeRequestLogging(hosts, authoritative)
    )
  }

  private async writeRequestLogging(
    hosts: string[],
    authoritative: boolean
  ): Promise<void> {
    const config = await this.getConfig()
    const logs = config.logging?.logs ?? {}
    const defaultLog = requestDefaultLogOutput(logs.default)
    if (
      JSON.stringify(logs[REQUEST_LOGGER]) !== JSON.stringify(requestLogOutput) ||
      JSON.stringify(logs.default) !== JSON.stringify(defaultLog)
    ) {
      const next = {
        ...config.logging,
        logs: { ...logs, default: defaultLog, [REQUEST_LOGGER]: requestLogOutput },
      }
      await this.setRequestLogConfig("/config/logging", next)
    }
    for (const [name, server] of Object.entries(
      config.apps?.http?.servers ?? {}
    )) {
      const currentHosts = Object.entries(server.logs?.logger_names ?? {})
        .filter(([, names]) =>
          (Array.isArray(names) ? names : [names]).includes(REQUEST_LOGGER)
        )
        .map(([host]) => host)
      const selected = authoritative
        ? hosts
        : [...new Set([...currentHosts, ...hosts])]
      const nextLogs = requestServerLogs(server, selected)
      if (JSON.stringify(server.logs) !== JSON.stringify(nextLogs)) {
        await this.setRequestLogConfig(
          `/config/apps/http/servers/${name}/logs`,
          nextLogs
        )
      }
      const nextRoutes = (server.routes ?? []).map((route) =>
        route["@id"]?.startsWith("ploydok-") &&
        route.match?.some((m) =>
          m.host?.some((host) => selected.includes(host))
        )
          ? withRequestId(route)
          : route
      )
      if (JSON.stringify(nextRoutes) !== JSON.stringify(server.routes ?? [])) {
        const res = await fetch(
          `${this.baseUrl}/config/apps/http/servers/${name}/routes`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextRoutes),
          }
        )
        if (!res.ok)
          throw new Error(
            `Caddy request correlation update failed: ${res.status}`
          )
      }
    }
  }

  private async setRequestLogConfig(
    path: string,
    body: unknown
  ): Promise<void> {
    // Caddy PUT strictly creates object keys. POST also replaces existing keys.
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok)
      throw new Error(`Caddy request logging update failed: ${res.status}`)
  }

  /**
   * Remove a route by appId. Idempotent: 404 is treated as success.
   */
  async removeRoute(appId: string): Promise<void> {
    return this.serializeIngress(async () => {
      const routeId = `ploydok-${appId}`
      const res = await fetch(`${this.baseUrl}/id/${routeId}`, {
        method: "DELETE",
      })

      if (res.ok || res.status === 404) {
        return
      }

      throw new Error(
        `CaddyClient.removeRoute failed: ${res.status} ${await res.text()}`
      )
    })
  }

  // ---------------------------------------------------------------------------
  // M3.3 — upstream management for blue-green deploy
  // ---------------------------------------------------------------------------

  /**
   * Set (upsert) the upstream dial target for an app route.
   * Idempotent: if the route exists, its upstreams array is replaced.
   * If the route does not exist, creates a new one with the given upstream.
   *
   * @param appId   The app id (used as route @id `ploydok-{appId}` and host matcher).
   * @param host    The virtual host the route matches (e.g. "myapp.ploydok.local").
   * @param upstream `{ host, port }` of the target container on the ploydok-public network.
   */
  async setUpstream(
    appId: string,
    host: string,
    upstream: { host: string; port: number },
    opts?: { cdn?: CaddyMiddlewares["cdn"] }
  ): Promise<void> {
    const dial = `${upstream.host}:${upstream.port}`
    await this.upsertRoute({
      host,
      upstream: dial,
      appId,
      ...(opts?.cdn ? { middlewares: { cdn: opts.cdn } } : {}),
    })
  }

  /**
   * Get the current upstream dial string for an app route, or null if the route
   * does not exist / has no reverse_proxy handler.
   */
  async getUpstream(
    appId: string
  ): Promise<{ host: string; port: number } | null> {
    const routeId = `ploydok-${appId}`

    const res = await fetch(`${this.baseUrl}/id/${routeId}`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(
        `CaddyClient.getUpstream failed: ${res.status} ${await res.text()}`
      )
    }

    let route: CaddyRoute
    try {
      route = (await res.json()) as CaddyRoute
    } catch {
      return null
    }

    // Find the first reverse_proxy handle and extract its first upstream dial.
    for (const handle of route.handle ?? []) {
      if (handle.handler === "reverse_proxy") {
        const rp = handle as { upstreams?: Array<{ dial?: string }> }
        const dial = rp.upstreams?.[0]?.dial ?? ""
        if (!dial) return null
        // dial format: "host:port"
        const colonIdx = dial.lastIndexOf(":")
        if (colonIdx === -1) return null
        const h = dial.slice(0, colonIdx)
        const p = parseInt(dial.slice(colonIdx + 1), 10)
        if (!h || isNaN(p)) return null
        return { host: h, port: p }
      }
    }
    return null
  }

  /**
   * Get the exact host matcher currently attached to an app's primary route.
   * The route id scopes this read to the app, so an unrelated route cannot
   * prove ownership of the hostname.
   */
  async getRouteHost(appId: string): Promise<string | null> {
    const routeId = `ploydok-${appId}`

    const res = await fetch(`${this.baseUrl}/id/${routeId}`, {
      signal: AbortSignal.timeout(1_500),
    })
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(
        `CaddyClient.getRouteHost failed: ${res.status} ${await res.text()}`
      )
    }

    let route: CaddyRoute
    try {
      route = (await res.json()) as CaddyRoute
    } catch {
      return null
    }

    const hosts = route.match?.flatMap((matcher) => matcher.host ?? []) ?? []
    return hosts[0] ?? null
  }

  /**
   * Remove the upstream route for an app. Idempotent: 404 is treated as success.
   * Delegates to the existing `removeRoute` method.
   */
  async removeUpstream(appId: string): Promise<void> {
    return this.removeRoute(appId)
  }

  /**
   * Ensure Caddy has a minimal working config with srv0 (`:443`) and srv1 (`:80`).
   * Idempotent: no-op if srv0 already exists.
   */
  async ensureBootstrap(): Promise<void> {
    const config = await this.getConfig()

    // Already bootstrapped
    if (config.apps?.http?.servers?.["srv0"]) {
      return
    }

    // srv0 sur :80, auto_https off → dev HTTP pur. En prod une config
    // séparée upgrade vers :443 + ACME.
    const srv0 = {
      listen: [":80"],
      routes: [],
      automatic_https: { disable: true },
    }

    // Chirurgical : on remonte progressivement jusqu'au niveau d'ancêtre
    // existant, et on crée srv0 avec le minimum de payload. Aucune requête
    // ne peut écraser un état existant (tous les parents non-existants sont
    // créés via PUT, jamais POST/PATCH sur /config/apps).
    if (config.apps?.http?.servers) {
      // servers existe → on ajoute juste srv0
      await this.putOrFail(
        `/config/apps/http/servers/srv0`,
        srv0,
        "servers.srv0"
      )
      return
    }
    if (config.apps?.http) {
      // http existe → on crée servers avec srv0
      await this.putOrFail(
        `/config/apps/http/servers`,
        { srv0 },
        "http.servers"
      )
      return
    }
    if (config.apps) {
      // apps existe → on crée http avec servers+srv0
      await this.putOrFail(
        `/config/apps/http`,
        { servers: { srv0 } },
        "apps.http"
      )
      return
    }
    // Config totalement vide → POST /config/apps est sûr (rien à écraser).
    await this.putOrFail(
      `/config/apps`,
      { http: { servers: { srv0 } } },
      "apps"
    )
  }

  async ensureLayer4Bootstrap(): Promise<void> {
    // Dedup concurrent callers: two database spawns racing through
    // upsertTcpProxy would each read the config and both issue a PUT
    // on /config/apps/layer4, silently clobbering peer server entries.
    if (this.bootstrapL4InFlight) return this.bootstrapL4InFlight
    this.bootstrapL4InFlight = this.doEnsureLayer4Bootstrap().finally(() => {
      this.bootstrapL4InFlight = null
    })
    return this.bootstrapL4InFlight
  }

  private async doEnsureLayer4Bootstrap(): Promise<void> {
    const config = await this.getConfig()

    if (config.apps?.layer4?.servers) {
      return
    }

    if (config.apps?.layer4) {
      await this.putOrFail(`/config/apps/layer4/servers`, {}, "layer4.servers")
      return
    }

    if (config.apps) {
      await this.putOrFail(
        `/config/apps/layer4`,
        { servers: {} },
        "apps.layer4"
      )
      return
    }

    await this.putOrFail(`/config/apps`, { layer4: { servers: {} } }, "apps")
  }

  async upsertTcpProxy({
    serverId,
    listenPort,
    upstream,
  }: {
    serverId: string
    listenPort: number
    upstream: string
  }): Promise<void> {
    await this.ensureLayer4Bootstrap()

    const route: CaddyLayer4Route = {
      "@id": serverId,
      handle: [
        {
          handler: "proxy",
          upstreams: [{ dial: [upstream] }],
        },
      ],
    }

    const server: CaddyLayer4Server = {
      listen: [`:${listenPort}`],
      routes: [route],
    }

    await this.putOrFail(
      `/config/apps/layer4/servers/${serverId}`,
      server,
      `layer4.servers.${serverId}`
    )
  }

  async removeTcpProxy(serverId: string): Promise<void> {
    await this.ensureLayer4Bootstrap()
    const res = await fetch(
      `${this.baseUrl}/config/apps/layer4/servers/${serverId}`,
      {
        method: "DELETE",
      }
    )

    if (res.ok || res.status === 404) return

    throw new Error(
      `CaddyClient.removeTcpProxy failed: ${res.status} ${await res.text()}`
    )
  }

  /**
   * Upsert a Caddy TLS automation policy for a hostname to use DNS-01 challenge.
   * Idempotent: replaces an existing policy for the same subject if present.
   */
  async upsertDns01TlsPolicy(
    hostname: string,
    provider: string,
    providerConfig: Record<string, string>
  ): Promise<void> {
    const config = await this.getConfig()
    const existingPolicies = config.apps?.tls?.automation?.policies ?? []

    // Remove any existing policy for this exact hostname to avoid duplicates
    const filtered = existingPolicies.filter(
      (p) => !(p.subjects?.length === 1 && p.subjects[0] === hostname)
    )

    const newPolicy = {
      subjects: [hostname],
      issuers: [
        {
          module: "acme",
          challenges: {
            dns: {
              provider: {
                name: provider,
                ...providerConfig,
              },
            },
          },
        },
      ],
    }

    const updatedPolicies = [...filtered, newPolicy]

    // Ensure apps.tls path exists then PUT policies
    await this.putOrFail(
      "/config/apps/tls/automation/policies",
      updatedPolicies,
      "tls.automation.policies"
    )
  }

  /**
   * Build a snapshot of the DNS-01 Caddy TLS policy for a hostname (for testing).
   */
  buildDns01TlsPolicy(
    hostname: string,
    provider: string,
    providerConfig: Record<string, string>
  ): object {
    return {
      subjects: [hostname],
      issuers: [
        {
          module: "acme",
          challenges: {
            dns: {
              provider: {
                name: provider,
                ...providerConfig,
              },
            },
          },
        },
      ],
    }
  }

  private async putOrFail(
    path: string,
    body: unknown,
    label: string
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (res.ok) return
    throw new Error(
      `CaddyClient.ensureBootstrap failed creating ${label}: ${res.status} ${await res.text()}`
    )
  }
}
