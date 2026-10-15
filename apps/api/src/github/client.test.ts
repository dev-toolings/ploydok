// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ManifestTooLargeError } from "@ploydok/shared";
import { GitHubCache } from "./cache";
import { GitHubProvider } from "./client";
import * as installationTokens from "./installation-tokens";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchLike = (url: string | Request | URL, init?: RequestInit) => Promise<Response>;

function makeFetch(fn: FetchLike): typeof fetch {
  return fn as unknown as typeof fetch;
}

function makeRepo(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    full_name: "owner/repo",
    description: "A test repo",
    private: false,
    default_branch: "main",
    clone_url: "https://github.com/owner/repo.git",
    ...overrides,
  };
}

function makeBranch(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha, url: "" }, protected: false };
}

function makeResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// Mock getInstallationToken to return a predictable token without DB/keyring
const FAKE_INSTALL_ID = "12345";
const FAKE_TOKEN = "ghs_fakeinstallationtoken";

// ---------------------------------------------------------------------------
// GitHubProvider.listRepos()
// ---------------------------------------------------------------------------

describe("GitHubProvider.listRepos()", () => {
  let cache: GitHubCache;
  let provider: GitHubProvider;

  beforeEach(() => {
    cache = new GitHubCache();
    provider = new GitHubProvider(cache);
    // Stub getInstallationToken so tests don't hit DB/GitHub
    spyOn(installationTokens, "getInstallationToken").mockResolvedValue(FAKE_TOKEN);
  });

  it("returns mapped repos from /installation/repositories", async () => {
    const repoBody = { repositories: [makeRepo()], total_count: 1 };
    using _spy = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () => makeResponse(repoBody)),
    );

    const { repos, hasMore } = await provider.listRepos(FAKE_INSTALL_ID);

    expect(repos).toHaveLength(1);
    expect(repos[0]!.fullName).toBe("owner/repo");
    expect(repos[0]!.defaultBranch).toBe("main");
    expect(repos[0]!.cloneUrl).toBe("https://github.com/owner/repo.git");
    expect(hasMore).toBe(false);
  });

  it("sets hasMore=true when count equals perPage", async () => {
    const fakeRepos = Array.from({ length: 5 }, (_, i) =>
      makeRepo({
        id: i,
        full_name: `owner/repo${i}`,
        clone_url: `https://github.com/owner/repo${i}.git`,
      }),
    );
    const repoBody = { repositories: fakeRepos, total_count: 10 };

    using _spy = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () => makeResponse(repoBody)),
    );

    const { repos, hasMore } = await provider.listRepos(FAKE_INSTALL_ID, {
      perPage: 5,
    });

    expect(repos).toHaveLength(5);
    expect(hasMore).toBe(true);
  });

  it("filters by search term on fullName", async () => {
    const rawRepos = [
      makeRepo({
        id: 1,
        full_name: "owner/awesome-app",
        clone_url: "https://github.com/owner/awesome-app.git",
      }),
      makeRepo({
        id: 2,
        full_name: "owner/boring-repo",
        clone_url: "https://github.com/owner/boring-repo.git",
      }),
    ];
    const repoBody = { repositories: rawRepos, total_count: 2 };

    using _spy = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () => makeResponse(repoBody)),
    );

    const { repos } = await provider.listRepos(FAKE_INSTALL_ID, {
      search: "awesome",
    });

    expect(repos).toHaveLength(1);
    expect(repos[0]!.fullName).toBe("owner/awesome-app");
  });

  it("sends Authorization: Bearer <token> header", async () => {
    let capturedHeaders: Record<string, string> = {};
    const repoBody = { repositories: [], total_count: 0 };

    using _spy = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async (_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return makeResponse(repoBody);
      }),
    );

    await provider.listRepos(FAKE_INSTALL_ID);

    expect(capturedHeaders["Authorization"]).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(capturedHeaders["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(capturedHeaders["User-Agent"]).toBe("ploydok");
  });
});

// ---------------------------------------------------------------------------
// GitHubProvider.listBranches()
// ---------------------------------------------------------------------------

