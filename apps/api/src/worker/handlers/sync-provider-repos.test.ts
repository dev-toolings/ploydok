// SPDX-License-Identifier: AGPL-3.0-only
import {
  describe,
  expect,
  it,
  mock,
  spyOn,
  beforeEach,
  afterEach,
} from "bun:test"
import * as installTokensMod from "../../github/installation-tokens"
import * as providerReposQueries from "@ploydok/db/queries"
import * as queues from "../queues"
import * as queueAuditMod from "../queue-audit"

// ---------------------------------------------------------------------------
// Minimal mock DB
// ---------------------------------------------------------------------------

type SelectChain = {
  from: (t: unknown) => SelectChain
  where: (c: unknown) => SelectChain
  limit: (n: number) => Promise<unknown[]>
  orderBy: (...args: unknown[]) => SelectChain
  then: (
    resolve: (v: unknown[]) => void,
    reject?: (err: unknown) => void
  ) => Promise<unknown[]>
  [Symbol.iterator]?: never
}

function makeSelectChain(rows: unknown[]): SelectChain {
  const chain: SelectChain = {
    from: () => chain,
    where: () => chain,
    limit: () =>
      Object.assign(Promise.resolve(rows), {
        for: (_mode: "update") => Promise.resolve(rows),
      }),
    orderBy: () => chain,
    then: (resolve, reject) => {
      try {
        resolve(rows)
        return Promise.resolve(rows)
      } catch (err) {
        reject?.(err as Error)
        return Promise.reject(err)
      }
    },
  }
  return chain
}

