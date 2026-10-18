// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Deploy hooks — pre/post blue-green swap.
 *
 * Each hook spawns an ephemeral container using the just-built image, runs the
 * hook command via ContainerExec bidi-streaming (which surfaces the exit code),
 * streams stdout/stderr to the log bus, then removes the container.
 * Exit code != 0 throws HookFailedError.
 *
 * Pre-deploy failure → throw (abort deploy, mark failed).
 * Post-deploy failure → caller catches and marks build `succeeded_with_warning`
 *                       without rolling back.
 */
import { ephemeralContainerName } from "../services/runtime-containers.js"
import type { Agent } from "../agent/index.js"
import { logBus } from "./log-bus.js"
import { workerLog } from "./logger.js"
import { ensureProjectNetwork } from "../services/projects.js"
import type { Db } from "@ploydok/db"

const log = workerLog.child({ module: "hooks" })

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class HookFailedError extends Error {
  constructor(
    public readonly phase: "pre" | "post",
    public readonly exitCode: number,
  ) {
    super(`${phase}_deploy hook failed with exit code ${exitCode}`)
    this.name = "HookFailedError"
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunHookOptions {
  db: Db
  agent: Agent
  appId: string
  ownerId: string
  projectId: string
  imageRef: string
  /** Merged runtime env to inject into the hook container. */
  env: Record<string, string>
  /** Shell command string (passed to sh -c). */
  hookCmd: string
  /** Timeout in seconds before the hook container is force-removed. */
  timeoutS: number
  buildId: string
  phase: "pre" | "post"
}

// ---------------------------------------------------------------------------
// runHook — core implementation
// ---------------------------------------------------------------------------

/**
 * Spawn an ephemeral container, run the hook command via ContainerExec,
 * stream logs, capture exit code. Throws HookFailedError if exit code != 0.
 * Always removes the ephemeral container after completion.
 */
export async function runHook(opts: RunHookOptions): Promise<void> {
  const { db, agent, appId, ownerId, projectId, imageRef, env, hookCmd, timeoutS, buildId, phase } = opts

  const hookLog = log.child({ appId, buildId, phase })
  hookLog.info({ hookCmd, timeoutS }, "running deploy hook")

  const publish = (line: string) => {
    logBus.publish(`build:${buildId}`, `[hook:${phase}] ${line}`)
  }

  publish(`→ ${phase}_deploy: ${hookCmd}`)

  // Resolve network (same project network as the app)
  const networkName = await ensureProjectNetwork(db, projectId, agent)

  const containerName = ephemeralContainerName(`hook-${phase}`, appId)

  // Create an idle container, start it, then run the hook through exec.
  let containerId: string
  try {
    const res = await agent.containerCreate({
      name: containerName,
      image: imageRef,
      env,
      // Idle entrypoint — the real command runs via exec
      command: ["sleep", String(timeoutS + 30)],
      networks: [networkName],
      network: networkName,
      volumes: [],
      ports: [],
      restartPolicy: "no",
      resourceLimits: { cpu: 0.5, memoryBytes: 256 * 1024 * 1024, pidsLimit: 100 },
      labels: {
        "ploydok.kind": "hook",
        "ploydok.app_id": appId,
        "ploydok.owner_id": ownerId,
        "ploydok.hook_phase": phase,
      },
      user: "",
    })
    containerId = res.containerId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    hookLog.error({ err }, "failed to create hook container")
    throw new Error(`Failed to create ${phase}_deploy hook container: ${msg}`, { cause: err })
  }

  let exitCode: number | null = null
  let timedOut = false
  try {
    await agent.containerStart({ containerId })
    publish(`container started: ${containerId}`)

    // Open a ContainerExec bidi-stream to run the hook command
    const exec = agent.containerExec()

    // Collect exit code and stream output
    const timeoutHandle = setTimeout(() => {
      // Force-close the exec stream on timeout
      timedOut = true
      exec.close()
    }, timeoutS * 1000)

    try {
      // Send the start frame
      exec.send({
        start: {
          containerId,
          cmd: ["sh", "-c", hookCmd],
          tty: false,
          cols: 220,
          rows: 50,
          user: "",
        },
      })

      for await (const frame of exec.events) {
        if (frame.stdout && frame.stdout.length > 0) {
          const text = Buffer.from(frame.stdout).toString("utf-8")
          for (const line of text.split("\n")) {
            if (line) publish(line)
          }
        }
        if (frame.stderr && frame.stderr.length > 0) {
          const text = Buffer.from(frame.stderr).toString("utf-8")
          for (const line of text.split("\n")) {
            if (line) publish(`[stderr] ${line}`)
          }
        }
        if (frame.exit !== undefined) {
          exitCode = frame.exit.code
          break
        }
      }
    } finally {
      clearTimeout(timeoutHandle)
      exec.close()
    }

    if (timedOut) throw new Error(`${phase}_deploy hook timed out after ${timeoutS}s`)
    if (exitCode === null) throw new Error("hook exec ended without exit code")
    publish(`exited with code ${exitCode}`)
  } finally {
    try {
      await agent.containerStop({ containerId, timeoutSeconds: 2 })
    } catch {
      // Already stopped or start failed; still attempt removal.
    }
    await safeRemove(agent, containerId, hookLog)
  }

  if (exitCode !== 0) {
    hookLog.warn({ exitCode, phase }, "hook failed")
    throw new HookFailedError(phase, exitCode)
  }

  hookLog.info({ exitCode }, `${phase}_deploy hook succeeded`)
}

async function safeRemove(
  agent: Agent,
  containerId: string,
  logger: typeof workerLog,
): Promise<void> {
  try {
    await agent.containerRemove({ containerId, force: true, removeVolumes: false })
  } catch (err) {
    logger.warn({ err, containerId }, "failed to remove hook container (non-fatal)")
  }
}

// ---------------------------------------------------------------------------
// Convenience wrappers called from deploy.ts
// ---------------------------------------------------------------------------

export interface HookContext {
  db: Db
  agent: Agent
  appId: string
  ownerId: string
  projectId: string
  imageRef: string
  env: Record<string, string>
  buildId: string
}

/**
 * Run the pre-deploy hook. Throws HookFailedError on non-zero exit.
 */
export async function runPreDeployHook(
  ctx: HookContext,
  hookCmd: string,
  timeoutS: number,
): Promise<void> {
  await runHook({ ...ctx, hookCmd, timeoutS, phase: "pre" })
}

/**
 * Run the post-deploy hook. Never throws — returns { ok, error? }.
 * Build is already succeeded; failure only sets `succeeded_with_warning`.
 */
export async function runPostDeployHook(
  ctx: HookContext,
  hookCmd: string,
  timeoutS: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await runHook({ ...ctx, hookCmd, timeoutS, phase: "post" })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: msg }
  }
}
