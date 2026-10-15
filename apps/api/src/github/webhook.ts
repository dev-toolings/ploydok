// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Db } from "@ploydok/db";
import {
  deleteInstallation as deleteInstallationDefault,
  deleteGitHubInstallationAndUsers as deleteGitHubInstallationAndUsersDefault,
  deleteRepos as deleteReposDefault,
  upsertInstallation as upsertInstallationDefault,
  upsertRepos as upsertReposDefault,
} from "@ploydok/db/queries";
import { childLogger } from "../logger";
import { handlePush } from "./webhook-handlers/push";
import {
  handlePullRequest,
  type PullRequestPayload,
} from "../webhook-handlers/pull-request";
import { decryptField } from "./app-credentials";

const log = childLogger("webhook");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PushPayload {
  ref: string; // "refs/heads/main"
  after: string; // commit SHA
  repository: {
    full_name: string;
  };
  installation?: {
    id: number;
  };
  head_commit?: {
    message: string;
  } | null;
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
}

export interface WebhookExtras {
  payloadHash?: string;
  rawBodyBuffer?: Buffer;
  /** Ploydok row id of the GitHub App whose secret signed the delivery. */
  githubAppId?: string;
}

export type EnqueueFn = (payload: {
  provider: "github";
  installationId?: string;
}) => Promise<void>;

export interface WebhookDeps {
  enqueue?: EnqueueFn;
  queries?: {
    upsertInstallation?: typeof upsertInstallationDefault;
    deleteInstallation?: typeof deleteInstallationDefault;
    deleteGitHubInstallationAndUsers?: typeof deleteGitHubInstallationAndUsersDefault;
    upsertRepos?: typeof upsertReposDefault;
    deleteRepos?: typeof deleteReposDefault;
  };
}

// ---------------------------------------------------------------------------
// Encryption helpers for per-app webhook secrets (nonce || enc layout)
// ---------------------------------------------------------------------------

// Per-app secrets are stored as nonce (12 bytes) || AES-GCM ciphertext in bytea.
async function decryptWebhookSecret(blob: Buffer): Promise<string> {
  const nonce = blob.subarray(0, 12);
  const enc = blob.subarray(12);
  return decryptField(enc, nonce);
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verifies a GitHub webhook signature (X-Hub-Signature-256 header).
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifySignature(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length must match before timingSafeEqual
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Webhook payload schemas (installation + installation_repositories)
// ---------------------------------------------------------------------------

const GhInstallationAccountSchema = z.object({
  login: z.string(),
  type: z.string(),
  avatar_url: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
});

const GhInstallationSchema = z.object({
  id: z.number(),
  account: GhInstallationAccountSchema,
  repository_selection: z.string().optional(),
  suspended_at: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  repositories_url: z.string().nullable().optional(),
});

const GhInstallationEventSchema = z.object({
  action: z.string(),
  installation: GhInstallationSchema,
  repositories: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        full_name: z.string(),
        private: z.boolean(),
      }),
    )
    .optional(),
});

const GhInstallationRepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

const GhInstallationRepositoriesEventSchema = z.object({
  action: z.string(),
  installation: GhInstallationSchema,
  repositories_added: z.array(GhInstallationRepoSchema).optional(),
  repositories_removed: z.array(GhInstallationRepoSchema).optional(),
});

// ---------------------------------------------------------------------------
// Installation event helpers
// ---------------------------------------------------------------------------

function makeInstallationId(ghId: number): string {
  return `github:${ghId}`;
}

function makeRepoId(ghId: number): string {
  return `github:${ghId}`;
}

