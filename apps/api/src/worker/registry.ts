// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Docker Registry HTTP API v2 client.
 *
 * Targets the local registry:2 instance at `PLOYDOK_REGISTRY_API_URL`.
 * Supports basic auth via `PLOYDOK_REGISTRY_USER` / `PLOYDOK_REGISTRY_PASS`.
 * Provides GC helpers: keep-last-N and disk-guard threshold check.
 */
import { env } from "../env";
import { getSharedAgent } from "../debug/singletons";

// ---------------------------------------------------------------------------
// Internal HTTP helpers
// ---------------------------------------------------------------------------

function basicAuthHeader(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

function registryBase(): string {
  const url = env.PLOYDOK_REGISTRY_API_URL;
  // Normalise: add http:// if no scheme present (default for local insecure registry).
  return url.startsWith("http") ? url : `http://${url}`;
}

function authHeaders(): Record<string, string> {
  const user = env.PLOYDOK_REGISTRY_USER;
  const pass = env.PLOYDOK_REGISTRY_PASS;
  if (user && pass) {
    return { Authorization: basicAuthHeader(user, pass) };
  }
  return {};
}

async function registryFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = `${registryBase()}/v2/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.docker.distribution.manifest.v2+json",
      ...authHeaders(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return res;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryManifest {
  /** OCI / Docker manifest digest (sha256:…). */
  digest: string;
  /** Media type of the manifest. */
  mediaType: string;
  /** Creation date parsed from the manifest config, if available. */
  createdAt?: Date;
  schemaVersion: number;
}

export interface TagList {
  name: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all tags for the given repository.
 * Returns an empty array if the repository does not exist (404).
 */
export async function listTags(repo: string): Promise<string[]> {
  const tags: string[] = [];
  let query = "";
  const pages = new Set<string>();
  do {
    if (pages.has(query)) {
      throw new Error("registry listTags repeated pagination cursor");
    }
    pages.add(query);
    const res = await registryFetch(`${repo}/tags/list${query}`);
    if (res.status === 404) return [];
    if (!res.ok) {
      throw new Error(
        `registry listTags failed (${res.status}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as TagList;
    tags.push(...(body.tags ?? []));
    const next = res.headers.get("Link")?.match(/<([^>]+)>;\s*rel="?next"?/);
    query = next?.[1] ? new URL(next[1], registryBase()).search : "";
  } while (query);
  return [...new Set(tags)];
}

/**
 * Fetch the manifest for a specific repo:tag.
 * Returns null if the tag does not exist (404).
 */
