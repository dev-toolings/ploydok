// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import { childLogger } from "../logger";
import type { Context, Next } from "hono";
import type { Agent } from "../agent/index.js";
import { AgentError, GrpcStatus } from "../agent/index.js";
import type { CaddyClient } from "../caddy/index.js";
import { getSharedAgent, getSharedCaddy } from "./singletons.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = childLogger("debug-routes");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * nanoid alphabet restricted to lowercase alphanumeric chars so that
 * "ploydok-" + appId matches the agent allowlist ^ploydok-[a-z0-9][a-z0-9-]{0,62}$.
 */
const genAppId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10);

const PLOYDOK_NETWORK = "ploydok-public";

function containerName(appId: string): string {
  return `ploydok-${appId}`;
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof AgentError && err.code === GrpcStatus.ALREADY_EXISTS;
}

function isNotFound(err: unknown): boolean {
  return err instanceof AgentError && err.code === GrpcStatus.NOT_FOUND;
}

// ---------------------------------------------------------------------------
// Auth guard
// ---------------------------------------------------------------------------

/**
 * requireOwner — ensures the request carries a valid session.
 *
 * NOTE: The users table has no `role` column (Sprint 1 is mono-user WebAuthn,
 * no RBAC implemented yet). For now, any authenticated user is treated as
 * "owner". When a `role` field is added to the schema, update this guard to
 * also check `user.role === 'owner'`.
 *
 * Returns 401 if unauthenticated, 403 if authenticated but not owner
 * (future-proof stub).
 */
function requireOwner(c: Context, next: Next) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (c as any).get("user");
  if (!user) {
    return c.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentification requise" } },
      401,
    );
  }
  // Future: if (user.role !== 'owner') { return c.json({ error: ... }, 403); }
  return next();
}

// ---------------------------------------------------------------------------
// Router factory (accepts injected dependencies for testability)
// ---------------------------------------------------------------------------

export interface DebugRouterDeps {
  agent?: Agent;
  caddy?: CaddyClient;
}

export function createDebugRouter(deps: DebugRouterDeps = {}): Hono {
  const debug = new Hono();

  // -------------------------------------------------------------------------
  // POST /debug/spawn-nginx
  // -------------------------------------------------------------------------
  debug.post("/spawn-nginx", requireOwner, async (c) => {
    const agent = deps.agent ?? getSharedAgent();
    const caddy = deps.caddy ?? getSharedCaddy();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (c as any).get("user") as { id: string };
    const appId = genAppId();
    const name = containerName(appId);
    const domain = Bun.env["PLOYDOK_DOMAIN"] ?? "localhost";
    const host = `${appId}.${domain}`;
    const upstream = `${name}:80`;
    const isSecure = domain !== "localhost";

    log.info({ appId, name, host }, "spawn-nginx : démarrage");

    let containerId: string | null = null;
    let routeUpserted = false;

    try {
      // 1. Create container
      const created = await agent.containerCreate({
        name,
        image: "nginx:alpine",
        env: {},
        labels: {
          // The agent refuses to operate on a container without ploydok.kind.
          "ploydok.kind": "app",
          "ploydok.app_id": appId,
          "ploydok.owner_id": user.id,
        },
        network: PLOYDOK_NETWORK,
        networks: [],
        volumes: [],
        ports: [{ containerPort: 80, hostPort: 0, proto: "tcp", hostIp: "" }],
        restartPolicy: "",
        resourceLimits: { cpu: 0.5, memoryBytes: 128 * 1024 * 1024, pidsLimit: 0 },
        command: [],
        user: "",
      });
      containerId = created.containerId;
      log.info({ appId, containerId }, "container créé");

      // 2. Upsert Caddy route
      await caddy.upsertRoute({ host, upstream, appId });
      routeUpserted = true;
      log.info({ appId, host, upstream }, "route Caddy upsertée");

      // 3. Start container
      await agent.containerStart({ containerId });
      log.info({ appId, containerId }, "container démarré");

      const url = `${isSecure ? "https" : "http"}://${host}`;
      return c.json({ appId, containerId, url, containerName: name }, 201);
    } catch (err) {
      log.error({ appId, containerId, err }, "spawn-nginx : erreur — rollback");

      // Rollback best-effort
      if (routeUpserted) {
        try {
          await caddy.removeRoute(appId);
        } catch (rbErr) {
          log.warn({ appId, rbErr }, "rollback removeRoute échoué");
        }
      }
      if (containerId) {
        try {
          await agent.containerRemove({ containerId, force: true, removeVolumes: false });
        } catch (rbErr) {
          if (!isNotFound(rbErr)) {
            log.warn({ containerId, rbErr }, "rollback containerRemove échoué");
          }
        }
      }

      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: "SPAWN_FAILED", message: msg } }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /debug/spawn-nginx/:appId
  // -------------------------------------------------------------------------
  debug.delete("/spawn-nginx/:appId", requireOwner, async (c) => {
    const agent = deps.agent ?? getSharedAgent();
    const caddy = deps.caddy ?? getSharedCaddy();

    const appId = c.req.param("appId") ?? "";
    if (!appId) {
      return c.json({ error: { code: "BAD_REQUEST", message: "appId requis" } }, 400);
    }

    const name = containerName(appId);
    log.info({ appId, name }, "teardown nginx");

    // 1. Remove Caddy route (idempotent)
    await caddy.removeRoute(appId);

    // 2. Stop container (ignore not-found)
    try {
      await agent.containerStop({ containerId: name, timeoutSeconds: 10 });
    } catch (err) {
      if (!isNotFound(err)) {
        log.warn({ appId, name, err }, "containerStop échoué (ignoré)");
      }
    }

    // 3. Remove container (force, ignore not-found)
    try {
      await agent.containerRemove({ containerId: name, force: true, removeVolumes: false });
    } catch (err) {
      if (!isNotFound(err)) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: { code: "REMOVE_FAILED", message: msg } }, 500);
      }
    }

    log.info({ appId }, "teardown nginx terminé");
    return c.json({ appId, removed: true });
  });

  return debug;
}
