// SPDX-License-Identifier: AGPL-3.0-only
import {
  GitBranchSchema,
  GitRepoSchema,
  ManifestTooLargeError,
} from "@ploydok/shared"
import type {
  CommitStatusInput,
  GitBranch,
  GitProvider,
  GitRepo,
  ParsedPushEvent,
  WebhookVerifyInput,
} from "@ploydok/shared"
import { verifyGitLabToken, type GitLabPushPayload } from "./webhook"

// ---------------------------------------------------------------------------
// GitLabProvider
//
// GitLab uses per-user OAuth2 Bearer tokens (not installation tokens).
// The caller (routes/gitlab.ts) decrypts the stored access token and passes
// it as `token` to every provider call.
// ---------------------------------------------------------------------------

export class GitLabProvider implements GitProvider {
  kind = "gitlab" as const

  constructor(private instanceUrl: string) {}

  private get apiBase(): string {
    return `${this.instanceUrl.replace(/\/+$/, "")}/api/v4`
  }

  private headers(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "User-Agent": "ploydok",
    }
  }

  async listRepos(
    token: string,
    opts: { page?: number; perPage?: number; search?: string } = {}
  ): Promise<{ repos: GitRepo[]; hasMore: boolean }> {
    const page = opts.page ?? 1
    const perPage = opts.perPage ?? 30
    const params = new URLSearchParams({
      membership: "true",
      simple: "true",
      order_by: "last_activity_at",
      per_page: String(perPage),
      page: String(page),
    })
    if (opts.search) params.set("search", opts.search)

    const url = `${this.apiBase}/projects?${params.toString()}`
    const res = await fetch(url, { headers: this.headers(token) })
    if (res.status !== 200) {
      throw new Error(`GitLab /projects returned ${res.status}`)
    }

    const body = (await res.json()) as Record<string, unknown>[]
    const repos = body.map(mapGitLabRepo)
    // GitLab returns X-Next-Page header; empty means no more pages.
    const next = res.headers.get("x-next-page")
    const hasMore = next !== null && next !== ""
    return { repos, hasMore }
  }

  async getRepo(token: string, fullName: string): Promise<GitRepo> {
    const encoded = encodeURIComponent(fullName)
    const res = await fetch(`${this.apiBase}/projects/${encoded}`, {
      headers: this.headers(token),
    })
    if (res.status === 404) throw new Error(`Repository not found: ${fullName}`)
    if (res.status !== 200)
      throw new Error(`GitLab /projects/${fullName} returned ${res.status}`)
    return mapGitLabRepo((await res.json()) as Record<string, unknown>)
  }

  async listBranches(
    token: string,
    fullName: string,
    opts: { search?: string } = {}
  ): Promise<GitBranch[]> {
    const encoded = encodeURIComponent(fullName)
    const branches: GitBranch[] = []
    const maxPages = 50
    for (let page = 1; page <= maxPages; page += 1) {
      const params = new URLSearchParams({
        per_page: "100",
        page: String(page),
      })
      if (opts.search) params.set("search", opts.search)
      const res = await fetch(
        `${this.apiBase}/projects/${encoded}/repository/branches?${params.toString()}`,
        { headers: this.headers(token) }
      )
      if (res.status !== 200) {
        throw new Error(
          `GitLab /projects/${fullName}/repository/branches returned ${res.status}`
        )
      }
      const body = (await res.json()) as Record<string, unknown>[]
      branches.push(...body.map(mapGitLabBranch))
      const nextPage = res.headers.get("x-next-page")
      if (!nextPage) return branches
    }
    throw new Error(
      `GitLab branch pagination exceeded ${maxPages} pages for ${fullName}`
    )
  }

  async fileExists(
    token: string,
    fullName: string,
    filePath: string,
    ref: string
  ): Promise<boolean> {
    const project = encodeURIComponent(fullName)
    const file = encodeURIComponent(filePath)
    const url = `${this.apiBase}/projects/${project}/repository/files/${file}?ref=${encodeURIComponent(ref)}`
    const res = await fetch(url, {
      method: "HEAD",
      headers: this.headers(token),
    })
    if (res.status === 200) return true
    if (res.status === 404) return false
    throw new Error(
      `GitLab /projects/${fullName}/repository/files/${filePath} returned ${res.status}`
    )
  }

  async readFile(
    token: string,
    fullName: string,
    filePath: string,
    ref: string
  ): Promise<string> {
    const project = encodeURIComponent(fullName)
    const file = encodeURIComponent(filePath)
    const url = `${this.apiBase}/projects/${project}/repository/files/${file}/raw?ref=${encodeURIComponent(ref)}`
    const res = await fetch(url, { headers: this.headers(token) })
    if (res.status !== 200) {
      throw new Error(
        `GitLab /projects/${fullName}/repository/files/${filePath}/raw returned ${res.status}`
      )
    }

    const contentLength = Number(res.headers.get("content-length") ?? "0")
    if (contentLength > 64 * 1024) {
      throw new ManifestTooLargeError(
        `GitLab /projects/${fullName}/repository/files/${filePath}/raw is too large`
      )
    }

    const content = await res.text()
    if (content.length > 64 * 1024) {
      throw new ManifestTooLargeError(
        `GitLab /projects/${fullName}/repository/files/${filePath}/raw is too large`
      )
    }
    return content
  }

  async listFiles(
    token: string,
    fullName: string,
    ref: string
  ): Promise<string[]> {
    const files: string[] = []
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({
        ref,
        recursive: "true",
        per_page: "100",
        page: String(page),
      })
      const res = await fetch(
        `${this.apiBase}/projects/${encodeURIComponent(fullName)}/repository/tree?${query}`,
        { headers: this.headers(token) }
      )
      if (res.status !== 200)
        throw new Error(`GitLab repository tree returned ${res.status}`)
      const entries = (await res.json()) as {
        path: string
        type: string
        mode?: string
      }[]
      files.push(
        ...entries
          .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
          .map((entry) => entry.path)
      )
      if (!res.headers.get("x-next-page")) return files
    }
    throw new Error(
      "Repository tree is incomplete; select a root directory manually"
    )
  }

  /** Build a clone URL embedding the OAuth token (for `git clone`). */
  cloneUrlWithToken(
    fullName: string,
    token: string,
    canonicalCloneUrl?: string
  ): string {
    const instance = new URL(this.instanceUrl)
    const clone = canonicalCloneUrl
      ? new URL(canonicalCloneUrl)
      : new URL(
          `${instance.pathname.replace(/\/+$/, "")}/${fullName.replace(/^\/+/, "")}.git`,
          instance
        )
    if (
      (clone.protocol !== "https:" && clone.protocol !== "http:") ||
      clone.origin !== instance.origin
    ) {
      throw new Error("GitLab clone URL does not match the configured instance")
    }
    clone.username = "oauth2"
    clone.password = token
    return clone.toString()
  }

  verifyWebhookSignature(input: WebhookVerifyInput): boolean {
    return verifyGitLabToken(
      input.headers["x-gitlab-token"] ?? null,
      input.secret
    )
  }

  parseWebhookPushEvent(
    event: string,
    payload: unknown
  ): ParsedPushEvent | null {
    if (event !== "Push Hook") return null
    const push = payload as GitLabPushPayload
    if (push.object_kind !== "push") return null
    return {
      provider: "gitlab",
      repoFullName: push.project.path_with_namespace,
      branch: push.ref.replace(/^refs\/heads\//, ""),
      commitSha: push.checkout_sha,
      commitMessage: push.commits?.[0]?.message ?? "",
      authRef: String(push.user_id),
    }
  }

  async postCommitStatus(input: CommitStatusInput): Promise<void> {
    const { owner, repo, sha, state, context, targetUrl, description, token } =
      input
    // GitLab uses path_with_namespace as project identifier
    const fullName = `${owner}/${repo}`
    const encoded = encodeURIComponent(fullName)

    // Map generic states to GitLab-specific states
    const gitlabState =
      state === "pending"
        ? "pending"
        : state === "success"
          ? "success"
          : "failed"

    const params = new URLSearchParams({ state: gitlabState, name: context })
    if (targetUrl) params.set("target_url", targetUrl)
    if (description) params.set("description", description)

    const url = `${this.apiBase}/projects/${encoded}/statuses/${sha}?${params.toString()}`
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(token),
    })

    if (!res.ok) {
      throw new Error(
        `GitLab commit status POST returned ${res.status} for ${sha}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapGitLabRepo(raw: Record<string, unknown>): GitRepo {
  return GitRepoSchema.parse({
    id: raw["id"],
    // GitLab `path_with_namespace` is the `group/project` identifier equivalent
    // to GitHub's `full_name`.
    fullName: raw["path_with_namespace"],
    description: (raw["description"] as string | null | undefined) ?? null,
    private: (raw["visibility"] as string | undefined) !== "public",
    defaultBranch: (raw["default_branch"] as string | undefined) ?? "main",
    cloneUrl: (raw["http_url_to_repo"] as string | undefined) ?? "",
  })
}

function mapGitLabBranch(raw: Record<string, unknown>): GitBranch {
  const commit = raw["commit"] as Record<string, unknown> | undefined
  return GitBranchSchema.parse({
    name: raw["name"],
    commitSha: (commit?.["id"] as string | undefined) ?? "",
  })
}
