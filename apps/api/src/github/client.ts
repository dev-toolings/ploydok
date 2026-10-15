// SPDX-License-Identifier: AGPL-3.0-only
import { GitBranchSchema, GitRepoSchema } from "@ploydok/shared";
import type {
  CommitStatusInput,
  GitBranch,
  GitProvider,
  GitRepo,
  ParsedPushEvent,
  WebhookVerifyInput,
} from "@ploydok/shared";
import type { GitHubCache } from "./cache";
import { getInstallationToken } from "./installation-tokens";
import { verifySignature, type PushPayload } from "./webhook";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GH_API = "https://api.github.com";
const GH_ACCEPT = "application/vnd.github+json";
const GH_API_VERSION = "2022-11-28";
const USER_AGENT = "ploydok";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: GH_ACCEPT,
    "X-GitHub-Api-Version": GH_API_VERSION,
    "User-Agent": USER_AGENT,
  };
}

/**
 * Map a raw GitHub API repo object to a `GitRepo`.
 */
function mapRepo(raw: Record<string, unknown>): GitRepo {
  return GitRepoSchema.parse({
    id: raw["id"],
    fullName: raw["full_name"],
    description: raw["description"] ?? null,
    private: raw["private"],
    defaultBranch: raw["default_branch"],
    cloneUrl: raw["clone_url"],
  });
}

/**
 * Map a raw GitHub branch object to a `GitBranch`.
 */
function mapBranch(raw: Record<string, unknown>): GitBranch {
  const commit = raw["commit"] as Record<string, unknown> | undefined;
  return GitBranchSchema.parse({
    name: raw["name"],
    commitSha: commit?.["sha"] ?? "",
  });
}

// ---------------------------------------------------------------------------
// Installation-token based fetcher
// ---------------------------------------------------------------------------

/**
 * Perform a GitHub API GET using an installation access token.
 * The token is obtained (and cached) via `getInstallationToken`.
 */
export async function fetchGitHub(
  installationId: string,
  path: string,
  cache?: GitHubCache,
): Promise<{ status: number; data: unknown }> {
  const token = await getInstallationToken(installationId);
  const url = path.startsWith("http") ? path : `${GH_API}${path}`;

  if (cache) {
    return cache.fetch(url, { headers: ghHeaders(token) });
  }

  const res = await fetch(url, { headers: ghHeaders(token) });
  const data = await res.json();
  return { status: res.status, data };
}

