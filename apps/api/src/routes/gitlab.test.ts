// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { Hono } from "hono"
import type { Context, Next } from "hono"
import { env } from "../env"

let mockGitLabConfig: Record<string, unknown> | null = null
let fakeInstanceAdmin = true
let mockInstallations: Array<{ id: string }> = []
let lastListReposOptions: Record<string, unknown> | null = null
const deliveryInserts: Array<{
  row: Record<string, unknown>
  rawBodyBuffer?: Buffer
}> = []
const enqueueGitLabSync = mock(async () => undefined)
const oauthNonceValues = new Map<string, string>()
const fakeRedis = {
  set: mock(
    async (
      key: string,
      value: string,
      _ex: string,
      _ttl: number,
      _nx: string
    ) => {
      if (oauthNonceValues.has(key)) return null
      oauthNonceValues.set(key, value)
      return "OK"
    }
  ),
  eval: mock(
    async (
      _script: string,
      keyCount: number,
      key: string,
      expected: string
    ) => {
      if (keyCount !== 1) throw new Error("unexpected Redis key count")
      if (oauthNonceValues.get(key) !== expected) return 0
      oauthNonceValues.delete(key)
      return 1
    }
  ),
}

const fakeTable = new Proxy(
  {},
  {
    get: (_target, prop) => Symbol(String(prop)),
  }
)

const fakeDb = {
  select: mock(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ is_instance_admin: fakeInstanceAdmin }],
      }),
    }),
  })),
  insert: mock(() => ({
    values: mock(() => ({
      onConflictDoUpdate: mock(async () => undefined),
    })),
  })),
}

mock.module("@ploydok/db", () => ({
  createDb: () => fakeDb,
  createRedis: () => fakeRedis,
  provider_credentials: fakeTable,
  users: {
    id: "id",
    is_instance_admin: "is_instance_admin",
  },
}))

mock.module("@ploydok/db/queries", () => ({
  deleteGitLabConfig: async () => undefined,
  deleteGitLabTokens: async () => undefined,
  getCacheStatus: async () => null,
  getGitLabConfig: async () => mockGitLabConfig,
  getGitLabTokens: async () => null,
  getInstallationStaleness: async () => ({ mostStaleAt: null }),
  listInstallations: async () => mockInstallations,
  listRepos: async (_db: unknown, options: Record<string, unknown>) => {
    lastListReposOptions = options
    return { rows: [], total: 0 }
  },
  saveGitLabConfig: async () => undefined,
  upsertGitLabTokens: async () => undefined,
}))

mock.module("../github/app-credentials", () => ({
  encryptField: async (value: string) => ({
    enc: Buffer.from(`enc:${value}`),
    nonce: Buffer.from("nonce"),
  }),
  decryptField: async (enc: Buffer) => enc.toString().replace(/^enc:/, ""),
}))

mock.module("../gitlab/connection", () => ({
  resolveGitLabConnection: async () => ({
    accessToken: "access-token",
    installationId: "gitlab:user:user-test-1",
    provider: {
      listBranches: async () => [],
      listFiles: async () => ["custom/service/go.mod"],
      fileExists: async () => false,
      readFile: async () => "",
    },
  }),
}))

mock.module("../gitlab/webhook", () => ({
  handleGitLabWebhook: mock(async () => undefined),
  verifyGitLabToken: (receivedHeader: string | null, expectedSecret: string) =>
    receivedHeader === expectedSecret,
}))

mock.module("../webhooks/deliveries", () => ({
  findRecentByPayloadHash: async () => null,
  insertDelivery: async (
    _db: unknown,
    row: Record<string, unknown>,
    rawBodyBuffer?: Buffer
  ) => {
    const insert: {
      row: Record<string, unknown>
      rawBodyBuffer?: Buffer
    } = { row }
    if (rawBodyBuffer !== undefined) {
      insert.rawBodyBuffer = rawBodyBuffer
    }
    deliveryInserts.push(insert)
    return "delivery-id"
  },
}))

mock.module("../webhooks/rate-limiters", () => ({
  gitlabWebhookRateLimit: async (_c: Context, next: Next) => next(),
}))

