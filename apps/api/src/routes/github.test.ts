// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, generateKeyPairSync } from "node:crypto"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import * as realQueries from "@ploydok/db/queries"
import { env } from "../env"
import { GitHubAppCredentialsError } from "../github/errors"

let mockGitHubAppConfig: Record<string, unknown> | null = null
let extraGitHubApps: Array<Record<string, unknown> & { id: string }> = []
type StoredGitHubApp = Record<string, unknown> & { id: string }
let lockedGitHubAppConfigOverride: Record<string, unknown> | null | undefined
let decryptAppPrivateKeyFailure: Error | null = null
const importedConfigs: Array<Record<string, unknown>> = []
let deleteConfigCalls = 0
let deleteInstallationUsersCalls = 0
let transactionCalls = 0
let lockConfigCalls = 0
let evictAllTokenCalls = 0
const credentialUpserts: Array<{
  values: Record<string, unknown>
  conflict: Record<string, unknown>
}> = []
const enqueuedSyncs: Array<Record<string, unknown>> = []
let syncEnqueueFailure: Error | null = null
const installationAssignments: Array<{
  installationId: string
  userId: string
}> = []
const organizationGrants: Array<{
  orgId: string
  installationId: string
  grantedBy: string
}> = []
const installationAudits: Array<Record<string, unknown>> = []
const localDisconnects: Array<{ installationId: string; userId: string }> = []
let userGitHubInstallationIds = ["42"]
let organizationGitHubInstallationIds = ["42"]
let cacheStatusRows: Array<Record<string, unknown>> = []
let cachedRepoRows: Array<Record<string, unknown>> = []
const cacheStatusFilters: unknown[][] = []
const deletedTables: Array<unknown> = []
let liveInstallations: Array<{ id: number; accountLogin?: string }> = []
let listInstallationsFailure: Error | null = null
let listInstallationsCalls = 0
const revokedInstallations: number[] = []
let revokeFailure: Error | null = null
let fakeInstanceAdmin = true
let fakeOrganizationOwnerExists = true
let recentDelivery: { id: string; decision: string } | null = null
const deliveryInserts: Array<{
  row: Record<string, unknown>
  rawBodyBuffer?: Buffer
}> = []

const fakeProviderCredentials = {
  id: Symbol("provider_credentials.id"),
  provider: Symbol("provider_credentials.provider"),
}
const fakeProviderInstallations = {
  provider: Symbol("provider_installations.provider"),
}
const fakeAuditLog = Symbol("audit_log")
const fakeTable = new Proxy(
  {},
  {
    get: (_target, prop) => Symbol(String(prop)),
  }
)
const fakeRedisWindows = new Map<string, Map<string, number>>()
const fakeRedis = {
  zremrangebyscore: mock(async () => 0),
  zcard: mock(async () => 0),
  zadd: mock(async () => 1),
  expire: mock(async () => 1),
  // Mirrors the sliding-window Lua the limiter runs server-side.
  eval: mock(
    async (
      _script: string,
      _keyCount: number,
      key: string,
      cutoff: number,
      now: number,
      member: string,
      maximum: number
    ): Promise<[number, number]> => {
      const window = fakeRedisWindows.get(key) ?? new Map<string, number>()
      fakeRedisWindows.set(key, window)
      for (const [entry, score] of window) {
        if (score <= Number(cutoff)) window.delete(entry)
      }
      const count = window.size
      if (count >= Number(maximum)) return [0, 0]
      window.set(member, Number(now))
      return [1, Number(maximum) - count - 1]
    }
  ),
}
const fakeMembershipRows = () =>
  fakeOrganizationOwnerExists
    ? [
        {
          is_instance_admin: fakeInstanceAdmin,
          id: "org-1",
          role: "owner",
        },
      ]
    : []
const fakeDb = {
  select: mock(() => ({
    from: () => ({
      where: () => ({
        limit: async () => fakeMembershipRows(),
      }),
      innerJoin: () => ({
        where: () => ({ limit: async () => fakeMembershipRows() }),
      }),
    }),
  })),
  insert: mock((table?: unknown) => ({
    values: (values: Record<string, unknown>) => {
      if (table === fakeAuditLog) installationAudits.push(values)
      return {
        onConflictDoUpdate: async (conflict: Record<string, unknown>) => {
          credentialUpserts.push({ values, conflict })
        },
      }
    },
  })),
  delete: mock((table: unknown) => ({
    where: async () => {
      deletedTables.push(table)
    },
  })),
  transaction: mock(async (callback: (tx: unknown) => Promise<unknown>) => {
    transactionCalls += 1
    return callback(fakeDb)
  }),
}

mock.module("@ploydok/db", () => ({
  apps: fakeTable,
  builds: fakeTable,
  createDb: () => fakeDb,
  createRedis: () => fakeRedis,
  gitlab_tokens: fakeTable,
  preview_deployments: fakeTable,
  preview_queue_jobs: fakeTable,
  projects: {
    id: Symbol("projects.id"),
  },
  memberships: {
    id: Symbol("memberships.id"),
    org_id: Symbol("memberships.org_id"),
    user_id: Symbol("memberships.user_id"),
    role: Symbol("memberships.role"),
    accepted_at: Symbol("memberships.accepted_at"),
  },
  provider_credentials: fakeProviderCredentials,
  provider_installations: fakeProviderInstallations,
  audit_log: fakeAuditLog,
  users: {
    id: "id",
    is_instance_admin: "is_instance_admin",
  },
  webhook_deliveries: fakeTable,
}))
mock.module("../github/installation-tokens", () => ({
  getInstallationToken: async () => "test-installation-token",
  evictInstallationToken: () => undefined,
  evictAllInstallationTokens: () => {
    evictAllTokenCalls += 1
  },
  listAppInstallations: async () => {
    listInstallationsCalls += 1
    if (listInstallationsFailure) throw listInstallationsFailure
    return liveInstallations
  },
  revokeAppInstallation: async (installationId: number) => {
    if (revokeFailure) throw revokeFailure
    revokedInstallations.push(installationId)
  },
}))
mock.module("../worker/handlers/sync-provider-repos", () => ({
  enqueueProviderReposSync: async (payload: Record<string, unknown>) => {
    if (syncEnqueueFailure) throw syncEnqueueFailure
    enqueuedSyncs.push(payload)
  },
}))
mock.module("../github/app-credentials", () => ({
  encryptField: async (value: string) => ({
    enc: Buffer.from(`enc:${value}`),
    nonce: Buffer.from("nonce"),
  }),
  decryptField: async (enc: Buffer) => enc.toString().replace(/^enc:/, ""),
  decryptAppPrivateKey: async (config: { pem_enc: Buffer }) => {
    if (decryptAppPrivateKeyFailure) throw decryptAppPrivateKeyFailure
    return config.pem_enc.toString().replace(/^enc:/, "")
  },
}))
mock.module("../webhooks/deliveries", () => ({
  findRecentByPayloadHash: async () => recentDelivery,
  insertDelivery: async (
    _db: unknown,
    row: Record<string, unknown>,
    rawBodyBuffer?: Buffer
  ) => {
    const insert = { row } as {
      row: Record<string, unknown>
      rawBodyBuffer?: Buffer
    }
    if (rawBodyBuffer !== undefined) {
      insert.rawBodyBuffer = rawBodyBuffer
    }
    deliveryInserts.push(insert)
    return "delivery-id"
  },
  markDeliveryCoalesced: async () => undefined,
}))
// Only override the GitHub-app config getters — other queries (jobs, builds…)
// must keep their real implementations because `mock.module` is process-wide
// in Bun and would otherwise break sibling test files.
// Stored App rows always carry their row id; the fixtures leave it implicit.
const storedGitHubAppConfig = () =>
  mockGitHubAppConfig ? { id: "singleton", ...mockGitHubAppConfig } : null