function encodeRepoPath(filePath: string): string {
  return filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

// ---------------------------------------------------------------------------
// GitHubProvider
// ---------------------------------------------------------------------------

export class GitHubProvider implements GitProvider {
  kind = "github" as const;

  constructor(private cache: GitHubCache) {}

  /**
   * List repos accessible to the given installation.
   * Uses /installation/repositories which returns repos the App is installed on.
   */
  async listRepos(
    installationId: string,
    opts: { page?: number; perPage?: number; search?: string } = {},
  ): Promise<{ repos: GitRepo[]; hasMore: boolean }> {
    const page = opts.page ?? 1;
    const perPage = opts.perPage ?? 30;
    const path = `/installation/repositories?sort=updated&page=${page}&per_page=${perPage}`;

    const { status, data } = await fetchGitHub(installationId, path, this.cache);

    if (status !== 200) {
      throw new Error(`GitHub /installation/repositories returned ${status}`);
    }

    const body = data as { repositories: Record<string, unknown>[] };
    let repos = (body.repositories ?? []).map(mapRepo);

    if (opts.search) {
      const q = opts.search.toLowerCase();
      repos = repos.filter(
        (r) =>
          r.fullName.toLowerCase().includes(q) ||
          (r.description?.toLowerCase().includes(q) ?? false),
      );
    }

    const rawCount = (body.repositories ?? []).length;
    const hasMore = rawCount >= perPage;

    return { repos, hasMore };
  }

  async getRepo(installationId: string, fullName: string): Promise<GitRepo> {
    const { status, data } = await fetchGitHub(
      installationId,
      `/repos/${fullName}`,
      this.cache,
    );

    if (status === 404) {
      throw new Error(`Repository not found: ${fullName}`);
    }
    if (status !== 200) {
      throw new Error(`GitHub /repos/${fullName} returned ${status}`);
    }

    return mapRepo(data as Record<string, unknown>);
  }

  async listBranches(installationId: string, fullName: string): Promise<GitBranch[]> {
    const { status, data } = await fetchGitHub(
      installationId,
      `/repos/${fullName}/branches?per_page=100`,
      this.cache,
    );

    if (status !== 200) {
      throw new Error(`GitHub /repos/${fullName}/branches returned ${status}`);
    }

    return (data as Record<string, unknown>[]).map(mapBranch);
  }

  async fileExists(
    installationId: string,
    fullName: string,
    filePath: string,
    ref: string,
  ): Promise<boolean> {
    const encodedPath = encodeRepoPath(filePath)
    const { status } = await fetchGitHub(
      installationId,
      `/repos/${fullName}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      this.cache,
    )
    if (status === 200) return true
    if (status === 404) return false
    throw new Error(`GitHub /repos/${fullName}/contents/${filePath} returned ${status}`)
  }

  async readFile(
    installationId: string,
    fullName: string,
    filePath: string,
    ref: string,
  ): Promise<string> {
    const encodedPath = encodeRepoPath(filePath)
    const { status, data } = await fetchGitHub(
      installationId,
      `/repos/${fullName}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      this.cache,
    )
    if (status !== 200) {
      throw new Error(`GitHub /repos/${fullName}/contents/${filePath} returned ${status}`)
    }

    const body = data as { type?: string; encoding?: string; content?: string; size?: number }
    if (body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
      throw new Error(`GitHub /repos/${fullName}/contents/${filePath} is not a base64 file`)
    }
    if ((body.size ?? 0) > 64 * 1024) {
      throw new Error(`GitHub /repos/${fullName}/contents/${filePath} is too large`)
    }
    return Buffer.from(body.content.replace(/\s/g, ""), "base64").toString("utf8")
  }

  async listFiles(
    installationId: string,
    fullName: string,
    ref: string
  ): Promise<string[]> {
    const { status, data } = await fetchGitHub(
      installationId,
      `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      this.cache
    )
    if (status !== 200)
      throw new Error(`GitHub repository tree returned ${status}`)
    const body = data as {
      truncated?: boolean
      tree: { path: string; type: string; mode?: string }[]
    }
    if (body.truncated)
      throw new Error(
        "Repository tree is incomplete; select a root directory manually"
      )
    return body.tree
      .filter((entry) => entry.type === "blob" && entry.mode !== "120000")
      .map((entry) => entry.path)
  }

  cloneUrlWithToken(fullName: string, token: string): string {
    return `https://x-access-token:${token}@github.com/${fullName}.git`;
  }

  verifyWebhookSignature(input: WebhookVerifyInput): boolean {
    return verifySignature(
      input.rawBody,
      input.headers["x-hub-signature-256"] ?? null,
      input.secret,
    );
  }

  parseWebhookPushEvent(event: string, payload: unknown): ParsedPushEvent | null {
    if (event !== "push") return null;
    const push = payload as PushPayload;
    if (!push.ref?.startsWith("refs/heads/") || !push.after) return null;
    return {
      provider: "github",
      repoFullName: push.repository.full_name,
      branch: push.ref.replace(/^refs\/heads\//, ""),
      commitSha: push.after,
      commitMessage: push.head_commit?.message ?? "",
      authRef: push.installation?.id != null ? String(push.installation.id) : "",
    };
  }

  async postCommitStatus(input: CommitStatusInput): Promise<void> {
    const { owner, repo, sha, state, context, targetUrl, description, token } = input;
    const url = `${GH_API}/repos/${owner}/${repo}/statuses/${sha}`;
    const body: Record<string, string> = { state, context };
    if (targetUrl) body["target_url"] = targetUrl;
    if (description) body["description"] = description;

    const res = await fetch(url, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // 422 = commit doesn't exist yet — no point retrying
    if (res.status === 422) return;
    if (!res.ok) {
      throw new Error(`GitHub commit status POST returned ${res.status} for ${sha}`);
    }
  }
}