mock.module("../worker/handlers/sync-provider-repos", () => ({
  enqueueProviderReposSync: enqueueGitLabSync,
}))

mock.module("../logger", () => ({
  childLogger: () => ({
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  }),
}))

const { gitlabRouter, gitLabDbRowToWire } = await import("./gitlab")

const FAKE_USER = {
  id: "user-test-1",
  email: "test@example.com",
  display_name: "Test User",
  session_id: "session-test-1",
}

function buildApp(user?: typeof FAKE_USER): Hono {
  const app = new Hono()
  app.use("*", async (c, next) => {
    if (user) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(c as any).set("user", user)
    }
    return next()
  })
  app.route("/gitlab", gitlabRouter)
  return app
}

beforeEach(() => {
  mockGitLabConfig = null
  fakeInstanceAdmin = true
  mockInstallations = []
  lastListReposOptions = null
  deliveryInserts.length = 0
  enqueueGitLabSync.mockClear()
  oauthNonceValues.clear()
  fakeRedis.set.mockClear()
  fakeRedis.eval.mockClear()
})

describe("GitLab configuration mutations", () => {
  it("allows an instance admin to save the global configuration", async () => {
    const app = buildApp(FAKE_USER)
    const res = await app.request("/gitlab/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "client",
        client_secret: "secret",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("rejects a non-admin POST /gitlab/config", async () => {
    fakeInstanceAdmin = false
    const app = buildApp(FAKE_USER)
    const res = await app.request("/gitlab/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "client",
        client_secret: "secret",
      }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "admin_required" })
  })

  it("rejects a non-admin DELETE /gitlab/config", async () => {
    fakeInstanceAdmin = false
    const app = buildApp(FAKE_USER)
    const res = await app.request("/gitlab/config", { method: "DELETE" })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "admin_required" })
  })
})

describe("POST /gitlab/webhook", () => {
  it("does not insert a delivery for an invalid token", async () => {
    mockGitLabConfig = {
      webhook_secret_enc: Buffer.from("enc:webhook-secret"),
      webhook_secret_nonce: Buffer.from("nonce"),
    }
    const app = buildApp()
    const res = await app.request("/gitlab/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Token": "wrong-secret",
        "X-Gitlab-Event": "Push Hook",
        "X-Gitlab-Event-UUID": "delivery-poison",
      },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "invalid_token" })
    expect(deliveryInserts).toHaveLength(0)
  })
})

describe("GET /gitlab/config", () => {
  it("exposes the callback URL even when nothing is configured", async () => {
    mockGitLabConfig = null
    const app = buildApp(FAKE_USER)
    const res = await app.request("/gitlab/config")

    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      configured: boolean
      callback_url: string
    }
    expect(data.configured).toBe(false)
    expect(data.callback_url).toBe(env.GITLAB_OAUTH_CALLBACK_URL)
  })

  it("exposes the callback URL once configured", async () => {
    mockGitLabConfig = {
      instance_url: "https://gitlab.com",
      client_id: "abc",
    }
    const app = buildApp(FAKE_USER)
    const res = await app.request("/gitlab/config")

    const data = (await res.json()) as {
      configured: boolean
      callback_url: string
    }
    expect(data.configured).toBe(true)
    expect(data.callback_url).toBe(env.GITLAB_OAUTH_CALLBACK_URL)
  })
})

describe("GitLab repository wire format", () => {
  it("converts cached DB rows into the project shape used by the browser", () => {
    const wire = gitLabDbRowToWire({
      id: "gitlab:431",
      installation_id: "gitlab:user:user-test-1",
      provider: "gitlab",
      full_name: "platform/services/api",
      name: "api",
      description: "Nested project",
      default_branch: "develop",
      private: true,
      html_url: "https://gitlab.example.test/platform/services/api",
      pushed_at: null,
      updated_at: null,
      last_synced_at: new Date(),
    })

    expect(wire).toEqual({
      id: 431,
      fullName: "platform/services/api",
      description: "Nested project",
      private: true,
      defaultBranch: "develop",
      cloneUrl: "https://gitlab.example.test/platform/services/api.git",
    })
  })

  it("scopes cached repository search to the current user's installation", async () => {
    mockInstallations = [{ id: "gitlab:user:user-test-1" }]
    const res = await buildApp(FAKE_USER).request(
      "/gitlab/repos?search=platform"
    )

    expect(res.status).toBe(200)
    expect(lastListReposOptions).toMatchObject({
      provider: "gitlab",
      installationIds: ["gitlab:user:user-test-1"],
      search: "platform",
    })
  })
})