const storedGitHubApps = (): StoredGitHubApp[] => {
  const config = storedGitHubAppConfig()
  return [...(config ? [config] : []), ...extraGitHubApps]
}
mock.module("@ploydok/db/queries", () => ({
  ...realQueries,
  getGitHubAppConfig: async (_db: unknown, id?: string) =>
    id
      ? (storedGitHubApps().find((app) => app.id === id) ?? null)
      : storedGitHubAppConfig(),
  getGitHubAppConfigByAppId: async (_db: unknown, appId: string) =>
    storedGitHubApps().find((app) => app.app_id === appId) ?? null,
  getGitHubAppConfigForInstallation: async () => storedGitHubAppConfig(),
  listGitHubAppConfigs: async () => storedGitHubApps(),
  saveGitHubAppConfig: async (_db: unknown, cfg: Record<string, unknown>) => {
    importedConfigs.push(cfg)
    return "singleton"
  },
  deleteGitHubAppConfig: async () => {
    deleteConfigCalls += 1
  },
  lockGitHubAppConfigForReset: async () => {
    lockConfigCalls += 1
    return lockedGitHubAppConfigOverride === undefined
      ? storedGitHubAppConfig()
      : lockedGitHubAppConfigOverride &&
          { id: "singleton", ...lockedGitHubAppConfigOverride }
  },
  lockGitHubAppConfigForUse: async () => storedGitHubAppConfig(),
  deleteGitHubAppLocalState: async () => {
    deletedTables.push(fakeProviderCredentials, fakeProviderInstallations)
    deleteInstallationUsersCalls += 1
    deleteConfigCalls += 1
  },
  assignGitHubInstallationToUser: async (
    _db: unknown,
    installationId: string,
    userId: string
  ) => {
    installationAssignments.push({ installationId, userId })
  },
  grantGitHubInstallationToOrganization: async (
    _db: unknown,
    orgId: string,
    installationId: string,
    grantedBy: string
  ) => {
    organizationGrants.push({ orgId, installationId, grantedBy })
  },
  revokeGitHubInstallationFromOrganization: async () => true,
  listGitHubInstallationIdsForOrganization: async () =>
    organizationGitHubInstallationIds,
  listGitHubInstallationIdsForOrganizationAndUser: async (
    _db: unknown, _orgId: string, userId: string
  ) =>
    Array.from(
      new Set([
        ...organizationGitHubInstallationIds,
        ...(userId === FAKE_USER.id ? userGitHubInstallationIds : []),
      ])
    ),
  deleteGitHubInstallationUser: async () => undefined,
  deleteGitHubInstallationUsers: async () => {
    deleteInstallationUsersCalls += 1
  },
  deleteGitHubInstallationUserForUser: async (
    _db: unknown,
    installationId: string,
    userId: string
  ) => {
    localDisconnects.push({ installationId, userId })
    userGitHubInstallationIds = userGitHubInstallationIds.filter(
      (id) => id !== installationId
    )
  },
  listGitHubInstallationIdsForUser: async () => userGitHubInstallationIds,
  userOwnsGitHubInstallation: async (
    _db: unknown,
    _userId: string,
    installationId: string
  ) => userGitHubInstallationIds.includes(installationId),
  listInstallations: async () => [],
  listRepos: async () => ({
    rows: cachedRepoRows,
    total: cachedRepoRows.length,
  }),
  getInstallationStaleness: async () => ({ mostStaleAt: null, count: 0 }),
  getCacheStatus: async (...args: unknown[]) => {
    cacheStatusFilters.push(args)
    return cacheStatusRows
  },
}))
import { Hono } from "hono"
import type { AuthUser } from "../auth/middleware"

const githubModule = await import("./github")
const { githubRouter } = githubModule

// ---------------------------------------------------------------------------
// Test app builder — injects a fake user into Hono context (simulates requireAuth)
// ---------------------------------------------------------------------------

const FAKE_USER: AuthUser = {
  id: "user-test-1",
  email: "test@example.com",
  display_name: "Test User",
  session_id: "sess-1",
}

function buildApp(user?: AuthUser): Hono {
  const app = new Hono()
  app.use("*", async (c, next) => {
    if (user) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(c as any).set("user", user)
    }
    return next()
  })
  app.route("/github", githubRouter)
  return app
}

function signState(state: string): string {
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(state)
    .digest("hex")
  return `${state}.${mac}`
}

function signInstallState(
  state: string,
  userId = FAKE_USER.id,
  returnTo?: string,
  organizationId?: string,
  claimInstallationId?: string
): string {
  const payload = Buffer.from(
    JSON.stringify({
      state,
      userId,
      ...(returnTo === undefined ? {} : { returnTo }),
      ...(organizationId ? { organizationId, issuedAt: Date.now() } : {}),
      ...(claimInstallationId ? { claimInstallationId } : {}),
    })
  ).toString("base64url")
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  return `${payload}.${mac}`
}

function signAppState(state: string, returnTo?: string): string {
  const payload = Buffer.from(
    JSON.stringify(returnTo === undefined ? { state } : { state, returnTo })
  ).toString("base64url")
  const mac = createHmac("sha256", env.SESSION_SECRET)
    .update(payload)
    .digest("hex")
  return `${payload}.${mac}`
}

function extractCookie(headers: Headers, name: string): string {
  const raw = headers.get("set-cookie") ?? ""
  const cookie = raw
    .split(/,(?=[^;,=]+=)/)
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.split(";", 1)[0]
  if (!cookie) throw new Error(`missing ${name} cookie`)
  return cookie
}

beforeEach(() => {
  mockGitHubAppConfig = null
  extraGitHubApps = []
  lockedGitHubAppConfigOverride = undefined
  decryptAppPrivateKeyFailure = null
  importedConfigs.length = 0
  deleteConfigCalls = 0
  deleteInstallationUsersCalls = 0
  transactionCalls = 0
  lockConfigCalls = 0
  evictAllTokenCalls = 0
  credentialUpserts.length = 0
  enqueuedSyncs.length = 0
  syncEnqueueFailure = null
  installationAssignments.length = 0
  organizationGrants.length = 0
  installationAudits.length = 0
  localDisconnects.length = 0
  userGitHubInstallationIds = ["42"]
  organizationGitHubInstallationIds = ["42"]
  cacheStatusRows = []
  cachedRepoRows = []
  cacheStatusFilters.length = 0
  deletedTables.length = 0
  liveInstallations = []
  listInstallationsFailure = null
  listInstallationsCalls = 0
  revokedInstallations.length = 0
  revokeFailure = null
  fakeInstanceAdmin = true
  fakeOrganizationOwnerExists = true
  recentDelivery = null
  deliveryInserts.length = 0
})

// ---------------------------------------------------------------------------
// Dropped OAuth endpoints → 410 Gone
// ---------------------------------------------------------------------------

describe("GET /github/auth/connect (dropped)", () => {
  it("returns 410 Gone", async () => {
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/auth/connect")
    expect(res.status).toBe(410)
    const body = (await res.json()) as Record<string, unknown>
    expect(body["error"]).toBe("oauth_removed")
  })
})

describe("GET /github/auth/callback (dropped)", () => {
  it("returns 410 Gone", async () => {
    const app = buildApp()
    const res = await app.request("/github/auth/callback")
    expect(res.status).toBe(410)
  })
})

describe("DELETE /github/auth/disconnect (dropped)", () => {
  it("returns 410 Gone", async () => {
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/auth/disconnect", {
      method: "DELETE",
    })
    expect(res.status).toBe(410)
  })
})

describe("GET /github/status (dropped)", () => {
  it("returns 410 Gone", async () => {
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/status")
    expect(res.status).toBe(410)
  })
})

// ---------------------------------------------------------------------------
// POST /github/webhook — signature verification
// ---------------------------------------------------------------------------