describe("GitHubProvider.listBranches()", () => {
  let cache: GitHubCache;
  let provider: GitHubProvider;

  beforeEach(() => {
    cache = new GitHubCache();
    provider = new GitHubProvider(cache);
    spyOn(installationTokens, "getInstallationToken").mockResolvedValue(FAKE_TOKEN);
  });

  it("returns mapped branches", async () => {
    const branches = [makeBranch("main", "abc123"), makeBranch("dev", "def456")];

    using _spy = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () => makeResponse(branches)),
    );

    const result = await provider.listBranches(FAKE_INSTALL_ID, "owner/repo");

    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe("main");
    expect(result[0]!.commitSha).toBe("abc123");
    expect(result[1]!.name).toBe("dev");
  });
});

// ---------------------------------------------------------------------------
// GitHubProvider.getRepo()
// ---------------------------------------------------------------------------

describe("GitHubProvider.getRepo()", () => {
  let cache: GitHubCache;
  let provider: GitHubProvider;

  beforeEach(() => {
    cache = new GitHubCache();
    provider = new GitHubProvider(cache);
    spyOn(installationTokens, "getInstallationToken").mockResolvedValue(FAKE_TOKEN);
  });

  it("returns the repo on 200", async () => {
    using _spy = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () =>
        makeResponse(
          makeRepo({
            full_name: "foo/bar",
            clone_url: "https://github.com/foo/bar.git",
          }),
        ),
      ),
    );

    const repo = await provider.getRepo(FAKE_INSTALL_ID, "foo/bar");

    expect(repo.fullName).toBe("foo/bar");
  });

  it("throws on 404", async () => {
    using _spy = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () => makeResponse({ message: "Not Found" }, 404)),
    );

    await expect(
      provider.getRepo(FAKE_INSTALL_ID, "foo/missing"),
    ).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// GitHubProvider.cloneUrlWithToken()
// ---------------------------------------------------------------------------

describe("GitHubProvider.cloneUrlWithToken()", () => {
  it("returns url with embedded token", () => {
    const cache = new GitHubCache();
    const provider = new GitHubProvider(cache);
    const url = provider.cloneUrlWithToken("owner/repo", "ghs_TOKEN");
    expect(url).toBe(
      "https://x-access-token:ghs_TOKEN@github.com/owner/repo.git",
    );
  });
});

describe("GitHub repository discovery", () => {
  it("encodes refs and rejects truncated trees rather than selecting from partial results", async () => {
    using _token = spyOn(
      installationTokens,
      "getInstallationToken"
    ).mockResolvedValue(FAKE_TOKEN)
    const provider = new GitHubProvider(new GitHubCache())
    using _fetch = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async (url) => {
        expect(String(url)).toContain("/git/trees/feature%2Fnew?recursive=1")
        return makeResponse({
          truncated: true,
          tree: [{ path: "api/go.mod", type: "blob" }],
        })
      })
    )
    await expect(
      provider.listFiles(FAKE_INSTALL_ID, "owner/repo", "feature/new")
    ).rejects.toThrow("incomplete")
  })

  it("returns files only, excluding symlinks and submodules", async () => {
    using _token = spyOn(
      installationTokens,
      "getInstallationToken"
    ).mockResolvedValue(FAKE_TOKEN)
    using _fetch = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () =>
        makeResponse({
          tree: [
            { path: "custom/service/go.mod", type: "blob", mode: "100644" },
            { path: "linked/package.json", type: "blob", mode: "120000" },
            { path: "module", type: "commit" },
          ],
        })
      )
    )
    expect(
      await new GitHubProvider(new GitHubCache()).listFiles(
        FAKE_INSTALL_ID,
        "owner/repo",
        "main"
      )
    ).toEqual(["custom/service/go.mod"])
  })

  it("reports a >64 KiB file as too large before checking the encoding", async () => {
    using _token = spyOn(
      installationTokens,
      "getInstallationToken"
    ).mockResolvedValue(FAKE_TOKEN)
    using _fetch = spyOn(globalThis, "fetch").mockImplementation(
      makeFetch(async () =>
        makeResponse({ type: "file", encoding: "none", content: "", size: 2_000_000 })
      )
    )
    await expect(
      new GitHubProvider(new GitHubCache()).readFile(
        FAKE_INSTALL_ID,
        "owner/repo",
        "composer.lock",
        "main"
      )
    ).rejects.toBeInstanceOf(ManifestTooLargeError)
  })
})