describe("GitLab OAuth round-trip", () => {
  const realFetch = globalThis.fetch
  const realDateNow = Date.now

  function configured() {
    mockGitLabConfig = {
      instance_url: "https://gitlab.com",
      client_id: "abc",
      client_secret_enc: Buffer.from("enc:secret"),
      client_secret_nonce: Buffer.from("nonce"),
    }
  }

  function readStateCookie(res: Response): string {
    const setCookie = res.headers.get("set-cookie") ?? ""
    const match = /gl_oauth_state=([^;]+)/.exec(setCookie)
    return decodeURIComponent(match![1]!)
  }

  afterEach(() => {
    globalThis.fetch = realFetch
    Date.now = realDateNow
  })

  it("uses one clock snapshot for the signed state and Redis nonce", async () => {
    configured()
    stubTokenExchange()
    let clockReads = 0
    Date.now = () => (clockReads++ === 0 ? 1_000 : 2_000)
    const app = buildApp(FAKE_USER)

    const start = await app.request("/gitlab/connect")
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)
    const redisValue = JSON.parse(oauthNonceValues.values().next().value!) as [
      number,
      string,
      string,
    ]
    const signedPayload = JSON.parse(
      Buffer.from(cookie.split(".")[0]!, "base64url").toString("utf8")
    ) as { exp: number }
    expect(redisValue[0]).toBe(601)
    expect(signedPayload.exp).toBe(redisValue[0])
    const back = await app.request(`/gitlab/callback?code=xyz&state=${state}`, {
      headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` },
    })

    expect(back.status).toBe(302)
  })

  function stubTokenExchange() {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch
  }

  it("carries an allow-listed return target from connect to callback", async () => {
    configured()
    stubTokenExchange()
    const app = buildApp(FAKE_USER)

    const start = await app.request("/gitlab/connect?return_to=%2Fonboarding")
    expect(start.status).toBe(302)
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)

    const back = await app.request(`/gitlab/callback?code=xyz&state=${state}`, {
      headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` },
    })

    expect(back.status).toBe(302)
    expect(back.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/onboarding?connected=1&sync=queued&source=gitlab`
    )
    expect(enqueueGitLabSync).toHaveBeenCalled()
    expect(fakeRedis.set).toHaveBeenCalledWith(
      expect.stringContaining("oauth:gitlab:nonce:"),
      expect.any(String),
      "EX",
      600,
      "NX"
    )
  })

  it("falls back to settings when no return target was requested", async () => {
    configured()
    stubTokenExchange()
    const app = buildApp(FAKE_USER)

    const start = await app.request("/gitlab/connect")
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)

    const back = await app.request(`/gitlab/callback?code=xyz&state=${state}`, {
      headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` },
    })

    expect(back.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/gitlab?connected=1&sync=queued&source=gitlab`
    )
  })

  it("ignores a return target outside the allow-list", async () => {
    configured()
    stubTokenExchange()
    const app = buildApp(FAKE_USER)

    const start = await app.request(
      "/gitlab/connect?return_to=https%3A%2F%2Fevil.com"
    )
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)

    const back = await app.request(`/gitlab/callback?code=xyz&state=${state}`, {
      headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` },
    })

    expect(back.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/gitlab?connected=1&sync=queued&source=gitlab`
    )
  })

  it("consumes an OAuth nonce exactly once", async () => {
    configured()
    stubTokenExchange()
    const app = buildApp(FAKE_USER)
    const start = await app.request("/gitlab/connect")
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)
    const headers = {
      cookie: `gl_oauth_state=${encodeURIComponent(cookie)}`,
    }

    const first = await app.request(
      `/gitlab/callback?code=xyz&state=${state}`,
      { headers }
    )
    const replay = await app.request(
      `/gitlab/callback?code=xyz&state=${state}`,
      { headers }
    )

    expect(first.status).toBe(302)
    expect(replay.status).toBe(400)
    expect(await replay.json()).toEqual({ error: "invalid_state" })
    expect(fakeRedis.eval).toHaveBeenCalledTimes(2)
  })

  it("rejects a callback after the authenticated session changes", async () => {
    configured()
    stubTokenExchange()
    const initiatingApp = buildApp(FAKE_USER)
    const start = await initiatingApp.request("/gitlab/connect")
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)
    const changedSessionApp = buildApp({
      ...FAKE_USER,
      session_id: "session-test-2",
    })

    const back = await changedSessionApp.request(
      `/gitlab/callback?code=xyz&state=${state}`,
      {
        headers: {
          cookie: `gl_oauth_state=${encodeURIComponent(cookie)}`,
        },
      }
    )

    expect(back.status).toBe(403)
    expect(await back.json()).toEqual({ error: "oauth_user_mismatch" })

    const legitimate = await initiatingApp.request(
      `/gitlab/callback?code=xyz&state=${state}`,
      {
        headers: {
          cookie: `gl_oauth_state=${encodeURIComponent(cookie)}`,
        },
      }
    )
    expect(legitimate.status).toBe(302)
  })

  it("rejects a state that does not match the cookie", async () => {
    configured()
    const app = buildApp(FAKE_USER)

    const start = await app.request("/gitlab/connect?return_to=%2Fonboarding")
    const cookie = readStateCookie(start)

    const back = await app.request("/gitlab/callback?code=xyz&state=bad", {
      headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` },
    })

    expect(back.status).toBe(400)
    const data = (await back.json()) as { error: string }
    expect(data.error).toBe("invalid_state")

    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    stubTokenExchange()
    const legitimate = await app.request(
      `/gitlab/callback?code=xyz&state=${state}`,
      { headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` } }
    )
    expect(legitimate.status).toBe(302)
  })

  it("redirects a provider denial only after validating OAuth state", async () => {
    configured()
    const app = buildApp(FAKE_USER)
    const start = await app.request("/gitlab/connect?return_to=%2Fonboarding")
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)

    const denied = await app.request(
      `/gitlab/callback?error=access_denied&state=${state}`,
      { headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` } }
    )

    expect(denied.status).toBe(302)
    expect(denied.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/onboarding?gitlab_error=access_denied`
    )
    expect(denied.headers.get("set-cookie")).toContain("Max-Age=0")
  })

  it("returns exchange failures to the trusted UI target", async () => {
    configured()
    globalThis.fetch = (async () =>
      new Response("invalid grant", { status: 400 })) as unknown as typeof fetch
    const app = buildApp(FAKE_USER)
    const start = await app.request("/gitlab/connect")
    const state = new URL(start.headers.get("location")!).searchParams.get(
      "state"
    )!
    const cookie = readStateCookie(start)

    const back = await app.request(`/gitlab/callback?code=bad&state=${state}`, {
      headers: { cookie: `gl_oauth_state=${encodeURIComponent(cookie)}` },
    })

    expect(back.status).toBe(302)
    expect(back.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/gitlab?gitlab_error=exchange_failed`
    )
  })
})

describe("GitLab application directory discovery", () => {
  it("requires authentication and discovers the selected repository", async () => {
    expect(
      (
        await buildApp().request(
          "/gitlab/repos/acme%2Frepo/deployment-targets?ref=main"
        )
      ).status
    ).toBe(401)
    const res = await buildApp(FAKE_USER).request(
      "/gitlab/repos/acme%2Frepo/deployment-targets?ref=main"
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { targets: { rootDir: string }[] }
    expect(body.targets.map((target) => target.rootDir)).toEqual([
      "custom/service",
    ])
  })
})