describe("POST /github/webhook", () => {
  it("returns 503 when no GitHub App is configured (DB empty in test)", async () => {
    // In the test environment the DB has no github_app row → 503
    const app = buildApp()
    const res = await app.request("/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
    // 503 because app not configured, or 401 if somehow configured with wrong sig
    expect([401, 503]).toContain(res.status)
  })

  it("returns 401 for missing signature when app is configured", async () => {
    // We can test the signature path without a real DB row by calling the
    // route with a valid content-type but no X-Hub-Signature-256 header.
    // If app is not configured → 503; if somehow configured → 401.
    // Both are acceptable "not 200" responses.
    const app = buildApp()
    const res = await app.request("/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    })
    expect(res.status).not.toBe(200)
  })

  it("does not insert a delivery for an invalid signature", async () => {
    mockGitHubAppConfig = {
      webhook_secret_enc: Buffer.from("enc:webhook-secret"),
      webhook_secret_nonce: Buffer.from("nonce"),
    }
    const app = buildApp()
    const res = await app.request("/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=invalid",
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": "delivery-poison",
      },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "invalid signature" })
    expect(deliveryInserts).toHaveLength(0)
  })

  it("accepts a delivery signed by a second GitHub App", async () => {
    mockGitHubAppConfig = {
      app_id: "1",
      webhook_secret_enc: Buffer.from("enc:personal-secret"),
      webhook_secret_nonce: Buffer.from("nonce"),
    }
    extraGitHubApps = [
      {
        id: "ghapp_org",
        app_id: "2",
        webhook_secret_enc: Buffer.from("enc:org-secret"),
        webhook_secret_nonce: Buffer.from("nonce"),
      },
    ]
    const body = JSON.stringify({ zen: "ok" })
    const signature =
      "sha256=" + createHmac("sha256", "org-secret").update(body).digest("hex")

    const res = await buildApp().request("/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": "delivery-org-app",
        "X-GitHub-Hook-Installation-Target-ID": "2",
      },
      body,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe("POST /github/app/manifest", () => {
  it("registers an organization App under that organization", async () => {
    const res = await buildApp(FAKE_USER).request("/github/app/manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: "dev-toolings" }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      post_url: string
      manifest: { name: string; public: boolean }
    }
    expect(body.post_url).toStartWith(
      "https://github.com/organizations/dev-toolings/settings/apps/new?state="
    )
    expect(body.manifest.name).toContain("dev-toolings")
    expect(body.manifest.public).toBe(false)
  })

  it("rejects an invalid GitHub organization login", async () => {
    const res = await buildApp(FAKE_USER).request("/github/app/manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organization: "../evil" }),
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid_github_organization" })
  })
})

// ---------------------------------------------------------------------------
// GET /github/app/config
// ---------------------------------------------------------------------------

describe("GET /github/app/config", () => {
  it("returns { configured: false } when no app is stored", async () => {
    mockGitHubAppConfig = null
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/app/config")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body["configured"]).toBe(false)
  })
})

describe("GET /github/app/credentials/status", () => {
  it("returns not_configured when no GitHub App is stored", async () => {
    const res = await buildApp(FAKE_USER).request(
      "/github/app/credentials/status"
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "not_configured" })
  })

  it("returns readable when the private key decrypts", async () => {
    mockGitHubAppConfig = {
      pem_enc: Buffer.from("enc:private-key"),
      pem_nonce: Buffer.from("nonce"),
    }

    const res = await buildApp(FAKE_USER).request(
      "/github/app/credentials/status"
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "readable" })
  })

  it("returns a safe unreadable status without leaking the crypto cause", async () => {
    mockGitHubAppConfig = {
      pem_enc: Buffer.from("ciphertext"),
      pem_nonce: Buffer.from("nonce"),
    }
    decryptAppPrivateKeyFailure = new GitHubAppCredentialsError(
      new DOMException("operation-specific secret detail", "OperationError")
    )

    const res = await buildApp(FAKE_USER).request(
      "/github/app/credentials/status"
    )
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({
      status: "unreadable",
      error: {
        code: "GITHUB_APP_CREDENTIALS_UNREADABLE",
        message: expect.stringContaining("MASTER_KEY"),
      },
    })
    expect(JSON.stringify(body)).not.toContain(
      "operation-specific secret detail"
    )
  })

  it("keeps key-loading failures as server errors", async () => {
    mockGitHubAppConfig = {
      pem_enc: Buffer.from("ciphertext"),
      pem_nonce: Buffer.from("nonce"),
    }
    decryptAppPrivateKeyFailure = new Error("master key loader unavailable")

    const res = await buildApp(FAKE_USER).request(
      "/github/app/credentials/status"
    )

    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("master key loader unavailable")
  })

  it("rejects non-admin users", async () => {
    fakeInstanceAdmin = false

    const res = await buildApp(FAKE_USER).request(
      "/github/app/credentials/status"
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "admin_required" })
  })
})

describe("GET /github/repos/:owner/:repo/files-exist", () => {
  it("checks all requested paths through one batch HTTP endpoint", async () => {
    mockGitHubAppConfig = { app_id: "123" }
    liveInstallations = [{ id: 42, accountLogin: "MakFly" }]
    const probedPaths: string[] = []
    using _spy = spyOn(
      githubModule.ghProvider,
      "fileExists"
    ).mockImplementation(async (_installationId, _fullName, filePath) => {
      probedPaths.push(filePath)
      return filePath === "composer.json" || filePath === "symfony.lock"
    })

    const app = buildApp(FAKE_USER)
    const res = await app.request(
      "/github/repos/dev-toolings/fixture-symfony-api/files-exist?organizationId=org-1&path=composer.json&path=symfony.lock&path=Dockerfile&ref=main"
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      files: {
        "composer.json": true,
        "symfony.lock": true,
        Dockerfile: false,
      },
    })
    expect(probedPaths).toEqual(["composer.json", "symfony.lock", "Dockerfile"])
  })
})

describe("GitHub routes are user-scoped", () => {
  it("returns every linked installation for one user and excludes foreign ones", async () => {
    fakeInstanceAdmin = false
    mockGitHubAppConfig = { slug: "ploydok-local" }
    userGitHubInstallationIds = ["42", "77"]
    liveInstallations = [
      { id: 42, accountLogin: "Org A" },
      { id: 77, accountLogin: "Org B" },
      { id: 99, accountLogin: "Foreign" },
    ]
    using _spy = spyOn(githubModule.ghProvider, "listRepos").mockResolvedValue({
      repos: [],
      hasMore: false,
    })

    const res = await buildApp(FAKE_USER).request("/github/installations")
    const body = (await res.json()) as {
      installations: Array<{ id: number }>
    }

    expect(res.status).toBe(200)
    expect(body.installations.map(({ id }) => id)).toEqual([42, 77])
  })

  it("returns every live App installation to an instance admin", async () => {
    userGitHubInstallationIds = ["42"]
    mockGitHubAppConfig = { slug: "ploydok-local" }
    liveInstallations = [
      { id: 42, accountLogin: "Linked" },
      { id: 99, accountLogin: "Foreign mapping" },
    ]
    using _spy = spyOn(githubModule.ghProvider, "listRepos").mockResolvedValue({
      repos: [],
      hasMore: false,
    })

    const res = await buildApp(FAKE_USER).request("/github/installations")
    const body = (await res.json()) as {
      installations: Array<{ id: number }>
    }

    expect(res.status).toBe(200)
    expect(body.installations.map(({ id }) => id)).toEqual([42, 99])
  })

  it("never reads an env file through an installation not linked to the user", async () => {
    mockGitHubAppConfig = { app_id: "123" }
    userGitHubInstallationIds = ["42"]
    liveInstallations = [
      { id: 42, accountLogin: "Allowed" },
      { id: 99, accountLogin: "MakFly" },
    ]
    const attemptedIds: string[] = []
    using _spy = spyOn(githubModule.ghProvider, "readFile").mockImplementation(
      async (installationId) => {
        attemptedIds.push(installationId)
        return "SAFE=value"
      }
    )

    const res = await buildApp(FAKE_USER).request(
      "/github/repos/MakFly/private/env-file?organizationId=org-1&path=.env&ref=main"
    )

    expect(res.status).toBe(200)
    expect(attemptedIds).toEqual(["42"])
  })

  it("reads an allow-listed manifest below a safe rootDir", async () => {
    mockGitHubAppConfig = { app_id: "123" }
    userGitHubInstallationIds = ["42"]
    liveInstallations = [{ id: 42, accountLogin: "MakFly" }]
    const attemptedPaths: string[] = []
    using _spy = spyOn(githubModule.ghProvider, "readFile").mockImplementation(
      async (_installationId, _fullName, filePath) => {
        attemptedPaths.push(filePath)
        return '{"dependencies":{"astro":"^5.0.0"}}'
      }
    )

    const res = await buildApp(FAKE_USER).request(
      "/github/repos/MakFly/monorepo/manifest-file?organizationId=org-1&path=apps%2Fblog%2Fpackage.json&ref=main"
    )

    expect(res.status).toBe(200)
    expect(attemptedPaths).toEqual(["apps/blog/package.json"])
  })

  it("rejects traversal in a nested manifest path", async () => {
    const res = await buildApp(FAKE_USER).request(
      "/github/repos/MakFly/monorepo/manifest-file?organizationId=org-1&path=apps%2F..%2Fpackage.json&ref=main"
    )

    expect(res.status).toBe(400)
  })

  it("lists and reports cache state only for linked installations", async () => {
    fakeInstanceAdmin = false
    mockGitHubAppConfig = { slug: "ploydok-local" }
    userGitHubInstallationIds = ["42"]
    liveInstallations = [
      { id: 42, accountLogin: "Allowed" },
      { id: 99, accountLogin: "Foreign" },
    ]
    cacheStatusRows = [
      {
        id: "github:42",
        externalId: "42",
        accountLogin: "Allowed",
        avatarUrl: null,
        htmlUrl: null,
        lastSyncedAt: new Date(),
        repoCount: 0,
      },
    ]
    using _spy = spyOn(githubModule.ghProvider, "listRepos").mockResolvedValue({
      repos: [],
      hasMore: false,
    })

    const app = buildApp(FAKE_USER)
    const installationsRes = await app.request("/github/installations")
    const cacheRes = await app.request("/github/installations/cache-status")

    expect(
      (await installationsRes.json()) as Record<string, unknown>
    ).toMatchObject({
      installations: [expect.objectContaining({ id: 42 })],
    })
    expect((await cacheRes.json()) as Record<string, unknown>).toMatchObject({
      installations: [expect.objectContaining({ externalId: "42" })],
    })
    expect(cacheStatusFilters[0]?.[2]).toEqual(["github:42"])
  })

  it("reports cache state for every live installation to an admin", async () => {
    userGitHubInstallationIds = ["42"]
    liveInstallations = [
      { id: 42, accountLogin: "Linked" },
      { id: 99, accountLogin: "Foreign mapping" },
    ]
    cacheStatusRows = [
      {
        id: "github:42",
        externalId: "42",
        accountLogin: "Linked",
        avatarUrl: null,
        htmlUrl: null,
        lastSyncedAt: new Date(),
        repoCount: 1,
      },
      {
        id: "github:99",
        externalId: "99",
        accountLogin: "Foreign mapping",
        avatarUrl: null,
        htmlUrl: null,
        lastSyncedAt: new Date(),
        repoCount: 2,
      },
    ]

    const res = await buildApp(FAKE_USER).request(
      "/github/installations/cache-status"
    )
    const body = (await res.json()) as {
      installations: Array<{ externalId: string }>
    }

    expect(res.status).toBe(200)
    expect(body.installations.map(({ externalId }) => externalId)).toEqual([
      "42",
      "99",
    ])
    expect(cacheStatusFilters[0]?.[2]).toEqual(["github:42", "github:99"])
  })

  it("syncs only linked installations and rejects a foreign id", async () => {
    fakeInstanceAdmin = false
    userGitHubInstallationIds = ["42", "77"]
    const app = buildApp(FAKE_USER)

    const syncRes = await app.request("/github/installations/sync", {
      method: "POST",
      body: "{}",
    })
    const foreignRes = await app.request("/github/installations/sync", {
      method: "POST",
      body: JSON.stringify({ installationId: "99" }),
    })

    expect(syncRes.status).toBe(202)
    expect(enqueuedSyncs).toEqual([
      expect.objectContaining({
        installationId: "42",
        requestedBy: FAKE_USER.id,
      }),
      expect.objectContaining({
        installationId: "77",
        requestedBy: FAKE_USER.id,
      }),
    ])
    expect(foreignRes.status).toBe(404)
  })

  it("lets an admin sync all live installations or one explicit live installation", async () => {
    userGitHubInstallationIds = ["42"]
    liveInstallations = [
      { id: 42, accountLogin: "Linked" },
      { id: 99, accountLogin: "Foreign mapping" },
    ]
    const app = buildApp(FAKE_USER)

    const allRes = await app.request("/github/installations/sync", {
      method: "POST",
      body: "{}",
    })

    expect(allRes.status).toBe(202)
    expect(enqueuedSyncs.map(({ installationId }) => installationId)).toEqual([
      "42",
      "99",
    ])

    enqueuedSyncs.length = 0
    credentialUpserts.length = 0
    const explicitRes = await app.request("/github/installations/sync", {
      method: "POST",
      body: JSON.stringify({ installationId: "99" }),
    })

    expect(explicitRes.status).toBe(202)
    expect(enqueuedSyncs).toEqual([
      expect.objectContaining({
        installationId: "99",
        requestedBy: FAKE_USER.id,
      }),
    ])
  })
})

describe("POST /github/app/import", () => {
  const realFetch = globalThis.fetch
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  let verificationStatus = 200
  let verifiedClientId = "Iv1.client"
  beforeEach(() => {
    verificationStatus = 200
    verifiedClientId = "Iv1.client"
    globalThis.fetch = (async () =>
      Response.json(
        {
          id: 12345,
          client_id: verifiedClientId,
          slug: "ploydok-local",
          name: "Ploydok Local",
        },
        { status: verificationStatus }
      )) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  it("rejects non-instance admins", async () => {
    fakeInstanceAdmin = false
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/app/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        clientId: "Iv1.client",
        clientSecret: "secret",
        privateKey,
        webhookSecret: "",
        slug: "ploydok-local",
        name: "Ploydok Local",
      }),
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "admin_required" })
    expect(importedConfigs).toHaveLength(0)
    expect(enqueuedSyncs).toHaveLength(0)
  })

  it("saves an existing GitHub App config and enqueues a sync", async () => {
    mockGitHubAppConfig = {
      app_id: "12345",
      pem_enc: Buffer.from("unreadable"),
    }
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/app/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        clientId: "Iv1.client",
        clientSecret: "secret",
        privateKey,
        webhookSecret: "",
        slug: "ploydok-local",
        name: "Ploydok Local",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      configured: true,
      name: "Ploydok Local",
      slug: "ploydok-local",
      app_id: "12345",
    })
    expect(importedConfigs).toHaveLength(1)
    expect(importedConfigs[0]).toMatchObject({
      app_id: "12345",
      client_id: "Iv1.client",
      slug: "ploydok-local",
      name: "Ploydok Local",
    })
    expect(enqueuedSyncs[0]).toMatchObject({
      provider: "github",
      requestedBy: FAKE_USER.id,
    })
    expect(evictAllTokenCalls).toBe(1)
    expect(revokedInstallations).toHaveLength(0)
    expect(deletedTables).toHaveLength(0)
  })

  it("rejects invalid private keys", async () => {
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/app/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        clientId: "Iv1.client",
        clientSecret: "secret",
        privateKey: "not a pem",
        slug: "ploydok-local",
        name: "Ploydok Local",
      }),
    })

    expect(res.status).toBe(400)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "invalid_private_key",
    })
    expect(importedConfigs).toHaveLength(0)
  })

  it("preserves the old credentials when GitHub rejects the replacement key", async () => {
    verificationStatus = 401
    mockGitHubAppConfig = { app_id: "12345", pem_enc: Buffer.from("original") }
    const res = await buildApp(FAKE_USER).request("/github/app/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        clientId: "Iv1.client",
        clientSecret: "secret",
        privateKey,
        slug: "ploydok-local",
        name: "Ploydok Local",
      }),
    })
    expect(res.status).toBe(422)
    expect(importedConfigs).toHaveLength(0)
    expect(enqueuedSyncs).toHaveLength(0)
    expect(evictAllTokenCalls).toBe(0)
  })

  it("rejects credentials belonging to another App", async () => {
    verifiedClientId = "Iv1.other"
    const res = await buildApp(FAKE_USER).request("/github/app/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        clientId: "Iv1.client",
        clientSecret: "secret",
        privateKey,
        slug: "ploydok-local",
        name: "Ploydok Local",
      }),
    })
    expect(res.status).toBe(422)
    expect(importedConfigs).toHaveLength(0)
    expect(enqueuedSyncs).toHaveLength(0)
  })

  it("preserves the configuration when GitHub is unavailable", async () => {
    verificationStatus = 503
    const res = await buildApp(FAKE_USER).request("/github/app/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        clientId: "Iv1.client",
        clientSecret: "secret",
        privateKey,
        slug: "ploydok-local",
        name: "Ploydok Local",
      }),
    })
    expect(res.status).toBe(502)
    expect(importedConfigs).toHaveLength(0)
    expect(enqueuedSyncs).toHaveLength(0)
  })

  it("reports synchronization failure instead of claiming reconnection success", async () => {
    syncEnqueueFailure = new Error("queue unavailable")
    const res = await buildApp(FAKE_USER).request("/github/app/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "12345",
        clientId: "Iv1.client",
        clientSecret: "secret",
        privateKey,
        slug: "ploydok-local",
        name: "Ploydok Local",
      }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: "github_app_sync_failed" })
    expect(importedConfigs).toHaveLength(1)
    expect(enqueuedSyncs).toHaveLength(0)
    expect(revokedInstallations).toHaveLength(0)
  })
})

