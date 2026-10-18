// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Delete-app cascade handler — Coolify-style.
 *
 * Steps performed (each one best-effort, all errors collected and surfaced):
 *  1. Stop the Swarm service (if any) then leftover blue/green containers.
 *  2. Delete app registry manifests and local images. Scheduled GC reclaims blobs.
 *  3. Remove Caddy upstream/route for the app.
 *  4. Delete on-disk build workspaces (~/.ploydok-dev/builds/<appId>/).
 *  5. Delete the `apps` row — `builds`, `domains`, `env_vars` cascade via FK.
 *
 * Triggered by job `app.delete.requested`. Each option flag mirrors the
 * Coolify API (`delete_volumes`, `docker_cleanup`, `delete_configurations`,
 * `delete_connected_networks`).
 */
import path from "node:path"
import { rm } from "node:fs/promises"
import { and, eq, ne } from "drizzle-orm"
import { z } from "zod"
import { apps, databases, projects, services, app_delete_jobs } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { claimQueuedRow } from "../queue-claim"
import { auditUnauthorized, auditClaimed } from "../queue-audit"
import { env } from "../../env"
import { workerLog as logger } from "../logger"
import { CaddyClient } from "../../caddy/client.js"
import { detachCaddyFromProjectNetwork } from "../../caddy/attachment.js"
import { getSharedAgent } from "../../debug/singletons.js"
import { staticRootForApp } from "./build-static.js"
import { deleteRepository } from "../registry.js"
import { imageRepoForApp } from "../../services/runtime-containers.js"
import { purgeAppVolumeRoot } from "../../services/app-volumes.js"

export interface DeleteAppOptions {
  appId: string
  /** Wipe app registry manifests and local images. Default true. */
  deleteImages?: boolean
  /** Stop + force-remove the Docker containers. Default true. */
  dockerCleanup?: boolean
  /** Remove the on-disk build workspace. Default true. */
  deleteBuildArtifacts?: boolean
  /** Remove the Caddy upstream + route. Default true. */
  deleteCaddyRoutes?: boolean
  /** Override Caddy admin URL (tests). */
  caddyBaseUrl?: string
  /** Override agent socket path (tests). */
  agentSocketPath?: string
}

export interface DeleteAppResult {
  appId: string
  steps: {
    containers: { ok: boolean; error?: string }
    registry: { ok: boolean; tagsDeleted: number; error?: string }
    localImages: { ok: boolean; error?: string }
    caddy: { ok: boolean; error?: string }
    buildArtifacts: { ok: boolean; error?: string }
    staticArtifacts: { ok: boolean; error?: string }
    appVolumes: { ok: boolean; error?: string }
    dbCascade: { ok: boolean; error?: string }
  }
}

const DeleteAppPayloadSchema = z.object({
  jobId: z.string().optional(),
  appId: z.string().optional(),
})

const log = logger.child({ handler: "delete-app" })

function errToString(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function projectHasRemainingNetworkConsumers(
  db: Db,
  projectId: string,
  deletingAppId: string
): Promise<boolean> {
  const siblingApps = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.project_id, projectId), ne(apps.id, deletingAppId)))
    .limit(1)

  if (siblingApps.length > 0) {
    return true
  }

  const projectDatabases = await db
    .select({ id: databases.id })
    .from(databases)
    .where(eq(databases.project_id, projectId))
    .limit(1)

  if (projectDatabases.length > 0) {
    return true
  }

  const projectServices = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.project_id, projectId))
    .limit(1)

  return projectServices.length > 0
}

/**
 * Handler for the `app.delete.requested` job (Wave 2 DB-anchored).
 * Payload: { jobId }.
 */