async function handleInstallationEvent(
  db: Db,
  payload: unknown,
  deliveryId: string,
  enqueue: EnqueueFn,
  queries: Required<NonNullable<WebhookDeps["queries"]>>,
  githubAppId?: string,
): Promise<void> {
  const parsed = GhInstallationEventSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ deliveryId, issues: parsed.error.issues }, "installation: invalid payload shape");
    return;
  }

  const { action, installation } = parsed.data;
  const externalInstallationId = String(installation.id);
  const installationId = makeInstallationId(installation.id);
  const now = new Date();

  log.info({ event: "installation", action, deliveryId, installationId }, "installation event");

  switch (action) {
    case "created": {
      await queries.upsertInstallation(db, {
        id: installationId,
        github_app_id: githubAppId,
        provider: "github",
        external_id: String(installation.id),
        account_login: installation.account.login,
        account_type: installation.account.type,
        repository_selection: installation.repository_selection ?? null,
        suspended_at: null,
        html_url: installation.html_url ?? null,
        avatar_url: installation.account.avatar_url ?? null,
        repository_count: null,
        last_synced_at: now,
        created_at: now,
      });
      await enqueue({ provider: "github", installationId: externalInstallationId });
      break;
    }

    case "deleted": {
      await queries.deleteGitHubInstallationAndUsers(db, installationId);
      break;
    }

    case "suspend": {
      await queries.upsertInstallation(db, {
        id: installationId,
        github_app_id: githubAppId,
        provider: "github",
        external_id: String(installation.id),
        account_login: installation.account.login,
        account_type: installation.account.type,
        repository_selection: installation.repository_selection ?? null,
        suspended_at: installation.suspended_at ? new Date(installation.suspended_at) : now,
        html_url: installation.html_url ?? null,
        avatar_url: installation.account.avatar_url ?? null,
        repository_count: null,
        last_synced_at: now,
        created_at: now,
      });
      break;
    }

    case "unsuspend": {
      await queries.upsertInstallation(db, {
        id: installationId,
        github_app_id: githubAppId,
        provider: "github",
        external_id: String(installation.id),
        account_login: installation.account.login,
        account_type: installation.account.type,
        repository_selection: installation.repository_selection ?? null,
        suspended_at: null,
        html_url: installation.html_url ?? null,
        avatar_url: installation.account.avatar_url ?? null,
        repository_count: null,
        last_synced_at: now,
        created_at: now,
      });
      break;
    }

    default:
      log.info({ event: "installation", action, deliveryId }, "unknown installation action — no-op");
  }
}

async function handleInstallationRepositoriesEvent(
  db: Db,
  payload: unknown,
  deliveryId: string,
  enqueue: EnqueueFn,
  queries: Required<NonNullable<WebhookDeps["queries"]>>,
): Promise<void> {
  const parsed = GhInstallationRepositoriesEventSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn(
      { deliveryId, issues: parsed.error.issues },
      "installation_repositories: invalid payload shape",
    );
    return;
  }

  const { action, installation, repositories_added, repositories_removed } = parsed.data;
  const externalInstallationId = String(installation.id);
  const installationId = makeInstallationId(installation.id);
  const now = new Date();

  log.info(
    {
      event: "installation_repositories",
      action,
      deliveryId,
      installationId,
      added: repositories_added?.length ?? 0,
      removed: repositories_removed?.length ?? 0,
    },
    "installation_repositories event",
  );

  switch (action) {
    case "added": {
      const repos = (repositories_added ?? []).map((r) => ({
        id: makeRepoId(r.id),
        installation_id: installationId,
        provider: "github" as const,
        full_name: r.full_name,
        name: r.name,
        description: null,
        default_branch: null,
        private: r.private,
        html_url: null,
        pushed_at: null,
        updated_at: null,
        last_synced_at: now,
      }));
      await queries.upsertRepos(db, repos);
      // Enqueue to fill missing fields (description, default_branch, etc.)
      await enqueue({ provider: "github", installationId: externalInstallationId });
      break;
    }

    case "removed": {
      const ids = (repositories_removed ?? []).map((r) => makeRepoId(r.id));
      await queries.deleteRepos(db, installationId, ids);
      log.info({ deliveryId, installationId, count: ids.length }, "repos removed from installation");
      break;
    }

    default:
      log.info(
        { event: "installation_repositories", action, deliveryId },
        "unknown installation_repositories action — no-op",
      );
  }
}