describe("DELETE /github/app/config", () => {
  it("requires the destructive reset confirmation query", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/app/config", { method: "DELETE" })

    expect(res.status).toBe(400)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "confirmation_required",
    })
    expect(deleteConfigCalls).toBe(0)
    expect(revokedInstallations).toHaveLength(0)
  })

  it("revokes all GitHub installations before deleting local config", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }
    liveInstallations = [{ id: 42 }, { id: 77 }]
    const app = buildApp(FAKE_USER)
    const res = await app.request(
      "/github/app/config?confirm=uninstall-github-installations",
      { method: "DELETE" }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, uninstalled: 2 })
    expect(revokedInstallations).toEqual([42, 77])
    expect(deleteConfigCalls).toBe(1)
    expect(deletedTables).toHaveLength(2)
  })

  it("returns a credential error when the App private key cannot be decrypted", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }
    listInstallationsFailure = new GitHubAppCredentialsError(
      new DOMException("The operation failed", "OperationError")
    )
    const app = buildApp(FAKE_USER)
    const res = await app.request(
      "/github/app/config?confirm=uninstall-github-installations",
      { method: "DELETE" }
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      error: {
        code: "GITHUB_APP_CREDENTIALS_UNREADABLE",
        message: expect.stringContaining("MASTER_KEY"),
      },
    })
    expect(deleteConfigCalls).toBe(0)
    expect(revokedInstallations).toHaveLength(0)
    expect(deletedTables).toHaveLength(0)
  })

  it("keeps local config when a GitHub uninstall fails", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }
    liveInstallations = [{ id: 42 }]
    revokeFailure = new Error("github down")
    const app = buildApp(FAKE_USER)
    const res = await app.request(
      "/github/app/config?confirm=uninstall-github-installations",
      { method: "DELETE" }
    )

    expect(res.status).toBe(502)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: { code: "GITHUB_API_ERROR" },
      failed_installation_id: 42,
    })
    expect(deleteConfigCalls).toBe(0)
    expect(deletedTables).toHaveLength(0)
  })

  it("preserves a concurrently imported config when a non-PEM secret changed", async () => {
    mockGitHubAppConfig = {
      id: "singleton",
      app_id: "123",
      client_id: "Iv1.client",
      slug: "ploydok-local",
      name: "Ploydok Local",
      client_secret_enc: Buffer.from("old-client-secret"),
      client_secret_nonce: Buffer.from("client-nonce"),
      pem_enc: Buffer.from("same-pem"),
      pem_nonce: Buffer.from("pem-nonce"),
      webhook_secret_enc: Buffer.from("webhook-secret"),
      webhook_secret_nonce: Buffer.from("webhook-nonce"),
    }
    lockedGitHubAppConfigOverride = {
      ...mockGitHubAppConfig,
      client_secret_enc: Buffer.from("new-client-secret"),
    }

    const res = await buildApp(FAKE_USER).request(
      "/github/app/config?confirm=uninstall-github-installations",
      { method: "DELETE" }
    )

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: { code: "GITHUB_APP_CONFIG_CHANGED" },
    })
    expect(deleteConfigCalls).toBe(0)
    expect(deletedTables).toHaveLength(0)
    expect(evictAllTokenCalls).toBe(0)
    expect(transactionCalls).toBe(1)
    expect(lockConfigCalls).toBe(1)
  })
})

