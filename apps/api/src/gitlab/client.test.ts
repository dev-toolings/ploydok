// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { GitLabProvider } from "./client"

type FetchFn = typeof globalThis.fetch
const originalFetch: FetchFn = globalThis.fetch

describe("GitLabProvider", () => {
  beforeEach(() => {
    /* per-test mock below */
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("listRepos maps path_with_namespace → fullName and uses x-next-page for pagination", async () => {
    const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain("/api/v4/projects")
      expect(url).toContain("membership=true")
      expect(url).toContain("per_page=30")
      expect(url).toContain("page=1")
      expect(url).toContain("search=foo")
      expect((init?.headers as Record<string, string>)?.Authorization).toBe(
        "Bearer tok"
      )
      return new Response(
        JSON.stringify([
          {
            id: 42,
            path_with_namespace: "acme/project-x",
            description: "Foo",
            visibility: "private",
            default_branch: "main",
            http_url_to_repo: "https://gitlab.com/acme/project-x.git",
          },
        ]),
        { status: 200, headers: { "x-next-page": "2" } }
      )
    })
    globalThis.fetch = fetchMock as unknown as FetchFn

    const provider = new GitLabProvider("https://gitlab.com")
    const res = await provider.listRepos("tok", { search: "foo" })
    expect(res.repos).toHaveLength(1)
    expect(res.repos[0]!.fullName).toBe("acme/project-x")
    expect(res.repos[0]!.private).toBe(true)
    expect(res.repos[0]!.defaultBranch).toBe("main")
    expect(res.hasMore).toBe(true)
  })

  it("listBranches encodes the project path and maps commit.id → commitSha", async () => {
    const fetchMock = mock(async (input: string | URL) => {
      const url = String(input)
      expect(url).toContain(
        "/api/v4/projects/acme%2Fproject-x/repository/branches"
      )
      return new Response(
        JSON.stringify([{ name: "main", commit: { id: "abc123" } }]),
        { status: 200 }
      )
    })
    globalThis.fetch = fetchMock as unknown as FetchFn

    const provider = new GitLabProvider("https://gitlab.com")
    const branches = await provider.listBranches("tok", "acme/project-x")
    expect(branches).toEqual([{ name: "main", commitSha: "abc123" }])
  })

  it("paginates branches and forwards server-side search", async () => {
    const fetchMock = mock(async (input: string | URL) => {
      const url = new URL(String(input))
      expect(url.searchParams.get("search")).toBe("release")
      const page = url.searchParams.get("page")
      return new Response(
        JSON.stringify([
          {
            name: page === "1" ? "release/one" : "release/two",
            commit: { id: page === "1" ? "one" : "two" },
          },
        ]),
        {
          status: 200,
          headers: page === "1" ? { "x-next-page": "2" } : {},
        }
      )
    })
    globalThis.fetch = fetchMock as unknown as FetchFn

    const provider = new GitLabProvider("https://gitlab.com")
    const branches = await provider.listBranches("tok", "acme/project-x", {
      search: "release",
    })
    expect(branches.map((branch) => branch.name)).toEqual([
      "release/one",
      "release/two",
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("cloneUrlWithToken injects oauth2:<token> in the host URL", () => {
    const provider = new GitLabProvider("https://gitlab.example.com")
    const url = provider.cloneUrlWithToken("acme/project-x", "secret-token")
    expect(url).toBe(
      "https://oauth2:secret-token@gitlab.example.com/acme/project-x.git"
    )
  })

  it("preserves a self-hosted GitLab protocol, port and base path", () => {
    const provider = new GitLabProvider("http://gitlab.internal:8080/scm")
    const url = provider.cloneUrlWithToken("acme/project-x", "secret-token")
    expect(url).toBe(
      "http://oauth2:secret-token@gitlab.internal:8080/scm/acme/project-x.git"
    )
  })

  it("uses the canonical HTTP clone path returned by GitLab", () => {
    const provider = new GitLabProvider("https://gitlab.example.com/gitlab")
    const url = provider.cloneUrlWithToken(
      "acme/project-x",
      "secret-token",
      "https://gitlab.example.com/gitlab/acme/project-x.git"
    )
    expect(url).toBe(
      "https://oauth2:secret-token@gitlab.example.com/gitlab/acme/project-x.git"
    )
  })

  it("refuses to send the OAuth token to a foreign clone origin", () => {
    const provider = new GitLabProvider("https://gitlab.example.com")
    expect(() =>
      provider.cloneUrlWithToken(
        "acme/project-x",
        "secret-token",
        "https://evil.example/project-x.git"
      )
    ).toThrow(/does not match/)
  })

  it("getRepo returns 404 on not found", async () => {
    const fetchMock = mock(async () => new Response("{}", { status: 404 }))
    globalThis.fetch = fetchMock as unknown as FetchFn

    const provider = new GitLabProvider("https://gitlab.com")
    await expect(provider.getRepo("tok", "acme/missing")).rejects.toThrow(
      /not found/
    )
  })
})

describe("GitLab repository discovery", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  it("reads every tree page and excludes symlinks", async () => {
    let page = 0
    globalThis.fetch = mock(async (input: string | URL) => {
      page++
      const url = new URL(String(input))
      expect(url.pathname).toContain("acme%2Frepo/repository/tree")
      expect(url.searchParams.get("ref")).toBe("feature/new")
      expect(url.searchParams.get("page")).toBe(String(page))
      return new Response(
        JSON.stringify(
          page === 1
            ? [{ path: "services/a/go.mod", type: "blob", mode: "100644" }]
            : [
                { path: "services/b/Cargo.toml", type: "blob", mode: "100644" },
                { path: "link/package.json", type: "blob", mode: "120000" },
              ]
        ),
        { headers: { "x-next-page": page === 1 ? "2" : "" } }
      )
    }) as unknown as FetchFn
    expect(
      await new GitLabProvider("https://gitlab.com").listFiles(
        "tok",
        "acme/repo",
        "feature/new"
      )
    ).toEqual(["services/a/go.mod", "services/b/Cargo.toml"])
    expect(page).toBe(2)
  })
})
