// SPDX-License-Identifier: AGPL-3.0-only
// Minimal Caddy admin API types — only what we manipulate

export interface CaddyTlsOptions {
  mode: "http01" | "dns01"
  // DNS-01 specific: provider module name (e.g. "cloudflare", "route53")
  provider?: string
  // Arbitrary provider credentials passed as-is into Caddy TLS policy
  providerConfig?: Record<string, string>
}

export interface CaddyConfig {
  logging?: { logs?: Record<string, Record<string, unknown>> }
  apps?: {
    http?: {
      servers?: Record<string, CaddyServer>
    }
    layer4?: {
      servers?: Record<string, CaddyLayer4Server>
    }
    tls?: {
      automation?: {
        policies?: CaddyTlsPolicy[]
      }
    }
  }
}

export interface CaddyTlsPolicy {
  subjects?: string[]
  issuers?: Array<{
    module?: string
    challenges?: {
      dns?: {
        provider?: Record<string, unknown>
      }
    }
  }>
}

export interface CaddyServer {
  logs?: {
    logger_names?: Record<string, string | string[]>
    skip_unmapped_hosts?: boolean
    should_log_credentials?: boolean
  }
  listen?: string[]
  routes?: CaddyRoute[]
  automatic_https?: {
    disable?: boolean
    skip?: string[]
  }
}

export interface CaddyLayer4Server {
  listen?: string[]
  routes?: CaddyLayer4Route[]
}

export interface CaddyLayer4Route {
  "@id"?: string
  match?: CaddyLayer4Match[]
  handle?: CaddyLayer4Handler[]
}

export interface CaddyLayer4Match {
  tls?: Record<string, unknown>
}

export type CaddyLayer4Handler = CaddyLayer4ProxyHandler

export interface CaddyLayer4ProxyHandler {
  handler: "proxy"
  upstreams: Array<{ dial: string[] }>
}

export interface CaddyRoute {
  "@id"?: string
  match?: CaddyMatch[]
  handle?: CaddyHandler[]
  terminal?: boolean
}

export interface CaddyMatch {
  header?: Record<string, string[] | null>
  host?: string[]
  path?: string[]
  query?: Record<string, string[]>
  remote_ip?: {
    ranges: string[]
  }
  file?: {
    root: string
    try_files: string[]
  }
}

export type CaddyHandler =
  | CaddyReverseProxyHandler
  | CaddyStaticResponseHandler
  | CaddyAuthenticationHandler
  | CaddySubrouteHandler
  | CaddyRateLimitHandler
  | CaddyFileServerHandler
  | CaddyRewriteHandler
  | Record<string, unknown>

export interface CaddyReverseProxyHandler {
  handler: "reverse_proxy"
  upstreams: Array<{ dial: string }>
}

export interface CaddyStaticResponseHandler {
  handler: "static_response"
  status_code?: number
  body?: string
}

export interface CaddyAuthenticationHandler {
  handler: "authentication"
  providers: {
    http_basic: {
      accounts: Array<{ username: string; password: string }>
    }
  }
}

export interface CaddySubrouteHandler {
  handler: "subroute"
  routes: CaddyRoute[]
}

export interface CaddyRateLimitHandler {
  handler: "rate_limit"
  rate_limits: {
    [key: string]: {
      key: string
      window: string
      max_events: number
    }
  }
}

export interface CaddyFileServerHandler {
  handler: "file_server"
  root: string
}

export interface CaddyRewriteHandler {
  handler: "rewrite"
  uri: string
}

/** Middlewares per-app to inject before reverse_proxy */
export interface CaddyMiddlewares {
  basicAuth?: {
    user: string
    /** bcrypt hash of the password */
    pass_hash: string
  }
  ipAllowlist?: string[]
  rateLimit?: {
    rps: number
  }
  extraHandlers?: unknown[]
  cdn?: {
    cdn_mode: "off" | "internal" | "external"
    cdn_cache_ttl_s: number | null
    cdn_cache_paths: string[] | null
    cdn_compression: boolean | null
    cdn_image_optim: boolean | null
    cdn_headers: string | null
    cdn_external_provider: string | null
  }
}