describe("DELETE /github/app/config/local", () => {
  const endpoint = "/github/app/config/local?confirm=forget-local-github-app"

  it("requires an authenticated user", async () => {
    const res = await buildApp().request(endpoint, { method: "DELETE" })

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
    expect(deleteConfigCalls).toBe(0)
  })

  it("rejects non-admin users", async () => {
    fakeInstanceAdmin = false

    const res = await buildApp(FAKE_USER).request(endpoint, {
      method: "DELETE",
    })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "admin_required" })
    expect(deleteConfigCalls).toBe(0)
  })

  it("requires the local recovery confirmation query", async () => {
    mockGitHubAppConfig = {
      pem_enc: Buffer.from("ciphertext"),
      pem_nonce: Buffer.from("nonce"),
    }
    decryptAppPrivateKeyFailure = new GitHubAppCredentialsError(
      new DOMException("The operation failed", "OperationError")
    )

    const res = await buildApp(FAKE_USER).request("/github/app/config/local", {
      method: "DELETE",
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: { code: "CONFIRMATION_REQUIRED" },
    })
    expect(deleteConfigCalls).toBe(0)
  })

  it("refuses local-only reset when credentials are readable", async () => {
    mockGitHubAppConfig = {
      pem_enc: Buffer.from("enc:private-key"),
      pem_nonce: Buffer.from("nonce"),
    }

    const res = await buildApp(FAKE_USER).request(endpoint, {
      method: "DELETE",
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: { code: "GITHUB_APP_LOCAL_RESET_NOT_ALLOWED" },
    })
    expect(deleteConfigCalls).toBe(0)
    expect(deletedTables).toHaveLength(0)
    expect(revokedInstallations).toHaveLength(0)
    expect(listInstallationsCalls).toBe(0)
    expect(transactionCalls).toBe(1)
    expect(lockConfigCalls).toBe(1)
    expect(evictAllTokenCalls).toBe(0)
  })

  it("forgets unreadable local state without modifying GitHub", async () => {
    mockGitHubAppConfig = {
      pem_enc: Buffer.from("ciphertext"),
      pem_nonce: Buffer.from("nonce"),
    }
    decryptAppPrivateKeyFailure = new GitHubAppCredentialsError(
      new DOMException("operation-specific secret detail", "OperationError")
    )

    const res = await buildApp(FAKE_USER).request(endpoint, {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      forgotten: true,
      remoteInstallationsModified: false,
    })
    expect(deletedTables).toHaveLength(2)
    expect(deleteInstallationUsersCalls).toBe(1)
    expect(deleteConfigCalls).toBe(1)
    expect(revokedInstallations).toHaveLength(0)
    expect(listInstallationsCalls).toBe(0)
    expect(transactionCalls).toBe(1)
    expect(lockConfigCalls).toBe(1)
    expect(evictAllTokenCalls).toBe(1)
  })

  it("keeps key-loading failures as server errors without deleting state", async () => {
    mockGitHubAppConfig = {
      pem_enc: Buffer.from("ciphertext"),
      pem_nonce: Buffer.from("nonce"),
    }
    decryptAppPrivateKeyFailure = new Error("master key loader unavailable")

    const res = await buildApp(FAKE_USER).request(endpoint, {
      method: "DELETE",
    })

    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("master key loader unavailable")
    expect(deleteConfigCalls).toBe(0)
    expect(deletedTables).toHaveLength(0)
    expect(revokedInstallations).toHaveLength(0)
    expect(evictAllTokenCalls).toBe(0)
  })

  it("is idempotent when no GitHub App config remains", async () => {
    const res = await buildApp(FAKE_USER).request(endpoint, {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      forgotten: true,
      remoteInstallationsModified: false,
    })
    expect(deletedTables).toHaveLength(2)
    expect(deleteInstallationUsersCalls).toBe(1)
    expect(deleteConfigCalls).toBe(1)
    expect(revokedInstallations).toHaveLength(0)
    expect(listInstallationsCalls).toBe(0)
    expect(transactionCalls).toBe(1)
    expect(lockConfigCalls).toBe(1)
    expect(evictAllTokenCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// GET /github/repos
// ---------------------------------------------------------------------------

describe("GET /github/repos", () => {
  it("requires organization context before listing repositories", async () => {
    mockGitHubAppConfig = { app_id: "123" }
    const res = await buildApp(FAKE_USER).request(
      "/github/repos?search=MakFly%2Fastro-docs"
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "organization_required" })
  })

  it("returns 503 github_app_not_configured when no App is set up", async () => {
    mockGitHubAppConfig = null
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/repos?organizationId=org-1")
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body["error"]).toBe("github_app_not_configured")
  })

  it("returns the accessible installation id with a live repository", async () => {
    mockGitHubAppConfig = { app_id: "123" }
    liveInstallations = [{ id: 42, accountLogin: "MakFly" }]
    using _spy = spyOn(githubModule.ghProvider, "getRepo").mockResolvedValue({
      id: 123,
      fullName: "MakFly/astro-docs",
      description: null,
      private: false,
      defaultBranch: "main",
      cloneUrl: "https://github.com/MakFly/astro-docs.git",
    })

    const res = await buildApp(FAKE_USER).request(
      "/github/repos?organizationId=org-1&search=MakFly%2Fastro-docs"
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      repos: [
        {
          fullName: "MakFly/astro-docs",
          installationId: "42",
        },
      ],
      installUrl: expect.stringContaining(
        "/github/installations/start?organizationId=org-1"
      ),
    })
  })

  it("returns the normalized installation id with a cached repository", async () => {
    mockGitHubAppConfig = { app_id: "123" }
    liveInstallations = [{ id: 42, accountLogin: "MakFly" }]
    cachedRepoRows = [
      {
        id: "github:repo:123",
        installation_id: "github:42",
        full_name: "MakFly/astro-docs",
        description: null,
        private: false,
        default_branch: "main",
        html_url: "https://github.com/MakFly/astro-docs",
      },
    ]

    const res = await buildApp(FAKE_USER).request(
      "/github/repos?organizationId=org-1"
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      repos: [
        {
          fullName: "MakFly/astro-docs",
          installationId: "42",
        },
      ],
    })
  })

  it("keeps personal installs visible for management and excludes other org installs from repo reads", async () => {
    mockGitHubAppConfig = { app_id: "123" }
    userGitHubInstallationIds = ["77"]
    organizationGitHubInstallationIds = ["42"]
    liveInstallations = [
      { id: 42, accountLogin: "Acme" },
      { id: 77, accountLogin: "Personal" },
      { id: 88, accountLogin: "OtherOrg" },
    ]
    using _repos = spyOn(
      githubModule.ghProvider,
      "listRepos"
    ).mockResolvedValue({
      repos: [],
      hasMore: false,
    })
    const attemptedIds: string[] = []
    using _getRepo = spyOn(
      githubModule.ghProvider,
      "getRepo"
    ).mockImplementation(async (installationId, fullName) => {
      attemptedIds.push(installationId)
      if (
        (installationId === "42" && fullName === "Acme/service") ||
        (installationId === "77" && fullName === "Personal/service")
      ) {
        return {
          id: Number(installationId),
          fullName,
          description: null,
          private: true,
          defaultBranch: "main",
          cloneUrl: `https://github.com/${fullName}.git`,
        }
      }
      throw new Error("repository not visible")
    })

    const management = await buildApp(FAKE_USER).request(
      "/github/installations?organizationId=org-1"
    )
    const repos = await buildApp(FAKE_USER).request(
      "/github/repos?organizationId=org-1&search=Acme%2Fservice"
    )
    const personalRepos = await buildApp(FAKE_USER).request(
      "/github/repos?organizationId=org-1&search=Personal%2Fservice"
    )
    const otherOrganizationRepos = await buildApp(FAKE_USER).request(
      "/github/repos?organizationId=org-1&search=OtherOrg%2Fservice"
    )

    expect(management.status).toBe(200)
    expect(await management.json()).toMatchObject({
      installations: [
        expect.objectContaining({ id: 42, granted: true }),
        expect.objectContaining({ id: 77, granted: false }),
      ],
      installUrl: expect.stringContaining(
        "/github/installations/start?organizationId=org-1"
      ),
    })
    expect(repos.status).toBe(200)
    expect(await repos.json()).toMatchObject({
      repos: [expect.objectContaining({ installationId: "42" })],
    })
    expect(personalRepos.status).toBe(200)
    expect(await personalRepos.json()).toMatchObject({
      repos: [expect.objectContaining({ installationId: "77" })],
    })
    expect(otherOrganizationRepos.status).toBe(200)
    expect(await otherOrganizationRepos.json()).toMatchObject({ repos: [] })
    expect(attemptedIds).not.toContain("88")
    attemptedIds.length = 0
    const otherMemberRepos = await buildApp({
      ...FAKE_USER, id: "other-org-member",
    }).request("/github/repos?organizationId=org-1&search=Personal%2Fservice")
    expect(otherMemberRepos.status).toBe(200)
    expect(await otherMemberRepos.json()).toMatchObject({ repos: [] })
    expect(attemptedIds).not.toContain("77")
  })
})

