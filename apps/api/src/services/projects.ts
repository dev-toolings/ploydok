// SPDX-License-Identifier: AGPL-3.0-only
//
// Project-level runtime helpers.
//
// Each project owns isolated data-plane networks:
//   - bridge `ploydok-proj-<id>` for leftover docker runtimes
//   - overlay `ploydok-swarm-proj-<id>` for Swarm services
// Caddy joins those networks on deploy (see `caddy/attachment.ts`) so ingress
// can reach upstreams without putting two projects on the same network.

import { and, eq, isNotNull } from "drizzle-orm";
import { apps, databases, projects } from "@ploydok/db";
import type { Db } from "@ploydok/db";
import { isAlreadyExists } from "../agent/index.js";
import { getSharedAgent } from "../debug/singletons.js";
import { childLogger } from "../logger";

type Agent = ReturnType<typeof getSharedAgent>;

const log = childLogger("projects");

/** Shared network every app is attached to so Caddy can reach them. */
export const PLOYDOK_INGRESS_NETWORK = "ploydok-ingress";

/** Legacy flat network kept for backward compat with pre-Phase-1.C apps. */
export const PLOYDOK_PUBLIC_NETWORK = "ploydok-public";

/** Derive the per-project private network name from a project id. */
export function projectNetworkName(projectId: string): string {
  // Docker network names: [a-zA-Z0-9][a-zA-Z0-9_.-]+ — our nanoid() ids are
  // safe by construction, but we lowercase defensively.
  return `ploydok-proj-${projectId.toLowerCase()}`;
}

export function projectSwarmNetworkName(projectId: string): string {
  return `ploydok-swarm-proj-${projectId.toLowerCase()}`;
}

/**
 * Ensure the per-project Docker bridge network exists and that the column
 * `projects.network_name` is populated. Idempotent: calling twice is cheap
 * (ALREADY_EXISTS from the agent is treated as success).
 *
 * Caller must pass an Agent client (or leave undefined to use the shared one).
 * Returns the final network name so callers can pass it to container create.
 */
export async function ensureProjectNetwork(
  db: Db,
  projectId: string,
  agent?: Agent,
): Promise<string> {
  const rows = await db
    .select({ network_name: projects.network_name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Project not found: ${projectId}`);

  if (row.network_name) return row.network_name;

  const agentClient = agent ?? getSharedAgent();
  const name = projectNetworkName(projectId);
  try {
    await agentClient.networkCreate({
      name,
      driver: "bridge",
      attachable: false,
      labels: { "ploydok.kind": "project-network", "ploydok.project_id": projectId },
    });
    log.info({ projectId, name }, "project network created");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("ALREADY_EXISTS")) {
      log.info({ projectId, name }, "project network already exists");
    } else {
      throw err;
    }
  }

  await db.update(projects).set({ network_name: name }).where(eq(projects.id, projectId));
  return name;
}

export async function ensureProjectSwarmNetwork(
  db: Db,
  projectId: string,
  agent?: Agent,
): Promise<string> {
  const rows = await db
    .select({
      network_name: projects.network_name,
      swarm_network_name: projects.swarm_network_name,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Project not found: ${projectId}`);

  const agentClient = agent ?? getSharedAgent();
  const name = projectSwarmNetworkName(projectId);
  try {
    await agentClient.networkCreate({
      name,
      driver: "overlay",
      attachable: true,
      labels: {
        "ploydok.kind": "project-swarm-network",
        "ploydok.project_id": projectId,
      },
    });
    log.info({ projectId, name }, "project swarm network created");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("already exists") || msg.includes("ALREADY_EXISTS")) {
      log.info({ projectId, name }, "project swarm network already exists");
    } else {
      throw err;
    }
  }

  if (row.swarm_network_name !== name) {
    await db
      .update(projects)
      .set({ swarm_network_name: name })
      .where(eq(projects.id, projectId));
  }

  return name;
}

export async function ensureProjectDatabasesOnSwarmNetwork(
  db: Db,
  projectId: string,
  swarmNetwork: string,
  agent?: Agent,
): Promise<{ scanned: number; attached: number; alreadyAttached: number }> {
  const rows = await db
    .select({
      id: databases.id,
      host: databases.host,
      container_id: databases.container_id,
    })
    .from(databases)
    .where(
      and(
        eq(databases.project_id, projectId),
        eq(databases.management_mode, "managed"),
        isNotNull(databases.container_id),
      ),
    );

  const agentClient = agent ?? getSharedAgent();
  const result = { scanned: rows.length, attached: 0, alreadyAttached: 0 };

  for (const row of rows) {
    if (!row.container_id) continue;
    const aliases = row.host ? [row.host] : [];
    try {
      await agentClient.networkConnect({
        networkId: swarmNetwork,
        containerId: row.container_id,
        aliases,
      });
      result.attached++;
      log.info(
        { projectId, dbId: row.id, containerId: row.container_id, swarmNetwork },
        "database attached to project swarm network",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        isAlreadyExists(err) ||
        /already exists|already connected|is already attached/i.test(msg)
      ) {
        result.alreadyAttached++;
        continue;
      }
      throw err;
    }
  }

  return result;
}

export async function reconcileSwarmProjectNetworks(
  db: Db,
  agent?: Agent,
): Promise<{
  projects: number;
  databasesScanned: number;
  databasesAttached: number;
  databasesAlreadyAttached: number;
  failed: number;
}> {
  const rows = await db
    .select({ project_id: apps.project_id })
    .from(apps)
    .where(and(eq(apps.runtime_mode, "swarm"), eq(apps.status, "running")));

  const projectIds = Array.from(new Set(rows.map((row) => row.project_id)));
  const result = {
    projects: projectIds.length,
    databasesScanned: 0,
    databasesAttached: 0,
    databasesAlreadyAttached: 0,
    failed: 0,
  };

  for (const projectId of projectIds) {
    try {
      const network = await ensureProjectSwarmNetwork(db, projectId, agent);
      const attached = await ensureProjectDatabasesOnSwarmNetwork(
        db,
        projectId,
        network,
        agent,
      );
      result.databasesScanned += attached.scanned;
      result.databasesAttached += attached.attached;
      result.databasesAlreadyAttached += attached.alreadyAttached;
    } catch (err) {
      result.failed++;
      log.warn({ err, projectId }, "project swarm network reconcile failed");
    }
  }

  return result;
}

/**
 * Networks a container must be attached to for a given app: **only the
 * project-network**. Caddy is attached dynamically to the same network on
 * each deploy via `ensureCaddyOnProjectNetwork`, so inbound ingress still
 * works, but apps of other projects never share a bridge.
 */
export function networksForApp(projectNetwork: string): string[] {
  return [projectNetwork];
}