export async function getManifest(
  repo: string,
  tag: string,
): Promise<RegistryManifest | null> {
  const res = await registryFetch(`${repo}/manifests/${tag}`, {
    headers: {
      Accept: [
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
      ].join(", "),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `registry getManifest failed (${res.status}): ${await res.text()}`,
    );
  }

  const digest = res.headers.get("Docker-Content-Digest") ?? "sha256:unknown";
  const body = (await res.json()) as {
    schemaVersion: number;
    mediaType?: string;
    config?: { digest: string; mediaType: string };
  };

  // Try to get creation date from the config blob.
  let createdAt: Date | undefined;
  if (body.config?.digest) {
    try {
      const cfgRes = await registryFetch(
        `${repo}/blobs/${body.config.digest}`,
        { headers: { Accept: body.config.mediaType } },
      );
      if (cfgRes.ok) {
        const cfg = (await cfgRes.json()) as { created?: string };
        if (cfg.created) createdAt = new Date(cfg.created);
      }
    } catch {
      // Non-fatal: creation date is only used for GC ordering.
    }
  }

  const manifest: RegistryManifest = {
    digest,
    mediaType:
      body.mediaType ?? "application/vnd.docker.distribution.manifest.v2+json",
    schemaVersion: body.schemaVersion,
  };
  if (createdAt !== undefined) manifest.createdAt = createdAt;
  return manifest;
}

/**
 * Delete a manifest by its digest (sha256:…).
 * Requires `storage.delete.enabled: true` in the registry config.
 * No-ops silently if the digest does not exist (404).
 */
export async function deleteDigest(
  repo: string,
  digest: string,
): Promise<void> {
  const res = await registryFetch(`${repo}/manifests/${digest}`, {
    method: "DELETE",
  });
  if (res.status === 404 || res.status === 202 || res.ok) return;
  throw new Error(
    `registry deleteDigest failed (${res.status}): ${await res.text()}`,
  );
}

/** Delete every tagged manifest, including rollback targets, without blob GC. */
export async function deleteRepository(repo: string): Promise<{
  tagsDeleted: number;
  errors: string[];
}> {
  const tags = await listTags(repo);
  const errors: string[] = [];
  const digests = new Map<string, number>();
  // Resolve before deleting: several tags can point to the same manifest.
  for (const tag of tags) {
    try {
      const manifest = await getManifest(repo, tag);
      if (!manifest) continue;
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest.digest)) {
        throw new Error("missing or invalid Docker-Content-Digest");
      }
      digests.set(manifest.digest, (digests.get(manifest.digest) ?? 0) + 1);
    } catch (error) {
      errors.push(`${repo}:${tag}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let tagsDeleted = 0;
  for (const [digest, count] of digests) {
    try {
      await deleteDigest(repo, digest);
      tagsDeleted += count;
    } catch (error) {
      errors.push(`${repo}@${digest}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tagsDeleted, errors };
}

/**
 * Re-tag an existing manifest: copies the manifest from `srcTag` to `dstTag`
 * within the same repository using the Registry HTTP API v2.
 * No-op if srcTag does not exist.
 */
export async function tagManifest(
  repo: string,
  srcTag: string,
  dstTag: string,
): Promise<void> {
  const acceptHeader = [
    "application/vnd.docker.distribution.manifest.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
  ].join(", ")

  const getRes = await registryFetch(`${repo}/manifests/${srcTag}`, {
    headers: { Accept: acceptHeader },
  })
  if (getRes.status === 404) return
  if (!getRes.ok) {
    throw new Error(`registry tagManifest GET failed (${getRes.status}): ${await getRes.text()}`)
  }

  const rawBody = await getRes.text()
  const contentType = getRes.headers.get("Content-Type") ?? "application/vnd.docker.distribution.manifest.v2+json"

  const putRes = await registryFetch(`${repo}/manifests/${dstTag}`, {
    method: "PUT",
    headers: { "Content-Type": contentType, ...authHeaders() },
    body: rawBody,
  })
  if (!putRes.ok) {
    throw new Error(`registry tagManifest PUT failed (${putRes.status}): ${await putRes.text()}`)
  }
}

/**
 * Garbage-collect a repository by keeping only the `n` most recently created
 * images and deleting the rest.
 *
 * Sort order: images with a known `createdAt` date come first (newest first),
 * followed by images with no creation date (kept by default to avoid accidental
 * deletion of pinned tags).
 *
 * Returns the list of deleted digests.
 */
export async function gcKeepLast(
  repo: string,
  n = 3,
): Promise<string[]> {
  const tags = await listTags(repo);
  if (tags.length <= n) return [];

  // Fetch manifests (with creation dates) in parallel, with a concurrency cap.
  const manifests = await Promise.all(
    tags.map(async (tag) => {
      const m = await getManifest(repo, tag);
      return m ? { tag, ...m } : null;
    }),
  );

  // Drop nulls and items without a digest.
  const valid = manifests.filter(
    (m): m is NonNullable<typeof m> & { digest: string } =>
      m !== null && m.digest !== "sha256:unknown",
  );

  // Sort: known date newest-first, then unknown date.
  valid.sort((a, b) => {
    if (a.createdAt && b.createdAt) {
      return b.createdAt.getTime() - a.createdAt.getTime();
    }
    if (a.createdAt) return -1; // a has date → keep (comes before b)
    if (b.createdAt) return 1;  // b has date → keep
    return 0;
  });

  // Keep the first `n`, delete the rest (deduplicate by digest).
  const toDelete = valid.slice(n);
  const deleted: string[] = [];
  const seenDigests = new Set<string>();

  for (const item of toDelete) {
    if (seenDigests.has(item.digest)) continue;
    seenDigests.add(item.digest);
    await deleteDigest(repo, item.digest);
    deleted.push(item.digest);
  }

  return deleted;
}

// ---------------------------------------------------------------------------
// Disk usage
// ---------------------------------------------------------------------------

/**
 * Returns the disk usage percentage of the registry storage volume.
 *
 * Implementation: reads filesystem stats via `df -P` on the registry volume
 * path `PLOYDOK_REGISTRY_VOLUME` (defaults to `/var/lib/registry` for prod,
 * `~/.ploydok-dev/registry` for dev).
 *
 * Falls back to 0 if the path is not accessible (e.g. remote registry).
 */
export async function diskUsagePct(): Promise<number> {
  const home = process.env.HOME ?? "/tmp";
  const registryVolume =
    process.env.PLOYDOK_REGISTRY_VOLUME ??
    (env.NODE_ENV === "prod"
      ? "/var/lib/registry"
      : `${home}/.ploydok-dev/registry`);

  try {
    const proc = Bun.spawn(["df", "-P", registryVolume], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return 0;

    const text = await new Response(proc.stdout).text();
    // df -P output: header line + one data line.
    // Columns: Filesystem 1024-blocks Used Available Capacity Mounted
    const lines = text.trim().split("\n");
    const dataLine = lines[1];
    if (!dataLine) return 0;

    // The "Capacity" column (index 4) looks like "42%".
    const parts = dataLine.split(/\s+/);
    const pctStr = parts[4];
    if (!pctStr) return 0;

    const pct = parseInt(pctStr.replace("%", ""), 10);
    return Number.isNaN(pct) ? 0 : pct;
  } catch {
    return 0;
  }
}

/**
 * Throw if disk usage exceeds `thresholdPct` (default 80%) AND no recovery is
 * possible. The optional `onPressure` callback is invoked when the threshold
 * is hit, giving the caller a chance to run an aggressive GC sweep before we
 * decide to throw. Re-checks disk after the callback; only throws if still
 * above the threshold.
 *
 * Call this before starting a new build to prevent filling the disk.
 */
export async function diskGuard(
  thresholdPct = 80,
  onPressure?: () => Promise<void>,
): Promise<void> {
  const pct = await diskUsagePct();
  if (pct < thresholdPct) return;

  if (onPressure) {
    try {
      await onPressure();
    } catch (err) {
      // The recovery hook should not mask the original disk-pressure error.
      // eslint-disable-next-line no-console
      console.warn(`[registry] diskGuard onPressure callback failed:`, err);
    }
    const after = await diskUsagePct();
    if (after < thresholdPct) return;
    throw new Error(
      `Registry disk usage is at ${after}% (was ${pct}%) — above threshold (${thresholdPct}%). ` +
        `Aggressive GC ran but didn't reclaim enough space. Free disk before retrying.`,
    );
  }

  throw new Error(
    `Registry disk usage is at ${pct}% — above threshold (${thresholdPct}%). ` +
      `Run GC or free disk space before starting a new build.`,
  );
}

// ---------------------------------------------------------------------------
// Blob garbage collection (binary call)
// ---------------------------------------------------------------------------

const REGISTRY_CONTAINER_CONFIG =
  process.env.PLOYDOK_REGISTRY_CONFIG ?? "/etc/docker/registry/config.yml";

export interface GarbageCollectResult {
  ok: boolean;
  output: string;
}

/**
 * Reclaim disk space occupied by orphan blobs in the registry. The HTTP
 * `DELETE /manifests/<digest>` only removes the manifest reference — the
 * underlying blobs stay on disk until the registry binary is invoked with
 * `garbage-collect`.
 *
 * Delegates registry container discovery and execution to the privileged agent.
 *
 * Returns `{ ok: false, output }` instead of throwing so callers can log and
 * continue (the registry may simply be offline in dev).
 */
export async function runtimeGarbageCollect(): Promise<GarbageCollectResult> {
  try {
    const result = await getSharedAgent().registryGarbageCollect(
      { configPath: REGISTRY_CONTAINER_CONFIG },
      5 * 60_000,
    );
    return { ok: true, output: result.output };
  } catch (err) {
    return {
      ok: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}