// PerAppSecretBlobs carries the current and (optional) old encrypted secret for dual-accept.
export interface PerAppSecretBlobs {
  current: Buffer;
  old?: Buffer;
  oldExpiresAt?: Date | null;
}

/**
 * Verifies a GitHub webhook signature using per-app secrets with dual-accept.
 *
 * Strategy:
 *  - If perApp is provided: try current secret first, then old secret (if present and not expired).
 *    If only the old secret passes, log an info event so operators know the provider still uses
 *    the previous secret.
 *  - If perApp is not provided: fall through to the global GitHub App secret (current behavior).
 *
 * Returns { valid: boolean, usedOldSecret: boolean }.
 */
export async function verifySignatureWithFallback(
  body: string,
  signature: string | null,
  globalSecret: string,
  perApp?: PerAppSecretBlobs,
): Promise<{ valid: boolean; usedOldSecret: boolean }> {
  if (!perApp) {
    return { valid: verifySignature(body, signature, globalSecret), usedOldSecret: false };
  }

  // Try current per-app secret
  try {
    const currentPlain = await decryptWebhookSecret(perApp.current);
    if (verifySignature(body, signature, currentPlain)) {
      return { valid: true, usedOldSecret: false };
    }
  } catch (err) {
    log.warn({ err }, "failed to decrypt current per-app webhook secret");
  }

  // Try old per-app secret (if present and not expired)
  if (perApp.old) {
    const now = new Date();
    if (!perApp.oldExpiresAt || perApp.oldExpiresAt > now) {
      try {
        const oldPlain = await decryptWebhookSecret(perApp.old);
        if (verifySignature(body, signature, oldPlain)) {
          log.info("webhook.signature.old_secret_accepted — provider still using previous secret");
          return { valid: true, usedOldSecret: true };
        }
      } catch (err) {
        log.warn({ err }, "failed to decrypt old per-app webhook secret");
      }
    }
  }

  return { valid: false, usedOldSecret: false };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const noopEnqueue: EnqueueFn = async () => {
  log.warn("enqueueProviderReposSync not wired — skipping sync");
};

/**
 * Dispatch a verified GitHub webhook event to the appropriate handler.
 * Called asynchronously after responding 200 to GitHub.
 */
export async function handleWebhook(
  db: Db,
  event: string,
  payload: unknown,
  deliveryId: string,
  extras?: WebhookExtras,
  deps?: WebhookDeps,
): Promise<void> {
  log.debug({ event, deliveryId }, "dispatching webhook");

  const enqueue = deps?.enqueue ?? noopEnqueue;
  const queries: Required<NonNullable<WebhookDeps["queries"]>> = {
    upsertInstallation: deps?.queries?.upsertInstallation ?? upsertInstallationDefault,
    deleteInstallation: deps?.queries?.deleteInstallation ?? deleteInstallationDefault,
    deleteGitHubInstallationAndUsers:
      deps?.queries?.deleteGitHubInstallationAndUsers ??
      deleteGitHubInstallationAndUsersDefault,
    upsertRepos: deps?.queries?.upsertRepos ?? upsertReposDefault,
    deleteRepos: deps?.queries?.deleteRepos ?? deleteReposDefault,
  };

  switch (event) {
    case "push":
      await handlePush(db, payload as PushPayload, deliveryId, extras);
      break;

    case "pull_request":
      await handlePullRequest(db, payload as PullRequestPayload, deliveryId);
      break;

    case "installation":
      await handleInstallationEvent(
        db,
        payload,
        deliveryId,
        enqueue,
        queries,
        extras?.githubAppId,
      );
      break;

    case "installation_repositories":
      await handleInstallationRepositoriesEvent(db, payload, deliveryId, enqueue, queries);
      break;

    default:
      log.debug({ event, deliveryId }, "unhandled webhook event");
  }
}