function mockDb(
  opts: { gitlabTokenRows?: unknown[]; updateRow?: unknown } = {}
) {
  const db = {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => makeSelectChain(opts.gitlabTokenRows ?? []),
    }),
    update: (_table: unknown) => ({
      set: (_values: unknown) => ({
        where: (_condition: unknown) => ({
          returning: () =>
            Promise.resolve([
              opts.updateRow ??
                ({
                  id: "test",
                  last_sync_source: "system",
                } as unknown),
            ]),
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_values: unknown) => ({
        onConflictDoUpdate: (_opts: unknown) => Promise.resolve(),
      }),
    }),
    delete: (_table: unknown) => ({
      where: (_condition: unknown) => Promise.resolve(),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  }
  return db
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const mockEnqueue = mock(
  async (_jobId: string, _payload: unknown, _opts: unknown) => Promise.resolve()
)

// ---------------------------------------------------------------------------
// GitHub fan-out
// ---------------------------------------------------------------------------

describe("handleSyncProviderRepos — GitHub fan-out", () => {
  let upsertInstallationSpy: ReturnType<typeof spyOn>
  let listInstallationsSpy: ReturnType<typeof spyOn>
  let getConfigSpy: ReturnType<typeof spyOn>
  let lockConfigSpy: ReturnType<typeof spyOn>

  const githubConfig = {
    id: "singleton",
    app_id: "123",
    pem_enc: Buffer.from("ciphertext"),
    pem_nonce: Buffer.from("nonce"),
  }

  beforeEach(() => {
    listInstallationsSpy = spyOn(
      installTokensMod,
      "listAppInstallations"
    ).mockResolvedValue([
      {
        id: 111,
        accountLogin: "org-a",
        accountType: "Organization",
        repositorySelection: "all",
        suspendedAt: null,
        htmlUrl: "https://github.com/orgs/org-a",
        avatarUrl: "https://avatars.githubusercontent.com/org-a",
        githubAppId: "singleton",
      },
      {
        id: 222,
        accountLogin: "org-b",
        accountType: "Organization",
        repositorySelection: "selected",
        suspendedAt: null,
        htmlUrl: "https://github.com/orgs/org-b",
        avatarUrl: "https://avatars.githubusercontent.com/org-b",
        githubAppId: "singleton",
      },
    ])

    upsertInstallationSpy = spyOn(
      providerReposQueries,
      "upsertInstallation"
    ).mockResolvedValue(undefined)

    // We spy on providerReposSyncQueue.add to capture enqueue calls
    spyOn(queues.providerReposSyncQueue, "add").mockImplementation(
      mockEnqueue as unknown as typeof queues.providerReposSyncQueue.add
    )

    getConfigSpy = spyOn(
      providerReposQueries,
      "listGitHubAppConfigs"
    ).mockResolvedValue([githubConfig] as never)
    lockConfigSpy = spyOn(
      providerReposQueries,
      "lockGitHubAppConfigsForUse"
    ).mockResolvedValue([githubConfig] as never)
  })

  afterEach(() => {
    listInstallationsSpy.mockRestore()
    upsertInstallationSpy.mockRestore()
    getConfigSpy.mockRestore()
    lockConfigSpy.mockRestore()
  })

  it("enqueues one child job per installation", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const db = mockDb()
    mockEnqueue.mockClear()

    await handleSyncProviderRepos(db as never, { provider: "github" })

    expect(listInstallationsSpy).toHaveBeenCalledTimes(1)
    // Installation freshness is not advanced by fan-out; only a complete
    // per-installation snapshot may publish it.
    expect(upsertInstallationSpy).not.toHaveBeenCalled()
    // Two child jobs enqueued (one per installation)
    expect(mockEnqueue.mock.calls.length).toBe(2)
    const payloads = mockEnqueue.mock.calls.map((c) => (c as unknown[])[1])
    expect(payloads).toContainEqual({
      provider: "github",
      installationId: "111",
    })
    expect(payloads).toContainEqual({
      provider: "github",
      installationId: "222",
    })
  })

  it("normalizes cached GitHub installation ids before enqueueing", async () => {
    const { enqueueProviderReposSync } = await import("./sync-provider-repos")
    mockEnqueue.mockClear()

    await enqueueProviderReposSync({
      provider: "github",
      installationId: "github:999",
    })

    expect(mockEnqueue.mock.calls.length).toBe(1)
    expect((mockEnqueue.mock.calls[0] as unknown[])[0]).toBe("github-999")
    expect((mockEnqueue.mock.calls[0] as unknown[])[1]).toMatchObject({
      provider: "github",
      installationId: "999",
    })
  })

  it("abandons without DB reinsertion or enqueue when config is deleted after fetch", async () => {
    lockConfigSpy.mockResolvedValueOnce([])
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const db = mockDb()
    mockEnqueue.mockClear()

    await handleSyncProviderRepos(db as never, { provider: "github" })

    expect(listInstallationsSpy).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it("abandons stale fan-out when the same App is re-imported", async () => {
    lockConfigSpy.mockResolvedValueOnce([
      {
        ...githubConfig,
        pem_enc: Buffer.from("replacement-ciphertext"),
        pem_nonce: Buffer.from("replacement-nonce"),
      },
    ] as never)
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const db = mockDb()
    mockEnqueue.mockClear()

    await handleSyncProviderRepos(db as never, { provider: "github" })

    expect(listInstallationsSpy).toHaveBeenCalledTimes(1)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GitHub per-installation
// ---------------------------------------------------------------------------

describe("handleSyncProviderRepos — GitHub per-installation", () => {
  let listReposSpy: ReturnType<typeof spyOn>
  let listInstallationsSpy: ReturnType<typeof spyOn>
  let replaceSnapshotSpy: ReturnType<typeof spyOn>
  let legacyBackfillSpy: ReturnType<typeof spyOn>
  let ownerAppSpy: ReturnType<typeof spyOn>
  let bindAppSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    const { ghProvider } = await import("../../routes/github")

    listInstallationsSpy = spyOn(
      installTokensMod,
      "listAppInstallations"
    ).mockResolvedValue([
      {
        id: 999,
        accountLogin: "org",
        accountType: "Organization",
        repositorySelection: "all",
        suspendedAt: null,
        htmlUrl: "https://github.com/orgs/org",
        avatarUrl: "https://avatars.githubusercontent.com/org",
        githubAppId: "singleton",
      },
    ])

    // Page 1 returns 2 repos with hasMore=true, page 2 returns 1 repo with hasMore=false
    let callCount = 0
    listReposSpy = spyOn(ghProvider, "listRepos").mockImplementation(
      async () => {
        callCount++
        if (callCount === 1) {
          return {
            repos: [
              {
                id: 1,
                fullName: "org/repo-a",
                description: null,
                defaultBranch: "main",
                private: false,
                cloneUrl: "",
              },
              {
                id: 2,
                fullName: "org/repo-b",
                description: "desc",
                defaultBranch: "main",
                private: true,
                cloneUrl: "",
              },
            ],
            hasMore: true,
          }
        }
        return {
          repos: [
            {
              id: 3,
              fullName: "org/repo-c",
              description: null,
              defaultBranch: "develop",
              private: false,
              cloneUrl: "",
            },
          ],
          hasMore: false,
        }
      }
    )

    replaceSnapshotSpy = spyOn(
      providerReposQueries,
      "replaceInstallationSnapshot"
    ).mockResolvedValue(undefined)
    legacyBackfillSpy = spyOn(
      providerReposQueries,
      "backfillLegacyGitHubInstallationGrants"
    ).mockResolvedValue(0)
    ownerAppSpy = spyOn(
      providerReposQueries,
      "getGitHubAppConfigForInstallation"
    ).mockResolvedValue(null)
    bindAppSpy = spyOn(
      providerReposQueries,
      "bindGitHubInstallationApp"
    ).mockResolvedValue(undefined)
  })

  afterEach(() => {
    listReposSpy.mockRestore()
    listInstallationsSpy.mockRestore()
    replaceSnapshotSpy.mockRestore()
    legacyBackfillSpy.mockRestore()
    ownerAppSpy.mockRestore()
    bindAppSpy.mockRestore()
  })

  it("publishes installation freshness and all pages as one snapshot", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const db = mockDb()

    await handleSyncProviderRepos(db as never, {
      provider: "github",
      installationId: "999",
    })

    expect(listReposSpy).toHaveBeenCalledTimes(2)
    expect(replaceSnapshotSpy).toHaveBeenCalledTimes(1)
    expect(legacyBackfillSpy).toHaveBeenCalledWith(db, "999")

    const [, installation, rows] = replaceSnapshotSpy.mock.calls[0] as [
      unknown,
      { id: string; account_login: string },
      unknown[],
    ]
    expect(installation.id).toBe("github:999")
    expect(installation.account_login).toBe("org")
    expect(rows).toHaveLength(3)
  })

  it("binds a webhook-less installation to its App before listing repos", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const db = mockDb()
    const order: string[] = []
    bindAppSpy.mockImplementation(async () => {
      order.push("bind")
    })
    const listRepos = listReposSpy.getMockImplementation()
    listReposSpy.mockImplementation(async (...args: unknown[]) => {
      order.push("listRepos")
      return listRepos!(...args)
    })

    await handleSyncProviderRepos(db as never, {
      provider: "github",
      installationId: "999",
    })

    expect(bindAppSpy).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        external_id: "999",
        github_app_id: "singleton",
      })
    )
    expect(order[0]).toBe("bind")
  })

  it("keeps the previous cache when a GitHub page fails", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const db = mockDb()

    listReposSpy.mockRejectedValue(new Error("GitHub API down"))

    await expect(
      handleSyncProviderRepos(db as never, {
        provider: "github",
        installationId: "999",
      })
    ).rejects.toThrow("GitHub API down")

    expect(replaceSnapshotSpy).not.toHaveBeenCalled()
    expect(legacyBackfillSpy).not.toHaveBeenCalled()
  })

  it("does not publish freshness or repos when a later GitHub page fails", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const db = mockDb()
    listReposSpy
      .mockResolvedValueOnce({
        repos: [
          {
            id: 1,
            fullName: "org/repo-a",
            description: null,
            defaultBranch: "main",
            private: false,
            cloneUrl: "",
          },
        ],
        hasMore: true,
      })
      .mockRejectedValueOnce(new Error("GitHub page 2 unavailable"))

    await expect(
      handleSyncProviderRepos(db as never, {
        provider: "github",
        installationId: "999",
      })
    ).rejects.toThrow("GitHub page 2 unavailable")

    expect(replaceSnapshotSpy).not.toHaveBeenCalled()
    expect(legacyBackfillSpy).not.toHaveBeenCalled()
  })

  it("rejects an unclaimable GitHub credential (missing trust source)", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const { ghProvider } = await import("../../routes/github")
    const listReposSpy = spyOn(ghProvider, "listRepos")
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")

    const db = mockDb({
      updateRow: {
        id: "github:999",
        last_sync_source: null,
      },
    })

    await expect(
      handleSyncProviderRepos(db as never, {
        provider: "github",
        installationId: "999",
      })
    ).rejects.toThrow("not claimable")

    expect(listReposSpy).not.toHaveBeenCalled()
    expect(auditUnauthorizedSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GitLab per-user
// ---------------------------------------------------------------------------

describe("handleSyncProviderRepos — GitLab per-user", () => {
  it("converts GitLab repos correctly", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")

    // Mock getGitLabConfig
    const getGitLabConfigSpy = spyOn(
      providerReposQueries,
      "getGitLabConfig"
    ).mockResolvedValue({
      id: "singleton",
      instance_url: "https://gitlab.example.com",
      client_id: "cid",
      client_secret_enc: Buffer.from("enc"),
      client_secret_nonce: Buffer.from("nonce"),
      webhook_secret_enc: Buffer.from("wenc"),
      webhook_secret_nonce: Buffer.from("wnonce"),
    } as never)

    // Mock decryptField
    const appCredMod = await import("../../github/app-credentials")
    const decryptSpy = spyOn(appCredMod, "decryptField").mockResolvedValue(
      "fake-token"
    )

    // Mock upsertInstallation
    const upsertInstSpy = spyOn(
      providerReposQueries,
      "upsertInstallation"
    ).mockResolvedValue(undefined)

    // Mock the atomic installation + repository cache publication.
    const replaceSpy = spyOn(
      providerReposQueries,
      "replaceInstallationSnapshot"
    ).mockResolvedValue(undefined)

    // Mock GitLabProvider.listRepos
    const { GitLabProvider } = await import("../../gitlab/client")
    const listReposSpy = spyOn(
      GitLabProvider.prototype,
      "listRepos"
    ).mockResolvedValue({
      repos: [
        {
          id: 42,
          fullName: "group/project",
          description: "A project",
          defaultBranch: "main",
          private: false,
          cloneUrl: "https://gitlab.example.com/group/project.git",
        },
      ],
      hasMore: false,
    })

    const db = mockDb({
      gitlabTokenRows: [
        {
          user_id: "user-1",
          access_token_enc: Buffer.from("enc"),
          access_token_nonce: Buffer.from("nonce"),
          refresh_token_enc: null,
          refresh_token_nonce: null,
          expires_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    })

    await handleSyncProviderRepos(db as never, {
      provider: "gitlab",
      userId: "user-1",
    })

    expect(listReposSpy).toHaveBeenCalled()
    expect(replaceSpy).toHaveBeenCalledTimes(1)

    const [, installation, rows] = replaceSpy.mock.calls[0] as [
      unknown,
      { id: string },
      { id: string; full_name: string; provider: string }[],
    ]
    expect(installation.id).toBe("gitlab:user:user-1")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe("gitlab:42")
    expect(rows[0]?.full_name).toBe("group/project")
    expect(rows[0]?.provider).toBe("gitlab")

    getGitLabConfigSpy.mockRestore()
    decryptSpy.mockRestore()
    upsertInstSpy.mockRestore()
    replaceSpy.mockRestore()
    listReposSpy.mockRestore()
  })

  it("keeps the previous cache when a later GitLab page fails", async () => {
    const { handleSyncProviderRepos } = await import("./sync-provider-repos")
    const getGitLabConfigSpy = spyOn(
      providerReposQueries,
      "getGitLabConfig"
    ).mockResolvedValue({
      id: "singleton",
      instance_url: "https://gitlab.example.com",
      client_id: "cid",
      client_secret_enc: Buffer.from("enc"),
      client_secret_nonce: Buffer.from("nonce"),
      webhook_secret_enc: Buffer.from("wenc"),
      webhook_secret_nonce: Buffer.from("wnonce"),
    } as never)
    const appCredMod = await import("../../github/app-credentials")
    const decryptSpy = spyOn(appCredMod, "decryptField").mockResolvedValue(
      "fake-token"
    )
    const upsertInstSpy = spyOn(
      providerReposQueries,
      "upsertInstallation"
    ).mockResolvedValue(undefined)
    const replaceSpy = spyOn(
      providerReposQueries,
      "replaceInstallationSnapshot"
    ).mockResolvedValue(undefined)
    const { GitLabProvider } = await import("../../gitlab/client")
    const listReposSpy = spyOn(GitLabProvider.prototype, "listRepos")
      .mockResolvedValueOnce({
        repos: [
          {
            id: 42,
            fullName: "group/project",
            description: null,
            defaultBranch: "main",
            private: true,
            cloneUrl: "https://gitlab.example.com/group/project.git",
          },
        ],
        hasMore: true,
      })
      .mockRejectedValueOnce(new Error("GitLab page 2 unavailable"))
    const db = mockDb({
      gitlabTokenRows: [
        {
          user_id: "user-1",
          access_token_enc: Buffer.from("enc"),
          access_token_nonce: Buffer.from("nonce"),
          refresh_token_enc: null,
          refresh_token_nonce: null,
          expires_at: null,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    })

    await expect(
      handleSyncProviderRepos(db as never, {
        provider: "gitlab",
        userId: "user-1",
      })
    ).rejects.toThrow("GitLab page 2 unavailable")
    expect(replaceSpy).not.toHaveBeenCalled()
    expect(upsertInstSpy).not.toHaveBeenCalled()

    getGitLabConfigSpy.mockRestore()
    decryptSpy.mockRestore()
    upsertInstSpy.mockRestore()
    replaceSpy.mockRestore()
    listReposSpy.mockRestore()
  })
})