export async function handleDeleteApp(
  db: Db,
  job: { id: string; payload: unknown }
): Promise<void> {
  const rawPayload =
    typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload
  const payload = DeleteAppPayloadSchema.parse(rawPayload)

  if (!payload.jobId) {
    if (payload.appId) {
      auditUnauthorized({
        jobName: "app.delete.requested",
        jobId: job.id,
        payload,
        reason: "legacy payload format — drop after queue drain",
      })
      return
    }

    auditUnauthorized({
      jobName: "app.delete.requested",
      jobId: job.id,
      payload,
      reason: "jobId missing from payload",
    })
    return
  }

  const claimed = await claimQueuedRow<typeof app_delete_jobs.$inferSelect>({
    db,
    table: app_delete_jobs,
    id: payload.jobId,
  })

  if (!claimed) {
    auditUnauthorized({
      jobName: "app.delete.requested",
      jobId: job.id,
      payload,
      reason: "app_delete_job row not found or not pending",
    })
    return
  }

  auditClaimed({
    jobName: "app.delete.requested",
    jobId: job.id,
    rowId: payload.jobId,
    actor: claimed.requested_by_user_id,
    source: claimed.source,
  })

  const appId = claimed.app_id
  const jobId = payload.jobId
  const opts = (claimed.options ?? {}) as {
    deleteImages?: boolean
    dockerCleanup?: boolean
    deleteBuildArtifacts?: boolean
    deleteCaddyRoutes?: boolean
  }

  const deleteImages = opts.deleteImages ?? true
  const dockerCleanup = opts.dockerCleanup ?? true
  const deleteBuildArtifacts = opts.deleteBuildArtifacts ?? true
  const deleteCaddyRoutes = opts.deleteCaddyRoutes ?? true

  const result: DeleteAppResult = {
    appId,
    steps: {
      containers: { ok: true },
      registry: { ok: true, tagsDeleted: 0 },
      localImages: { ok: true },
      caddy: { ok: true },
      buildArtifacts: { ok: true },
      staticArtifacts: { ok: true },
      appVolumes: { ok: true },
      dbCascade: { ok: true },
    },
  }

  log.info({ appId, jobId: payload.jobId }, "delete-app cascade started")

  const finalize = async (
    status: "succeeded" | "failed",
    errorMessage?: string
  ) => {
    await db
      .update(app_delete_jobs)
      .set({
        status,
        finished_at: new Date(),
        ...(errorMessage ? { error_message: errorMessage } : {}),
      })
      .where(eq(app_delete_jobs.id, jobId))
  }

  // 1. Stop + remove Swarm services and leftover blue/green containers.
  try {
    if (dockerCleanup) {
      try {
        const { stopSwarmApp } = await import("../swarm-runner.js")
        await stopSwarmApp(appId, db)
      } catch (err) {
        result.steps.containers = { ok: false, error: errToString(err) }
        log.warn({ appId, err }, "swarm service cleanup failed (continuing)")
      }
      try {
        const { stopApp } = await import("../runner.js")
        await stopApp(appId, db, {})
      } catch (err) {
        const previous = result.steps.containers.error
        result.steps.containers = {
          ok: false,
          error: [previous, errToString(err)].filter(Boolean).join("; "),
        }
        log.warn({ appId, err }, "container cleanup failed (continuing)")
      }
    }

    // 2. Wipe only this app's normal and preview repositories. Retention GC
    // protects rollback images, so it must not be used for permanent deletion.
    // Blob reclamation belongs to scheduled registry GC, never this cascade.
    if (deleteImages) {
      const repo = imageRepoForApp(appId)
      const registryErrors: string[] = []
      const localErrors: string[] = []
      const registries = new Set([
        env.PLOYDOK_REGISTRY_URL.replace(/^https?:\/\//, ""),
        env.PLOYDOK_REGISTRY_PUSH_URL.replace(/^https?:\/\//, ""),
      ])
      for (const repository of [repo, `preview-${repo}`]) {
        try {
          const cleanup = await deleteRepository(repository)
          result.steps.registry.tagsDeleted += cleanup.tagsDeleted
          registryErrors.push(...cleanup.errors)
        } catch (err) {
          registryErrors.push(`${repository}: ${errToString(err)}`)
        }
        for (const registry of registries) {
          const image = `${registry}/${repository}`
          try {
            await getSharedAgent().imageRemove({ image, allTags: true })
          } catch (err) {
            localErrors.push(`${image}: ${errToString(err)}`)
          }
        }
      }
      if (registryErrors.length) {
        result.steps.registry.ok = false
        result.steps.registry.error = registryErrors.join("; ")
      }
      if (localErrors.length) {
        result.steps.localImages = { ok: false, error: localErrors.join("; ") }
      }
    }

    // 3. Caddy: delete upstream/route. (stopApp already calls removeUpstream
    //    when dockerCleanup ran — this is the explicit fallback for the case
    //    where containers were skipped or stopApp failed before reaching it.)
    if (deleteCaddyRoutes && !dockerCleanup) {
      try {
        const caddy = new CaddyClient()
        await caddy.removeRoute(appId)
      } catch (err) {
        result.steps.caddy = { ok: false, error: errToString(err) }
        log.warn({ appId, err }, "caddy cleanup failed (continuing)")
      }
    }

    // 4. Build artifacts on disk.
    if (deleteBuildArtifacts) {
      try {
        const dir = path.join(env.PLOYDOK_BUILD_DIR, appId)
        await rm(dir, { recursive: true, force: true })
      } catch (err) {
        result.steps.buildArtifacts = { ok: false, error: errToString(err) }
        log.warn({ appId, err }, "build-artifacts cleanup failed (continuing)")
      }
    }

    try {
      await rm(path.dirname(staticRootForApp(appId)), {
        recursive: true,
        force: true,
      })
    } catch (err) {
      result.steps.staticArtifacts = { ok: false, error: errToString(err) }
      log.warn({ appId, err }, "static artifacts cleanup failed (continuing)")
    }

    try {
      await purgeAppVolumeRoot(appId)
    } catch (err) {
      result.steps.appVolumes = { ok: false, error: errToString(err) }
      log.warn({ appId, err }, "app-volumes cleanup failed (continuing)")
    }

    // 4b. Per-project network cleanup (Phase 1.C).
    //
    // Before deleting the `apps` row we check whether this is the last runtime
    // consumer of its project. If so and the project has a network_name set,
    // drop the Docker bridge network. Best-effort: failures are non-fatal.
    try {
      const [appRow] = await db
        .select({ project_id: apps.project_id })
        .from(apps)
        .where(eq(apps.id, appId))
        .limit(1)

      if (appRow) {
        const hasRemainingConsumers = await projectHasRemainingNetworkConsumers(
          db,
          appRow.project_id,
          appId
        )

        if (!hasRemainingConsumers) {
          const [projRow] = await db
            .select({ network_name: projects.network_name })
            .from(projects)
            .where(eq(projects.id, appRow.project_id))
            .limit(1)

          if (projRow?.network_name) {
            try {
              const agent = getSharedAgent()
              // Caddy must leave the project network before Docker accepts to
              // delete it (`network_remove` fails 403 while endpoints remain).
              await detachCaddyFromProjectNetwork(agent, projRow.network_name)
              await agent.networkRemove({ networkId: projRow.network_name })
              await db
                .update(projects)
                .set({ network_name: null })
                .where(eq(projects.id, appRow.project_id))
              log.info(
                {
                  appId,
                  projectId: appRow.project_id,
                  network: projRow.network_name,
                },
                "project network removed (last app deleted)"
              )
            } catch (err) {
              log.warn(
                { appId, projectId: appRow.project_id, err },
                "networkRemove failed (non-fatal)"
              )
            }
          }
        }
      }
    } catch (err) {
      log.warn({ appId, err }, "project-network cleanup check failed (non-fatal)")
    }

    // 5. DB cascade: deleting the apps row removes builds/env_vars/domains
    //    via the existing FK constraints (onDelete: 'cascade').
    try {
      await db.delete(apps).where(eq(apps.id, appId))
    } catch (err) {
      result.steps.dbCascade = { ok: false, error: errToString(err) }
      log.error({ appId, err }, "db cascade delete failed")
    }

    log.info({ appId, result }, "delete-app cascade finished")

    // Update the app_delete_job row with the final status.
    const finalStatus = Object.values(result.steps).every((step) => step.ok)
    ? "succeeded"
    : "failed"
    const errorMsg = Object.values(result.steps)
      .filter((step) => step.error)
      .map((step) => step.error)
      .join("; ")

    await finalize(finalStatus, errorMsg)
  } catch (err) {
    await finalize("failed", errToString(err))
    throw err
  }
}