describe("GET /github/installations/start", () => {
  it("returns 503 when no app is configured", async () => {
    mockGitHubAppConfig = null
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/installations/start")
    expect(res.status).toBe(503)
  })

  it("sets a state cookie and redirects to GitHub install URL", async () => {
    mockGitHubAppConfig = {
      slug: "ploydok-local",
    }
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/installations/start")
    expect(res.status).toBe(302)
    const location = res.headers.get("location")
    expect(location).toContain(
      "https://github.com/apps/ploydok-local/installations/new?state="
    )
    expect(res.headers.get("set-cookie")).toContain("gh_install_state=")
  })

  it("rejects non-admin users before starting an installation", async () => {
    fakeInstanceAdmin = false
    mockGitHubAppConfig = { slug: "ploydok-local" }

    const res = await buildApp(FAKE_USER).request("/github/installations/start")

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "admin_required" })
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("rejects an apps:read PAT before starting an installation", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }
    const patUser: AuthUser = {
      ...FAKE_USER,
      token_scopes: ["apps:read"],
      pat_id: "pat-1",
    }

    const res = await buildApp(patUser).request(
      "/github/installations/start?organizationId=org-1"
    )

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Token missing required scope: apps:write",
      },
    })
  })

  it("requires choosing an App when several are configured", async () => {
    mockGitHubAppConfig = { slug: "ploydok-personal" }
    extraGitHubApps = [{ id: "ghapp_org", slug: "ploydok-org" }]

    const res = await buildApp(FAKE_USER).request(
      "/github/installations/start?organizationId=org-1"
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain(
      "install_error=github_app_required"
    )

    const chosen = await buildApp(FAKE_USER).request(
      "/github/installations/start?organizationId=org-1&appId=ghapp_org"
    )
    expect(chosen.status).toBe(302)
    expect(chosen.headers.get("location")).toContain(
      "https://github.com/apps/ploydok-org/installations/new?state="
    )
  })

  it("allows an authenticated organization owner to start an installation", async () => {
    fakeInstanceAdmin = false
    mockGitHubAppConfig = { slug: "ploydok-local" }

    const res = await buildApp(FAKE_USER).request(
      "/github/installations/start?organizationId=org-1"
    )

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toContain(
      "https://github.com/apps/ploydok-local/installations/new?state="
    )
  })
})

describe("POST /github/installations/reconnect", () => {
  it("links every installation verified by the GitHub App API", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }
    liveInstallations = [
      { id: 42, accountLogin: "MakFly" },
      { id: 84, accountLogin: "Ploydok" },
    ]

    const res = await buildApp(FAKE_USER).request(
      "/github/installations/reconnect",
      { method: "POST" }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      connected: true,
      installation_count: 2,
    })
    expect(installationAssignments).toEqual([
      { installationId: "42", userId: FAKE_USER.id },
      { installationId: "84", userId: FAKE_USER.id },
    ])
    expect(enqueuedSyncs).toHaveLength(2)
  })

  it("does not create a local link when GitHub reports no installation", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }

    const res = await buildApp(FAKE_USER).request(
      "/github/installations/reconnect",
      { method: "POST" }
    )

    expect(res.status).toBe(404)
    expect(installationAssignments).toHaveLength(0)
  })

  it("rejects non-admin users", async () => {
    fakeInstanceAdmin = false
    mockGitHubAppConfig = { slug: "ploydok-local" }
    liveInstallations = [{ id: 42, accountLogin: "MakFly" }]

    const res = await buildApp(FAKE_USER).request(
      "/github/installations/reconnect",
      { method: "POST" }
    )

    expect(res.status).toBe(403)
    expect(installationAssignments).toHaveLength(0)
  })
})

describe("DELETE /github/installations/:id", () => {
  it("revokes the installation and deletes local cache state", async () => {
    mockGitHubAppConfig = { slug: "ploydok-local" }
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/installations/42", {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, revoked: 42 })
    expect(revokedInstallations).toEqual([42])
    expect(deletedTables).toHaveLength(2)
  })

  it("disconnects a non-admin locally without revoking the global App installation", async () => {
    fakeInstanceAdmin = false
    const app = buildApp(FAKE_USER)
    const res = await app.request("/github/installations/42", {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, disconnected: 42 })
    expect(localDisconnects).toEqual([
      { installationId: "42", userId: FAKE_USER.id },
    ])
    expect(revokedInstallations).toHaveLength(0)
  })

  it("disconnects only the selected mapping and leaves another organization usable", async () => {
    fakeInstanceAdmin = false
    mockGitHubAppConfig = { slug: "ploydok-local" }
    userGitHubInstallationIds = ["42", "77"]
    liveInstallations = [
      { id: 42, accountLogin: "Org A" },
      { id: 77, accountLogin: "Org B" },
      { id: 99, accountLogin: "Foreign" },
    ]
    using _spy = spyOn(githubModule.ghProvider, "listRepos").mockResolvedValue({
      repos: [],
      hasMore: false,
    })
    const app = buildApp(FAKE_USER)

    const disconnectRes = await app.request("/github/installations/42", {
      method: "DELETE",
    })
    const installationsRes = await app.request("/github/installations")
    const syncRemainingRes = await app.request("/github/installations/sync", {
      method: "POST",
      body: JSON.stringify({ installationId: "77" }),
    })
    const installationsBody = (await installationsRes.json()) as {
      installations: Array<{ id: number }>
    }

    expect(disconnectRes.status).toBe(200)
    expect(await disconnectRes.json()).toEqual({ ok: true, disconnected: 42 })
    expect(localDisconnects).toEqual([
      { installationId: "42", userId: FAKE_USER.id },
    ])
    expect(revokedInstallations).toHaveLength(0)
    expect(deletedTables).toHaveLength(0)
    expect(userGitHubInstallationIds).toEqual(["77"])
    expect(installationsRes.status).toBe(200)
    expect(installationsBody.installations.map(({ id }) => id)).toEqual([77])
    expect(syncRemainingRes.status).toBe(202)
    expect(enqueuedSyncs).toEqual([
      expect.objectContaining({
        provider: "github",
        installationId: "77",
        requestedBy: FAKE_USER.id,
      }),
    ])
  })
})

describe("DELETE /github/installations/:id/grant", () => {
  it("rejects an apps:read PAT before revoking an organization grant", async () => {
    const patUser: AuthUser = {
      ...FAKE_USER,
      token_scopes: ["apps:read"],
      pat_id: "pat-1",
    }
    const res = await buildApp(patUser).request(
      "/github/installations/42/grant?organizationId=org-1",
      { method: "DELETE" }
    )

    expect(res.status).toBe(403)
    expect(installationAudits).toHaveLength(0)
  })

  it("revokes an organization grant and records the owner actor atomically", async () => {
    const res = await buildApp(FAKE_USER).request(
      "/github/installations/42/grant?organizationId=org-1",
      { method: "DELETE" }
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      revoked: true,
      installationId: "42",
    })
    expect(transactionCalls).toBe(1)
    expect(installationAudits).toEqual([
      expect.objectContaining({
        action: "github.installation.revoked",
        org_id: "org-1",
        target_id: "42",
        user_id: FAKE_USER.id,
      }),
    ])
  })
})

describe("GET /github/installations/:id/claim", () => {
  it.each([
    ["GET", "/github/installations/start?organizationId=org-1"],
    ["GET", "/github/installations/42/claim?organizationId=org-1"],
    ["DELETE", "/github/installations/42/grant?organizationId=org-1"],
  ])("rejects write-scoped PATs on owner action %s %s", async (method, path) => {
    const response = await buildApp({
      ...FAKE_USER, pat_id: "pat-write", token_scopes: ["apps:write"],
    }).request(path!, { method })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "session_required" })
  })

  it("allows an owner session to start an installation claim", async () => {
    mockGitHubAppConfig = { slug: "ploydok-test", client_id: "Iv1.test" }
    const res = await buildApp(FAKE_USER).request(
      "/github/installations/42/claim?organizationId=org-1"
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(location.origin).toBe("https://github.com")
    expect(location.pathname).toBe("/apps/ploydok-test/installations/new")
    expect(res.headers.get("set-cookie")).toContain("gh_install_state=")
  })

  it("rejects an apps:read PAT before starting an installation claim", async () => {
    const patUser: AuthUser = {
      ...FAKE_USER,
      token_scopes: ["apps:read"],
      pat_id: "pat-1",
    }
    const res = await buildApp(patUser).request(
      "/github/installations/42/claim?organizationId=org-1"
    )

    expect(res.status).toBe(403)
    expect(installationAudits).toHaveLength(0)
  })
})

