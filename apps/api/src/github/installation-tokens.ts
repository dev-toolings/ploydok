// SPDX-License-Identifier: AGPL-3.0-only
import { signAppJwt } from "./jwt";
import { decryptAppPrivateKey } from "./app-credentials";
import { getGitHubAppConfigFingerprint } from "./config-fingerprint";
import {
  getGitHubAppConfigForInstallation,
  listGitHubAppConfigs,
  setGitHubAppOwner,
  type GitHubAppRow,
} from "@ploydok/db/queries";
import { createDb } from "@ploydok/db";
import { env } from "../env";
import { childLogger } from "../logger";

const log = childLogger("github.installation-tokens");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
  configFingerprint: string;
}

// ---------------------------------------------------------------------------
// In-memory token cache (per-process, 50-minute window)
// GitHub installation tokens expire after 1 hour; we cache for 50 min.
// ---------------------------------------------------------------------------

const TOKEN_CACHE = new Map<string, CachedToken>();
const CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes

// ---------------------------------------------------------------------------
// DB singleton
// ---------------------------------------------------------------------------

const db = createDb(env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a valid GitHub installation access token for the given installation.
 * Tokens are cached in-process for 50 minutes; GitHub grants 1 hour.
 */
export async function getInstallationToken(installationId: string): Promise<string> {
  // Always validate the current DB config before consulting the process-local
  // cache. This is the cross-process revocation fence after a local App reset.
  const config = await getGitHubAppConfigForInstallation(db, installationId);
  if (!config) {
    TOKEN_CACHE.delete(installationId);
    throw new Error("No GitHub App owns this installation: run the App manifest flow first");
  }
  const configFingerprint = getGitHubAppConfigFingerprint(config);

  const cached = TOKEN_CACHE.get(installationId);
  if (
    cached &&
    cached.configFingerprint === configFingerprint &&
    Date.now() < cached.expiresAt
  ) {
    return cached.token;
  }
  TOKEN_CACHE.delete(installationId);

  // Decrypt the PEM private key
  const pem = await decryptAppPrivateKey(config);

  // Sign a short-lived JWT for the App itself
  const jwt = signAppJwt(pem, config.app_id);

  // Exchange for an installation access token
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "ploydok",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub installation token request failed: ${res.status} ${body}`,
    );
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  const token = data.token;

  // The App may have been reset or re-imported while GitHub was issuing the
  // token. Re-read the DB before making that bearer observable or cacheable.
  const currentConfig = await getGitHubAppConfigForInstallation(db, installationId);
  if (
    !currentConfig ||
    getGitHubAppConfigFingerprint(currentConfig) !== configFingerprint
  ) {
    TOKEN_CACHE.delete(installationId);
    throw new Error("GitHub App configuration changed while issuing a token");
  }

  // Cache with 50-minute TTL regardless of actual expiry
  TOKEN_CACHE.set(installationId, {
    token,
    expiresAt: Date.now() + CACHE_TTL_MS,
    configFingerprint,
  });

  return token;
}

/**
 * Evict a specific installation token from the cache (e.g. on revocation).
 */
export function evictInstallationToken(installationId: string): void {
  TOKEN_CACHE.delete(installationId);
}

/** Evicts all process-local GitHub installation tokens after an App reset. */
export function evictAllInstallationTokens(): void {
  TOKEN_CACHE.clear();
}

export interface AppInstallation {
  id: number;
  /** Ploydok row id of the GitHub App that owns this installation. */
  githubAppId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
  htmlUrl: string;
  avatarUrl: string;
}

async function appJwt(config: GitHubAppRow): Promise<string> {
  const pem = await decryptAppPrivateKey(config);
  return signAppJwt(pem, config.app_id);
}

/**
 * Fills the owner of Apps registered before it was recorded, from GitHub's
 * `GET /app`. Best effort: an App GitHub cannot describe keeps a null owner.
 */
export async function fillMissingGitHubAppOwners(
  configs: GitHubAppRow[],
): Promise<GitHubAppRow[]> {
  return Promise.all(
    configs.map(async (config) => {
      if (config.owner_login) return config;
      try {
        const res = await fetch("https://api.github.com/app", {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${await appJwt(config)}`,
            "User-Agent": "ploydok",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`GitHub /app returned ${res.status}`);
        const body = (await res.json()) as {
          owner?: { login?: unknown; type?: unknown } | null;
        };
        const login = body.owner?.login;
        const type = body.owner?.type;
        if (typeof login !== "string" || typeof type !== "string") return config;
        await setGitHubAppOwner(db, config.id, { login, type });
        return { ...config, owner_login: login, owner_type: type };
      } catch (err) {
        log.warn({ err, githubAppId: config.id }, "github app owner lookup failed");
        return config;
      }
    }),
  );
}

/**
 * List the installations of one GitHub App, or of every registered App when
 * none is given. Authenticates with a short-lived App JWT per App.
 */
export async function listAppInstallations(
  config?: GitHubAppRow,
): Promise<AppInstallation[]> {
  const configs = config ? [config] : await listGitHubAppConfigs(db);
  if (configs.length === 0) {
    throw new Error("GitHub App not configured");
  }
  const lists = await Promise.all(configs.map(listInstallationsForApp));
  return lists.flat();
}

async function listInstallationsForApp(
  config: GitHubAppRow,
): Promise<AppInstallation[]> {
  const jwt = await appJwt(config);

  const res = await fetch("https://api.github.com/app/installations?per_page=100", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "ploydok",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub /app/installations returned ${res.status}: ${body}`);
  }

  const data = (await res.json()) as Array<{
    id: number;
    account: { login?: string; type?: string; html_url?: string; avatar_url?: string } | null;
    repository_selection?: "all" | "selected";
    suspended_at?: string | null;
    html_url?: string;
  }>;

  return data.map((i) => ({
    id: i.id,
    githubAppId: config.id,
    accountLogin: i.account?.login ?? "",
    accountType: i.account?.type ?? "",
    repositorySelection: i.repository_selection ?? "selected",
    suspendedAt: i.suspended_at ?? null,
    htmlUrl: i.html_url ?? i.account?.html_url ?? "",
    avatarUrl: i.account?.avatar_url ?? "",
  }));
}

/**
 * Delete/revoke an installation by id with the App that owns it. The App loses
 * access to all repos granted by that installation. The owner can re-install
 * anytime.
 */
export async function revokeAppInstallation(
  installationId: number,
  config?: GitHubAppRow,
): Promise<void> {
  const owner =
    config ?? (await getGitHubAppConfigForInstallation(db, String(installationId)));
  if (!owner) {
    throw new Error("No GitHub App owns this installation");
  }

  const jwt = await appJwt(owner);

  const res = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    method: "DELETE",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "ploydok",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub DELETE /app/installations/${installationId} returned ${res.status}: ${body}`);
  }

  evictInstallationToken(String(installationId));
}