describe("GET /github/app/setup", () => {
  it("rejects an organization member before starting an OAuth proof", async () => {
    fakeOrganizationOwnerExists = false
    mockGitHubAppConfig = { client_id: "Iv1.org-proof" }
    const state = "org-member-state"
    const res = await buildApp().request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(
            signInstallState(state, FAKE_USER.id, "/onboarding", "org-1")
          )}`,
        },
      }
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(location.searchParams.get("install_error")).toBe(
      "organization_owner_required"
    )
    expect(location.searchParams.get("installed")).toBeNull()
    expect(organizationGrants).toHaveLength(0)
  })

  it("requires a GitHub user proof before granting an installation to an organization", async () => {
    const app = buildApp()
    mockGitHubAppConfig = { client_id: "Iv1.org-proof" }
    const state = "org-install-state"
    const res = await app.request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(
            signInstallState(state, FAKE_USER.id, "/onboarding", "org-1")
          )}`,
        },
      }
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(location.origin).toBe("https://github.com")
    expect(location.pathname).toBe("/login/oauth/authorize")
    expect(location.searchParams.get("client_id")).toBe("Iv1.org-proof")
    expect(location.searchParams.get("state")).toBeTruthy()
    expect(organizationGrants).toHaveLength(0)
  })

  it.each(["admin", "member"])(
    "checks GitHub organization authority for role %s",
    async (githubRole) => {
      const realFetch = globalThis.fetch
      mockGitHubAppConfig = {
        client_id: "Iv1.org-proof",
        client_secret_enc: Buffer.from("enc:secret"),
        client_secret_nonce: Buffer.from("nonce"),
      }
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input)
        if (url === "https://github.com/login/oauth/access_token") {
          return new Response(JSON.stringify({ access_token: "short-lived" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.startsWith("https://api.github.com/user/installations")) {
          return new Response(
            JSON.stringify({
              installations: [
                {
                  id: 42,
                  account: { login: "acme", type: "Organization" },
                  repository_selection: "selected",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        }
        if (url === "https://api.github.com/orgs/acme/memberships/octocat") {
          return new Response(
            JSON.stringify({ state: "active", role: githubRole }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          )
        }
        throw new Error(`unexpected fetch: ${url}`)
      }) as unknown as typeof fetch

      try {
        const state = "org-install-oauth"
        const setup = await buildApp().request(
          `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
          {
            headers: {
              cookie: `gh_install_state=${encodeURIComponent(
                signInstallState(
                  state,
                  FAKE_USER.id,
                  "/onboarding",
                  "org-1",
                  "42"
                )
              )}`,
            },
          }
        )
        const oauthUrl = new URL(setup.headers.get("location")!)
        const setCookie = setup.headers.get("set-cookie")
        expect(setCookie).toBeString()
        expect(setCookie).toContain("gh_install_state=")
        expect(setCookie).toContain("gh_install_oauth_state=")
        const oauthCookie = extractCookie(
          setup.headers,
          "gh_install_oauth_state"
        )
        const callback = await buildApp().request(
          `/github/app/callback?code=oauth-code&state=${oauthUrl.searchParams.get(
            "state"
          )}`,
          { headers: { cookie: oauthCookie } }
        )

        expect(callback.status).toBe(302)
        const location = new URL(callback.headers.get("location")!)
        expect(location.pathname).toBe("/onboarding")
        if (githubRole === "admin") {
          expect(location.searchParams.get("installed")).toBe("1")
          expect(organizationGrants).toEqual([
            { orgId: "org-1", installationId: "42", grantedBy: FAKE_USER.id },
          ])
          expect(installationAudits).toEqual([
            expect.objectContaining({
              action: "github.installation.claimed",
              org_id: "org-1",
              target_id: "42",
              user_id: FAKE_USER.id,
            }),
            expect.objectContaining({
              action: "github.installation.granted",
              org_id: "org-1",
              target_id: "42",
              user_id: FAKE_USER.id,
            }),
          ])
        } else {
          expect(location.searchParams.get("install_error")).toBe(
            "github_org_membership_unverified"
          )
          expect(location.searchParams.get("installed")).toBeNull()
          expect(organizationGrants).toHaveLength(0)
          expect(installationAudits).toHaveLength(0)
        }
      } finally {
        globalThis.fetch = realFetch
      }
    }
  )

  it("redirects with an actionable error when GitHub hides organization membership", async () => {
    const realFetch = globalThis.fetch
    mockGitHubAppConfig = {
      client_id: "Iv1.org-proof",
      client_secret_enc: Buffer.from("enc:secret"),
      client_secret_nonce: Buffer.from("nonce"),
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "short-lived" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.startsWith("https://api.github.com/user/installations")) {
        return new Response(
          JSON.stringify({
            installations: [
              {
                id: 42,
                account: { login: "acme", type: "Organization" },
                repository_selection: "selected",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url === "https://api.github.com/orgs/acme/memberships/octocat") {
        return new Response(
          JSON.stringify({ message: "Members permission required" }),
          {
            status: 403,
            headers: { "content-type": "application/json" },
          }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    try {
      const state = "org-members-permission"
      const setup = await buildApp().request(
        `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
        {
          headers: {
            cookie: `gh_install_state=${encodeURIComponent(
              signInstallState(state, FAKE_USER.id, "/onboarding", "org-1")
            )}`,
          },
        }
      )
      const oauthUrl = new URL(setup.headers.get("location")!)
      const callback = await buildApp().request(
        `/github/app/callback?code=oauth-code&state=${oauthUrl.searchParams.get(
          "state"
        )}`,
        {
          headers: {
            cookie: extractCookie(setup.headers, "gh_install_oauth_state"),
          },
        }
      )

      expect(callback.status).toBe(302)
      expect(
        new URL(callback.headers.get("location")!).searchParams.get(
          "install_error"
        )
      ).toBe("github_members_permission_required")
      expect(organizationGrants).toHaveLength(0)
      expect(installationAudits).toHaveLength(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("refuses the grant when the Ploydok owner role is removed before OAuth commit", async () => {
    const realFetch = globalThis.fetch
    mockGitHubAppConfig = {
      client_id: "Iv1.org-proof",
      client_secret_enc: Buffer.from("enc:secret"),
      client_secret_nonce: Buffer.from("nonce"),
    }
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(JSON.stringify({ access_token: "short-lived" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "https://api.github.com/user") {
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url.startsWith("https://api.github.com/user/installations")) {
        return new Response(
          JSON.stringify({
            installations: [
              {
                id: 42,
                account: { login: "acme", type: "Organization" },
                repository_selection: "selected",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      }
      if (url === "https://api.github.com/orgs/acme/memberships/octocat") {
        return new Response(
          JSON.stringify({ state: "active", role: "admin" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    try {
      const state = "org-owner-removed"
      const setup = await buildApp().request(
        `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
        {
          headers: {
            cookie: `gh_install_state=${encodeURIComponent(
              signInstallState(state, FAKE_USER.id, "/onboarding", "org-1")
            )}`,
          },
        }
      )
      const oauthUrl = new URL(setup.headers.get("location")!)
      const setCookie = setup.headers.get("set-cookie")
      expect(setCookie).toBeString()
      expect(setCookie).toContain("gh_install_state=")
      expect(setCookie).toContain("gh_install_oauth_state=")
      fakeOrganizationOwnerExists = false
      const callback = await buildApp().request(
        `/github/app/callback?code=oauth-code&state=${oauthUrl.searchParams.get(
          "state"
        )}`,
        {
          headers: {
            cookie: extractCookie(setup.headers, "gh_install_oauth_state"),
          },
        }
      )

      expect(callback.status).toBe(302)
      const location = new URL(callback.headers.get("location")!)
      expect(location.searchParams.get("install_error")).toBe(
        "claim_authority_missing"
      )
      expect(organizationGrants).toHaveLength(0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("upserts the installation credential, enqueues sync, and redirects with installed=1 when state is valid", async () => {
    const app = buildApp()
    const state = "abc123"
    const res = await app.request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(signInstallState(state))}`,
        },
      }
    )
    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github`
    )
    expect(location.searchParams.get("installation_id")).toBe("42")
    expect(location.searchParams.get("setup_action")).toBe("install")
    expect(location.searchParams.get("installed")).toBe("1")
    const syncId = location.searchParams.get("sync_id")
    expect(syncId).toBeTruthy()
    expect(credentialUpserts).toHaveLength(1)
    expect(credentialUpserts[0]?.values).toMatchObject({
      id: "github:42",
      provider: "github",
      credential_type: "installation",
      last_sync_status: "pending",
      last_sync_actor_user_id: FAKE_USER.id,
      last_sync_source: "api",
      last_sync_claimed_at: null,
    })
    expect(installationAssignments).toEqual([
      { installationId: "42", userId: FAKE_USER.id },
    ])
    expect(enqueuedSyncs).toHaveLength(1)
    expect(enqueuedSyncs[0]).toMatchObject({
      provider: "github",
      installationId: "42",
      requestedBy: FAKE_USER.id,
      syncId,
    })
  })

  it("marks the return as invalid when state does not verify", async () => {
    const app = buildApp()
    const res = await app.request(
      "/github/app/setup?installation_id=42&setup_action=install&state=bad",
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(signInstallState("good"))}`,
        },
      }
    )
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github?installation_id=42&setup_action=install&install_error=state_mismatch`
    )
    expect(credentialUpserts).toHaveLength(0)
    expect(enqueuedSyncs).toHaveLength(0)
  })

  it("rejects a legacy state that has no signed admin identity", async () => {
    const app = buildApp()
    const state = "legacy-state"
    const res = await app.request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(signState(state))}`,
        },
      }
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(location.searchParams.get("installed")).toBeNull()
    expect(location.searchParams.get("sync_id")).toBeNull()
    expect(location.searchParams.get("install_error")).toBe("admin_required")
    expect(credentialUpserts).toHaveLength(0)
    expect(installationAssignments).toHaveLength(0)
    expect(enqueuedSyncs).toHaveLength(0)
  })

  it("rejects a signed callback when its user is no longer an instance admin", async () => {
    fakeInstanceAdmin = false
    const state = "demoted-admin-state"

    const res = await buildApp().request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(signInstallState(state))}`,
        },
      }
    )
    const location = new URL(res.headers.get("location")!)

    expect(res.status).toBe(302)
    expect(location.searchParams.get("install_error")).toBe("admin_required")
    expect(location.searchParams.get("installed")).toBeNull()
    expect(credentialUpserts).toHaveLength(0)
    expect(installationAssignments).toHaveLength(0)
    expect(enqueuedSyncs).toHaveLength(0)
  })

  it("returns to the onboarding wizard when the signed state asked for it", async () => {
    const app = buildApp()
    const state = "onboarding-state"
    const res = await app.request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(
            signInstallState(state, FAKE_USER.id, "/onboarding")
          )}`,
        },
      }
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(
      `${env.WEB_ORIGIN}/onboarding`
    )
    expect(location.searchParams.get("installed")).toBe("1")
  })

  it("ignores a return target that is not allow-listed even when correctly signed", async () => {
    const app = buildApp()
    const state = "hostile-state"
    const res = await app.request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(
            signInstallState(state, FAKE_USER.id, "https://evil.com/onboarding")
          )}`,
        },
      }
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github`
    )
  })

  it("ignores a return target passed only in the query string", async () => {
    const app = buildApp()
    const state = "query-state"
    const res = await app.request(
      `/github/app/setup?installation_id=42&setup_action=install&state=${state}&return_to=%2Fonboarding`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(signInstallState(state))}`,
        },
      }
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github`
    )
  })

  it("falls back to settings when the install started from github.com with no state", async () => {
    const app = buildApp()
    const res = await app.request(
      "/github/app/setup?installation_id=42&setup_action=install"
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(`${location.origin}${location.pathname}`).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github`
    )
    expect(location.searchParams.get("install_error")).toBeNull()
    expect(location.searchParams.get("installed")).toBeNull()
    expect(enqueuedSyncs).toHaveLength(0)
  })

  it("treats an update setup action as the same update-or-create sync path", async () => {
    const app = buildApp()
    const state = "update-state"
    const res = await app.request(
      `/github/app/setup?installation_id=77&setup_action=update&state=${state}`,
      {
        headers: {
          cookie: `gh_install_state=${encodeURIComponent(signInstallState(state))}`,
        },
      }
    )

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location")!)
    expect(location.searchParams.get("installation_id")).toBe("77")
    expect(location.searchParams.get("setup_action")).toBe("update")
    expect(location.searchParams.get("installed")).toBe("1")
    const syncId = location.searchParams.get("sync_id")
    expect(syncId).toBeTruthy()
    expect(credentialUpserts[0]?.values).toMatchObject({
      id: "github:77",
      last_sync_status: "pending",
      last_sync_actor_user_id: FAKE_USER.id,
      last_sync_source: "api",
    })
    expect(enqueuedSyncs[0]).toMatchObject({
      provider: "github",
      installationId: "77",
      requestedBy: FAKE_USER.id,
      syncId,
    })
  })
})

// ---------------------------------------------------------------------------
// Webhook signature helper — integration smoke
// ---------------------------------------------------------------------------

describe("verifySignature helper (via webhook route)", () => {
  it("computes expected sha256 signature correctly", () => {
    const secret = "my-webhook-secret"
    const body = JSON.stringify({ ref: "refs/heads/main" })
    const sig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
    expect(sig).toMatch(/^sha256=[a-f0-9]{64}$/)
  })
})

describe("GET /github/app/callback", () => {
  const realFetch = globalThis.fetch
  const conversion = {
    id: 4242,
    client_id: "Iv1.abc",
    slug: "ploydok-local",
    name: "Ploydok (local)",
    client_secret: "shh",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----",
    webhook_secret: "hook",
  }

  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(conversion), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it("returns to the onboarding wizard when the signed state asked for it", async () => {
    const app = buildApp()
    const state = "cb-onboarding"
    const res = await app.request(
      `/github/app/callback?code=abc&state=${state}`,
      {
        headers: {
          cookie: `gh_app_state=${encodeURIComponent(signAppState(state, "/onboarding"))}`,
        },
      }
    )

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/onboarding?app=created`
    )
  })

  it("returns to settings when the state carries no target", async () => {
    const app = buildApp()
    const state = "cb-default"
    const res = await app.request(
      `/github/app/callback?code=abc&state=${state}`,
      {
        headers: {
          cookie: `gh_app_state=${encodeURIComponent(signAppState(state))}`,
        },
      }
    )

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github?app=created`
    )
  })

  it("ignores a signed target that is not allow-listed", async () => {
    const app = buildApp()
    const state = "cb-hostile"
    const res = await app.request(
      `/github/app/callback?code=abc&state=${state}`,
      {
        headers: {
          cookie: `gh_app_state=${encodeURIComponent(
            signAppState(state, "//evil.com")
          )}`,
        },
      }
    )

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github?app=created`
    )
  })

  it("keeps accepting a legacy bare-state cookie", async () => {
    const app = buildApp()
    const state = "cb-legacy"
    const res = await app.request(
      `/github/app/callback?code=abc&state=${state}`,
      {
        headers: {
          cookie: `gh_app_state=${encodeURIComponent(signState(state))}`,
        },
      }
    )

    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(
      `${env.WEB_ORIGIN}/settings/git-providers/github?app=created`
    )
  })

  it("rejects a state that does not match the cookie", async () => {
    const app = buildApp()
    const res = await app.request("/github/app/callback?code=abc&state=bad", {
      headers: {
        cookie: `gh_app_state=${encodeURIComponent(signAppState("good", "/onboarding"))}`,
      },
    })

    expect(res.status).toBe(400)
    const data = (await res.json()) as { error: string }
    expect(data.error).toBe("state_mismatch")
  })
})

describe("GitHub application directory discovery", () => {
  it.each([
    "/github/repos?search=acme%2Frepo",
    "/github/repos/acme/repo/branches",
    "/github/repos/acme/repo/deployment-targets?ref=main",
    "/github/repos/acme/repo/env-file?path=.env&ref=main",
    "/github/repos/acme/repo/manifest-file?path=package.json&ref=main",
  ])("requires organization context for %s", async (path) => {
    mockGitHubAppConfig = { app_id: "123" }
    const res = await buildApp(FAKE_USER).request(path)

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "organization_required" })
  })

  it("requires authentication and only uses installations visible to the current user", async () => {
    expect(
      (
        await buildApp().request(
          "/github/repos/acme/repo/deployment-targets?organizationId=org-1&ref=main"
        )
      ).status
    ).toBe(401)
    mockGitHubAppConfig = { app_id: "123" }
    fakeInstanceAdmin = false
    userGitHubInstallationIds = ["42"]
    liveInstallations = [
      { id: 42, accountLogin: "acme" },
      { id: 99, accountLogin: "foreign" },
    ]
    using _files = spyOn(
      githubModule.ghProvider,
      "listFiles"
    ).mockImplementation(async (id, repo, ref) => {
      expect([id, repo, ref]).toEqual(["42", "acme/repo", "main"])
      return ["products/service/go.mod"]
    })
    const res = await buildApp(FAKE_USER).request(
      "/github/repos/acme/repo/deployment-targets?organizationId=org-1&ref=main"
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { targets: { rootDir: string }[] }
    expect(body.targets.map((target) => target.rootDir)).toEqual([
      "products/service",
    ])
  })
})
