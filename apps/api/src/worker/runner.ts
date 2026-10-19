// SPDX-License-Identifier: AGPL-3.0-only
//
// Blue-green runner — M3.3.
//
// Orchestration flow:
//   1. Determine the current color from apps.container_id (blue|green).
//   2. Pick the opposite color for the new container.
//   3. Create + start the new container via the Agent gRPC.
//   4. Poll healthcheck until healthy (or timeout).
//   5. On healthy: setUpstream → sleep grace → stop old container.
//   6. On unhealthy: stop new container, throw DeployFailedError.
//
// Additional operations:
//   stopApp    — stops both blue/green containers + removes Caddy route.
//   rollbackApp — re-activates the previous container (by container_id stored
//                 in the last two succeeded builds) in < 10s.
//   restartApp  — stopApp + runBlueGreen from the last succeeded build image.

import * as fs from "node:fs"
import { and, desc, eq, inArray } from "drizzle-orm"
import * as grpc from "@grpc/grpc-js"
import { AgentClient } from "@ploydok/agent-proto"
import type {
  ContainerCreateResponse,
  ContainerStartResponse,
  ContainerStopResponse,
  ContainerRemoveResponse,
  InspectContainerHealthResponse,
  LogLine,
  ReadContainerFileResponse,
} from "@ploydok/agent-proto"
import { ContainerHealthStatus } from "@ploydok/agent-proto"
import { apps, builds, projects } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { CaddyClient } from "../caddy/client.js"
import {
  publishHealthyAppRoute,
  syncAppDomainAliases,
} from "../domains/routing.js"
import {
  assertDomainAvailable,
  withDomainLock,
} from "../domains/availability.js"
import { logBus } from "./log-bus.js"
import { eventBus } from "./event-bus.js"
import { workerLog } from "./logger.js"
import { isAlreadyExists, isNotFound, toAgentError } from "../agent/errors.js"
import {
  inferContainerColor,
  runtimeContainerName,
  runtimeContainerNameCandidates,
} from "../services/runtime-containers.js"
import { ensureProjectNetwork, networksForApp } from "../services/projects.js"
import { ensureCaddyOnProjectNetwork } from "../caddy/attachment.js"
import { getSharedAgent } from "../debug/singletons.js"
import { PLANS } from "@ploydok/shared"
import type { PlanName } from "@ploydok/shared"
import { buildEnvForDeploy } from "../secrets/resolver.js"
import { purgeCloudflareForApp } from "../cloudflare/purge.js"
import { listRuntimeAppVolumeMounts } from "../services/app-volumes.js"
import { classifyAppDomainWithInstanceBase } from "../domains/app-domain.js"
import { healthcheckTest } from "./healthcheck-shell.js"
import {
  currentDeployLease,
  currentDeployLeaseCondition,
  DeployLeaseLostError,
  fenceDeploySideEffect,
  runOwnedDeployReconciliation,
} from "./app-deploy-lock.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRACE_MS = 30_000 // 30 s traffic-drain window
const STOP_TIMEOUT_S = 10 // SIGKILL after N seconds when stopping
const APP_LOG_TAIL_LINES = 200
const APP_LOG_MAX_BYTES = 512 * 1024
const KNOWN_APP_LOG_PATHS = [
  "/app/storage/logs/laravel.log",
  "/app/var/log/prod.log",
  "/app/var/log/dev.log",
]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DeployFailedError extends Error {
  constructor(appId: string, reason: string) {
    super(`DeployFailedError[${appId}]: ${reason}`)
    this.name = "DeployFailedError"
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContainerColor = "blue" | "green"

export interface RunBlueGreenOptions {
  appId: string
  imageRef: string
  /** Key=value pairs injected as container env vars. */
  env: Record<string, string>
  /** Explicit runtime port exposed by the app process inside the container. */
  runtimePort?: number
  /** Overrides read from apps table when not provided. */
  healthcheck?: {
    path?: string
    port?: number
    intervalS?: number
    timeoutS?: number
    retries?: number
    startPeriodS?: number
  }
  db: Db
  /** Override Caddy admin URL (useful for tests). */
  caddyBaseUrl?: string
  /** Override agent socket path (useful for tests). */
  agentSocketPath?: string
  /**
   * Invoked right after Caddy is switched to the new container and the DB
   * status has been set to "running" — before the grace period + old-container
   * stop. Lets callers signal "app live" to the UI without waiting 30s.
   */
  onLive?: (info: RunBlueGreenResult) => void | Promise<void>
  /**
   * Optional registry credentials to pass to the agent for the pre-spawn
   * image pull. Required for private source images (Phase 1.B Docker-image
   * deploys); unused for locally-built images pulled from the Ploydok
   * private registry (no auth in dev).
   */
  registryAuth?: { username: string; password: string }
}

export interface RunBlueGreenResult {
  containerId: string
  color: ContainerColor
}

// ---------------------------------------------------------------------------
// Agent gRPC client factory
// ---------------------------------------------------------------------------

function defaultAgentSocket(): string {
  const fromEnv = process.env["PLOYDOK_AGENT_SOCKET"]
  if (fromEnv) return fromEnv
  return process.env["NODE_ENV"] === "prod"
    ? "/run/ploydok/agent.sock"
    : "/tmp/ploydok/agent.sock"
}

const DEFAULT_AGENT_SOCKET = defaultAgentSocket()

function defaultAgentAddress(): string | null {
  return process.env["PLOYDOK_AGENT_ADDR"] ?? null
}

// Si les 3 env mTLS sont fournies (cf. installer/install.sh::generate_agent_pki),
// on monte un canal gRPC chiffré + authentifié par cert client. Sinon fallback
// insecure — utilisé en dev (socket Unix local) ou quand l'agent tourne en
// PLOYDOK_AGENT_INSECURE=1.
function createAgentClient(
  socketPath: string | undefined = undefined
): InstanceType<typeof AgentClient> {
  const address = socketPath
    ? `unix://${socketPath}`
    : (defaultAgentAddress() ?? `unix://${DEFAULT_AGENT_SOCKET}`)
  const caPath = process.env["PLOYDOK_AGENT_CA"]
  const certPath = process.env["PLOYDOK_AGENT_CLIENT_CERT"]
  const keyPath = process.env["PLOYDOK_AGENT_CLIENT_KEY"]
  const creds =
    caPath && certPath && keyPath
      ? grpc.credentials.createSsl(
          fs.readFileSync(caPath),
          fs.readFileSync(keyPath),
          fs.readFileSync(certPath)
        )
      : grpc.credentials.createInsecure()
  // Voir apps/api/src/agent/client.ts — sur Unix socket + TLS il faut forcer
  // l'authority pour que la vérif SAN matche le CN du cert agent.
  const channelOptions: grpc.ClientOptions = {
    "grpc.ssl_target_name_override": "ploydok-agent",
    "grpc.default_authority": "ploydok-agent",
  }
  return new AgentClient(address, creds, channelOptions)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oppositeColor(color: ContainerColor): ContainerColor {
  return color === "blue" ? "green" : "blue"
}

/**
 * Promisify a gRPC unary call.
 * The callback form is (error, response) — we coerce `res` via `as` because
 * the @grpc/grpc-js typings use overloads that TypeScript cannot resolve here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function grpcUnary<Res>(
  fn: (...args: any[]) => grpc.ClientUnaryCall,
  req: unknown
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    fn(req, (err: grpc.ServiceError | null, res: Res) => {
      if (err) reject(err)
      else resolve(res)
    })
  })
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Poll the healthcheck endpoint of a container via the Agent gRPC pingContainer.
 * The agent runs on the host and resolves Docker bridge DNS — the API process
 * cannot resolve container names directly.
 * Returns true if healthy within the retry budget.
 *
 * @internal Exported for unit testing only — do not use outside this module.
 */
/**
 * Poll Docker's daemon-maintained `State.Health.Status` for a container.
 *
 * The agent supplies a static `HEALTHCHECK CMD` on every managed app at create
 * time (cf. `runBlueGreen` below), so Docker maintains the health state
 * authoritatively — and the probe runs *inside* the container, sidestepping
 * the per-project network isolation that prevents the agent (now a docker-
 * compose service on `ploydok` + `ploydok-public`) from HTTP-pinging an app
 * sitting on `ploydok-proj-<orgSlug>`.
 *
 * Mapping of Docker statuses:
 *  - `HEALTHY`      → resolve true.
 *  - `STARTING`     → keep polling.
 *  - `UNHEALTHY`    → keep polling (Docker will keep retrying — we may yet
 *                     transition to healthy).
 *  - `NONE`         → resolve true when Docker reports the container running,
 *                     which is how older agents represent a container without
 *                     a HEALTHCHECK; a stopped container still fails.
 *  - `containerMissing` → resolve false immediately: no point retrying when
 *                         the target has been removed under our feet.
 */
export async function pollHealthcheck(opts: {
  agent: InstanceType<typeof AgentClient>
  containerId: string
  intervalMs: number
  retries: number
  startPeriodMs: number
  appId: string
  color: ContainerColor
}): Promise<boolean> {
  const channel = `runtime:${opts.appId}`

  if (opts.startPeriodMs > 0) {
    logBus.publish(
      channel,
      `[healthcheck] grace period ${opts.startPeriodMs}ms before first probe`
    )
    await sleep(opts.startPeriodMs)
  }

  let lastProbeOutput = ""
  for (let attempt = 1; attempt <= opts.retries; attempt++) {
    await sleep(opts.intervalMs)
    const label = `[healthcheck ${attempt}/${opts.retries}]`
    try {
      const resp = await grpcUnary<InspectContainerHealthResponse>(
        opts.agent.inspectContainerHealth.bind(opts.agent),
        { containerId: opts.containerId }
      )

      lastProbeOutput = resp.lastProbeOutput?.trim().slice(0, 4096) ?? ""
      if (resp.containerMissing) {
        logBus.publish(
          channel,
          `${label} container is gone — aborting healthcheck`
        )
        return false
      }

      switch (resp.status) {
        case ContainerHealthStatus.CONTAINER_HEALTH_STATUS_HEALTHY:
          logBus.publish(
            channel,
            `${label} status=healthy failing_streak=${resp.failingStreak}`
          )
          return true
        case ContainerHealthStatus.CONTAINER_HEALTH_STATUS_UNHEALTHY:
          logBus.publish(
            channel,
            `${label} status=unhealthy failing_streak=${resp.failingStreak}${
              resp.lastProbeOutput
                ? ` — ${resp.lastProbeOutput.trim().slice(0, 200)}`
                : ""
            }`
          )
          break
        case ContainerHealthStatus.CONTAINER_HEALTH_STATUS_STARTING:
          logBus.publish(
            channel,
            `${label} status=starting failing_streak=${resp.failingStreak}`
          )
          break
        case ContainerHealthStatus.CONTAINER_HEALTH_STATUS_NONE:
        default:
          if (resp.running === true || resp.state === "running") {
            logBus.publish(
              channel,
              `${label} status=none: container is running without a HEALTHCHECK; treating it as ready`
            )
            return true
          }
          logBus.publish(
            channel,
            `${label} status=none: container has no HEALTHCHECK and is not running, aborting`
          )
          return false
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logBus.publish(channel, `${label} error: ${msg}`)
    }
  }
  if (/healthcheck (?:impossible|failed):/.test(lastProbeOutput)) {
    throw new Error(`Docker healthcheck failed: ${lastProbeOutput}`)
  }
  return false
}

/**
 * Determine the active color from Caddy when available, then fall back to the
 * persisted app/build state. A DNS-gated deploy may persist a healthy pending
 * slot before Caddy can serve it, so the DB color is not authoritative for the
 * next blue-green replacement.
 */
async function getCurrentColor(
  db: Db,
  appId: string,
  caddy?: Pick<CaddyClient, "getUpstream">
): Promise<ContainerColor> {
  if (caddy) {
    const upstream = await caddy.getUpstream(appId)
    const activeColor = inferContainerColor(upstream?.host)
    if (activeColor) return activeColor
  }

  // Look at the app row first (container_id).
  const appRows = await db
    .select({ container_id: apps.container_id })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)

  const currentContainerId = appRows[0]?.container_id
  const currentColor = inferContainerColor(currentContainerId)
  if (currentColor) return currentColor

  // Fallback: check build records.
  const buildRows = await db
    .select({ container_id: builds.container_id })
    .from(builds)
    .where(and(eq(builds.app_id, appId), inArray(builds.status, ["succeeded", "succeeded_with_warning"])))
    .orderBy(desc(builds.created_at))
    .limit(1)

  const bid = buildRows[0]?.container_id
  const buildColor = inferContainerColor(bid)
  if (buildColor) return buildColor

  // Default: treat current as green so we start with blue.
  return "green"
}

/**
 * Pull an image through the Agent (server-streaming gRPC).
 *
 * Docker Engine does not auto-pull on container_create — if the image is not
 * local it returns 404. We must explicitly pull from our registry before
 * create, even though we just pushed it via BuildKit (the push lives in the
 * registry container; the host daemon's cache is separate).
 *
 * Errors during the stream reject the promise. Progress frames are published
 * to the runtime log channel so the user sees the pull advancing.
 */
/**
 * Resolve the proto `ResourceLimits` from an app row (Phase 1.C).
 * Priority: explicit per-app columns (cpu_limit, mem_limit_bytes, pids_limit)
 * override the plan default. `plan === 'custom'` with no explicit columns
 * means "no enforcement" (returns undefined so the proto treats zeros as
 * "unlimited").
 */
function resolveResourceLimits(appRow: {
  plan: PlanName | string | null
  cpu_limit: number | null
  mem_limit_bytes: number | null
  pids_limit: number | null
}): { cpu: number; memoryBytes: number; pidsLimit: number } | undefined {
  const planName = (appRow.plan ?? "custom") as PlanName
  const planLimits = PLANS[planName] ?? null

  const cpu = appRow.cpu_limit ?? planLimits?.cpu ?? 0
  const memMB = planLimits?.memMB ?? 0
  const memoryBytes =
    appRow.mem_limit_bytes ?? (memMB > 0 ? memMB * 1024 * 1024 : 0)
  const pidsLimit = appRow.pids_limit ?? planLimits?.pids ?? 0

  if (cpu === 0 && memoryBytes === 0 && pidsLimit === 0) {
    return undefined
  }
  return { cpu, memoryBytes, pidsLimit }
}

async function pullImage(
  agent: InstanceType<typeof AgentClient>,
  image: string,
  channel: string,
  registryAuth?: { username: string; password: string }
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = agent.imagePull({ image, registryAuth })
    let lastStatus = ""
    stream.on("data", (progress: { status?: string }) => {
      const s = progress?.status
      if (s && s !== lastStatus) {
        lastStatus = s
        logBus.publish(channel, `[runner] pull: ${s}`)
      }
    })
    stream.on("end", () => resolve())
    stream.on("error", (err: Error) => reject(err))
  })
}

export async function publishContainerLogTail(
  agent: Pick<InstanceType<typeof AgentClient>, "containerLogs">,
  containerId: string,
  channel: string,
  opts: { tail?: number; timeoutMs?: number } = {}
): Promise<void> {
  const tail = opts.tail ?? 200
  const timeoutMs = opts.timeoutMs ?? 5_000

  logBus.publish(
    channel,
    `[runner] collecting last ${tail} container log lines before rollback`
  )

  let stream: grpc.ClientReadableStream<LogLine>
  try {
    stream = agent.containerLogs({
      containerId,
      follow: false,
      sinceUnix: 0,
      tail,
    })
  } catch (err) {
    logBus.publish(
      channel,
      `[runner] failed to start container log collection: ${errMsg(err)}`
    )
    return
  }

  let count = 0
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      stream.cancel()
      logBus.publish(
        channel,
        `[runner] container log collection timed out after ${timeoutMs}ms`
      )
      finish()
    }, timeoutMs)

    stream.on("data", (entry: LogLine) => {
      const streamName = entry.stream === "stderr" ? "stderr" : "stdout"
      const line = entry.line.trimEnd()
      if (!line) return
      count++
      const parsedTs = Date.parse(entry.timestamp)
      logBus.publish(channel, `[container ${streamName}] ${line}`, {
        ...(Number.isFinite(parsedTs) ? { t: parsedTs } : {}),
      })
    })
    stream.on("error", (err: Error) => {
      logBus.publish(
        channel,
        `[runner] container log collection failed: ${errMsg(err)}`
      )
      finish()
    })
    stream.on("end", finish)
  })

  logBus.publish(channel, `[runner] collected ${count} container log lines`)
}

export async function publishKnownAppLogFiles(
  agent: Pick<InstanceType<typeof AgentClient>, "readContainerFile">,
  containerId: string,
  channel: string,
  paths: ReadonlyArray<string> = KNOWN_APP_LOG_PATHS
): Promise<void> {
  for (const filePath of paths) {
    let response: ReadContainerFileResponse
    try {
      response = await grpcUnary<ReadContainerFileResponse>(
        agent.readContainerFile.bind(agent),
        {
          containerId,
          path: filePath,
          maxBytes: APP_LOG_MAX_BYTES,
        }
      )
    } catch (err) {
      logBus.publish(
        channel,
        `[runner] failed to read app log ${filePath}: ${errMsg(err)}`
      )
      continue
    }

    if (response.error || response.isBinary || response.content.length === 0) {
      continue
    }

    const text = new TextDecoder("utf-8", { fatal: false }).decode(
      response.content
    )
    const lines = text
      .split(/\r?\n/g)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-APP_LOG_TAIL_LINES)

    if (lines.length === 0) continue
    const suffix = response.truncated ? " (file truncated by reader)" : ""
    logBus.publish(channel, `[runner] app log tail: ${filePath}${suffix}`)
    for (const line of lines) {
      logBus.publish(channel, `[app log ${filePath}] ${line}`)
    }
  }
}

/**
 * Load env vars for an app from the DB and return them as a plain Record.
 * Secret values are passed as-is — the caller is responsible for not leaking.
 */
async function loadRuntimeEnv(
  db: Db,
  appId: string
): Promise<Record<string, string>> {
  return buildEnvForDeploy(db, appId, "prod", "runtime")
}

/**
 * Stop a container by name via the Agent and remove it (idempotent).
 *
 * Real failures (agent unavailable, validator denied, etc.) are logged at
 * `warn` level so a failed rollback no longer slips silently — without that
 * log the runner used to leave orphan containers running after a failed
 * deploy, which then surfaced as bogus "Healthy" badges in the UI.
 *
 * NotFound (404 — container already removed or never existed) stays at
 * `debug`: that's the expected idempotent path.
 */
export async function stopContainer(
  agent: InstanceType<typeof AgentClient>,
  name: string
): Promise<void> {
  try {
    // container_stop requires container_id; container names work for Docker.
    await grpcUnary<ContainerStopResponse>(agent.containerStop.bind(agent), {
      containerId: name,
      timeoutSeconds: STOP_TIMEOUT_S,
    })
  } catch (err) {
    if (isNotFound(toAgentError(err))) {
      workerLog.debug(
        { name, err: errMsg(err) },
        "stopContainer: target already gone (stop)"
      )
    } else {
      workerLog.warn(
        { name, err: errMsg(err) },
        "stopContainer: stop failed — container may be left running"
      )
    }
  }
  try {
    await grpcUnary<ContainerRemoveResponse>(
      agent.containerRemove.bind(agent),
      { containerId: name, force: true, removeVolumes: false }
    )
  } catch (err) {
    if (isNotFound(toAgentError(err))) {
      workerLog.debug(
        { name, err: errMsg(err) },
        "stopContainer: target already gone (remove)"
      )
    } else {
      workerLog.warn(
        { name, err: errMsg(err) },
        "stopContainer: remove failed — orphan container will linger"
      )
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function stopContainerCandidates(
  agent: InstanceType<typeof AgentClient>,
  names: Array<string>
): Promise<void> {
  for (const name of names) {
    await stopContainer(agent, name)
  }
}

export async function createContainerWithStaleSlotRecovery(opts: {
  agent: InstanceType<typeof AgentClient>
  caddyClient: CaddyClient
  appId: string
  containerName: string
  channel: string
  request: unknown
}): Promise<ContainerCreateResponse> {
  try {
    await fenceDeploySideEffect()
    return await grpcUnary<ContainerCreateResponse>(
      opts.agent.containerCreate.bind(opts.agent),
      opts.request
    )
  } catch (err) {
    const agentErr = toAgentError(err)
    if (!isAlreadyExists(agentErr)) throw err

    let upstream: { host: string; port: number } | null
    try {
      upstream = await opts.caddyClient.getUpstream(opts.appId)
    } catch (upstreamErr) {
      workerLog.warn(
        {
          appId: opts.appId,
          containerName: opts.containerName,
          err: errMsg(upstreamErr),
        },
        "runner: cannot verify Caddy upstream before stale slot cleanup"
      )
      throw err
    }

    if (upstream?.host === opts.containerName) {
      logBus.publish(
        opts.channel,
        `[runner] container ${opts.containerName} already exists and is still the active Caddy upstream`
      )
      throw err
    }

    // A legacy/canonical name mismatch can make the active Caddy container
    // differ from the requested name while still occupying the same color.
    // Never remove or replace that active color during stale-slot recovery.
    if (
      upstream &&
      inferContainerColor(upstream.host) ===
        inferContainerColor(opts.containerName)
    ) {
      logBus.publish(
        opts.channel,
        `[runner] refusing to replace active Caddy color ${upstream.host} while creating ${opts.containerName}`
      )
      throw err
    }

    workerLog.warn(
      {
        appId: opts.appId,
        containerName: opts.containerName,
        upstreamHost: upstream?.host ?? null,
      },
      "runner: removing stale target slot before retrying container create"
    )
    logBus.publish(
      opts.channel,
      `[runner] stale target container ${opts.containerName} already exists; removing it before retry`
    )
    await fenceDeploySideEffect()
    await stopContainer(opts.agent, opts.containerName)

    await fenceDeploySideEffect()
    return await grpcUnary<ContainerCreateResponse>(
      opts.agent.containerCreate.bind(opts.agent),
      opts.request
    )
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a blue-green deploy for an app.
 *
 * Steps:
 *   1. Determine current color → pick new color.
 *   2. Create + start new container (name = ploydok-app-{appId}-{newColor}).
 *   3. Poll healthcheck (interval, retries from apps table).
 *   4. If healthy: setUpstream → sleep 30s grace → stop old container.
 *   5. If unhealthy: stop new container → throw DeployFailedError.
 *
 * On success: updates apps.container_id + apps.status = 'running'.
 */
export async function runBlueGreen(
  opts: RunBlueGreenOptions
): Promise<RunBlueGreenResult> {
  const { appId, imageRef, db } = opts
  const channel = `runtime:${appId}`

  // -- Load app config (healthcheck settings + domain + owner for labels) --
  const appRows = await db
    .select({
      id: apps.id,
      container_id: apps.container_id,
      slug: apps.slug,
      domain: apps.domain,
      restart_policy: apps.restart_policy,
      runtime_port: apps.runtime_port,
      healthcheck_path: apps.healthcheck_path,
      healthcheck_port: apps.healthcheck_port,
      healthcheck_interval_s: apps.healthcheck_interval_s,
      healthcheck_timeout_s: apps.healthcheck_timeout_s,
      healthcheck_retries: apps.healthcheck_retries,
      healthcheck_start_period_s: apps.healthcheck_start_period_s,
      plan: apps.plan,
      cpu_limit: apps.cpu_limit,
      mem_limit_bytes: apps.mem_limit_bytes,
      pids_limit: apps.pids_limit,
      cdn_mode: apps.cdn_mode,
      cdn_cache_ttl_s: apps.cdn_cache_ttl_s,
      cdn_cache_paths: apps.cdn_cache_paths,
      cdn_compression: apps.cdn_compression,
      cdn_image_optim: apps.cdn_image_optim,
      cdn_headers: apps.cdn_headers,
      cdn_external_provider: apps.cdn_external_provider,
      project_id: apps.project_id,
      owner_id: projects.owner_id,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .where(eq(apps.id, appId))
    .limit(1)

  const appRow = appRows[0]
  if (!appRow) throw new Error(`App not found: ${appId}`)

  // Merge healthcheck overrides.
  const hcPath = opts.healthcheck?.path ?? appRow.healthcheck_path ?? "/"
  const runtimePort = opts.runtimePort ?? appRow.runtime_port ?? 3000
  const hcPort =
    opts.healthcheck?.port ?? appRow.healthcheck_port ?? runtimePort
  const hcIntervalS =
    opts.healthcheck?.intervalS ?? appRow.healthcheck_interval_s ?? 5
  const hcTimeoutS =
    opts.healthcheck?.timeoutS ?? appRow.healthcheck_timeout_s ?? 3
  const hcRetries = opts.healthcheck?.retries ?? appRow.healthcheck_retries ?? 6
  const hcStartPeriodS =
    opts.healthcheck?.startPeriodS ?? appRow.healthcheck_start_period_s ?? 30
  const domain = appRow.domain ?? `${appId}.ploydok.local`

  // -- Determine colors -------------------------------------------------------
  // Caddy is authoritative when a route exists. This keeps a DNS-gated
  // pending slot from making the next deploy target the live old runtime.
  const caddyClient = new CaddyClient(opts.caddyBaseUrl)
  const currentColor = await getCurrentColor(db, appId, caddyClient)
  const newColor = oppositeColor(currentColor)
  const newName = runtimeContainerName(appRow, newColor)
  const oldNames = runtimeContainerNameCandidates(appRow, currentColor)

  logBus.publish(
    channel,
    `[runner] blue-green: current=${currentColor} new=${newColor}`
  )
  logBus.publish(
    channel,
    `[runner] starting container ${newName} from ${imageRef}`
  )
  workerLog.info(
    {
      appId,
      currentColor,
      newColor,
      newName,
      oldNames,
      imageRef,
    },
    "blue-green: target slot resolved"
  )
  const containerEnv = { ...containerEnvWithPort(opts.env, runtimePort) }

  // -- Agent client ----------------------------------------------------------
  const agent = createAgentClient(opts.agentSocketPath)
  let newContainerId: string | undefined
  let caddySwitched = false
  let previousCaddyUpstream: { host: string; port: number } | null = null
  let previousCaddyHost: string | null = null

  try {
    // 0. Pull image — host daemon's cache is separate from the registry storage.
    await fenceDeploySideEffect()
    logBus.publish(channel, `[runner] pulling image ${imageRef}`)
    await pullImage(agent, imageRef, channel, opts.registryAuth)
    logBus.publish(channel, `[runner] image pulled`)

    // 0b. Ensure per-project network + attach Caddy to it + resolve quota limits.
    // Zero-trust invariant: the app container only ever lives on its project
    // network. Caddy is attached dynamically so external ingress still works,
    // but other projects' apps share NO network with this one.
    await fenceDeploySideEffect()
    const projectNetwork = await ensureProjectNetwork(db, appRow.project_id)
    await fenceDeploySideEffect()
    await ensureCaddyOnProjectNetwork(getSharedAgent(), projectNetwork)
    const networks = networksForApp(projectNetwork)
    const resourceLimits = resolveResourceLimits(appRow)
    const volumes = await listRuntimeAppVolumeMounts(db, appId, {
      ensureDirectories: true,
    })

    // 1. Create container.
    await fenceDeploySideEffect()
    const createResp = await createContainerWithStaleSlotRecovery({
      agent,
      caddyClient,
      appId,
      containerName: newName,
      channel,
      request: {
        name: newName,
        image: imageRef,
        env: containerEnv,
        labels: {
          "ploydok.kind": "app",
          "ploydok.app_id": appId,
          "ploydok.owner_id": appRow.owner_id,
          "ploydok.color": newColor,
          "ploydok.deploy_token": currentDeployLease()?.token ?? "unfenced",
        },
        // Multi-network: `networks` takes precedence; `network` kept empty
        // so legacy single-string path is inert.
        network: "",
        networks,
        volumes: volumes.map((volume) => ({
          hostPath: volume.hostPath,
          containerPath: volume.mountPath,
          readOnly: volume.readOnly,
        })),
        ports: [],
        restartPolicy: appRow.restart_policy,
        resourceLimits,
        command: [],
        user: "",
        // Force the Docker HEALTHCHECK to probe the app's HTTP listener rather
        // than whatever the base image baked in (e.g. dunglas/frankenphp ships
        // `curl :2019/metrics`, which fails when our Caddyfile disables the
        // admin endpoint). Invariant: a Ploydok-managed app is unhealthy only
        // when the app itself is unhealthy, never because of a stale inherited
        // probe.
        //
        // Dynamic probe: stack-agnostic, bind-agnostic.
        //
        // Tooling: try curl first, fall back to wget. wget ships in busybox so
        // every alpine image has it; curl is the default on debian/ubuntu
        // bases. Distroless without either is unsupported (rare in PaaS).
        //
        // Bind address: try 127.0.0.1 *and* the container hostname. Many
        // frameworks (Express/Hono/uvicorn/php-fpm) bind 0.0.0.0 → both work.
        // Next.js `output: 'standalone'` and apps that read HOSTNAME for the
        // bind address only listen on the container hostname's eth0 IP, so
        // 127.0.0.1 is refused. Cycling through both hosts covers the case.
        //
        // Guardrail: 5xx means the app booted but is broken, so do not switch
        // traffic. 4xx can still be a valid "alive" signal for API apps whose
        // root path is not routable; users can set a custom healthcheck path
        // when they need stricter semantics.
        healthcheck: {
          test: healthcheckTest(hcPort, hcPath),
          intervalSeconds: hcIntervalS,
          timeoutSeconds: hcTimeoutS,
          retries: hcRetries,
          startPeriodSeconds: hcStartPeriodS,
        },
      },
    })

    newContainerId = createResp.containerId
    logBus.publish(channel, `[runner] container created: ${newContainerId}`)

    // 2. Start container.
    await fenceDeploySideEffect()
    await grpcUnary<ContainerStartResponse>(agent.containerStart.bind(agent), {
      containerId: newContainerId,
    })
    logBus.publish(channel, `[runner] container started`)

    // 3. Poll Docker-maintained health (HEALTHCHECK we injected at create).
    logBus.publish(
      channel,
      `[runner] polling Docker health for ${hcPath}:${hcPort} (${hcRetries} retries × ${hcIntervalS}s)`
    )
    const healthy = await pollHealthcheck({
      agent,
      containerId: newContainerId,
      intervalMs: hcIntervalS * 1_000,
      retries: hcRetries,
      startPeriodMs: hcStartPeriodS * 1_000,
      appId,
      color: newColor,
    })

    if (!healthy) {
      logBus.publish(channel, `[runner] healthcheck FAILED — rolling back`)
      await publishContainerLogTail(agent, newContainerId, channel)
      await publishKnownAppLogFiles(agent, newContainerId, channel)
      await stopContainer(agent, newContainerId)
      throw new DeployFailedError(
        appId,
        `Docker health for ${hcPath}:${hcPort} did not become healthy after ${hcRetries} retries`
      )
    }

    logBus.publish(
      channel,
      `[runner] healthcheck OK — switching Caddy upstream`
    )

    // 4. Switch Caddy upstream.
    await fenceDeploySideEffect()
    // Capture the route target before changing it. The DB may already point
    // at a healthy pending slot while Caddy still serves the previous color.
    // Compensation must restore this observed target, never the DB value.
    ;[previousCaddyUpstream, previousCaddyHost] = await Promise.all([
      caddyClient.getUpstream(appId),
      caddyClient.getRouteHost(appId),
    ])
    const deployLease = currentDeployLease()
    const routeResult = await publishHealthyAppRoute({
      db,
      appId,
      ...(deployLease?.appId === appId && deployLease.buildId
        ? { buildId: deployLease.buildId }
        : {}),
      hostname: domain,
      getCurrentRouteHost: () => caddyClient.getRouteHost(appId),
      proxied: appRow.cdn_mode === "external",
      beforePersist: fenceDeploySideEffect,
      applyRoute: async () => {
        await fenceDeploySideEffect()
        await caddyClient.setUpstream(appId, domain, {
          host: newName, port: runtimePort,
        }, { cdn: appRow })
        caddySwitched = true
      },
      afterRoute: async () => {
        const aliases = await syncAppDomainAliases({
          db, appId, caddy: caddyClient,
          upstream: { host: newName, port: runtimePort },
          beforeSideEffect: fenceDeploySideEffect,
        })
        if (aliases.errors.length) throw new Error("Alias routing requires attention")
      },
    })
    const routeApplied = routeResult.routeApplied
    if (routeApplied) {
      await fenceDeploySideEffect()
      await purgeCloudflareForApp(db, appId)
      logBus.publish(channel, `[runner] Caddy upstream updated`)
    } else {
      logBus.publish(
        channel,
        `[runner] primary route requires DNS/TLS action; retaining the old runtime while the new container is live`
      )
    }
    workerLog.info(
      {
        appId,
        newName,
        oldNames,
        gracePeriodMs: GRACE_MS,
      },
      "blue-green: caddy upstream switched, blue↔green complete"
    )

    // 5. Mark app live immediately — new container serves traffic from this
    //    point. The grace period + old-container stop below are cleanup and
    //    must not delay the UI transition to "running".
    await fenceDeploySideEffect()
    const appUpdates = await db
      .update(apps)
      .set({
        container_id: newName,
        status: "running",
        runtime_has_healthcheck: true,
        updated_at: new Date(),
      })
      .where(and(eq(apps.id, appId), currentDeployLeaseCondition()))
      .returning({ id: apps.id })
    if (!appUpdates[0]) {
      throw new DeployLeaseLostError("lease changed before app runtime commit")
    }

    const liveInfo: RunBlueGreenResult = {
      containerId: newContainerId,
      color: newColor,
    }
    if (opts.onLive) {
      try {
        await opts.onLive(liveInfo)
      } catch {
        // onLive failures must not abort the deploy — it's a notification hook.
      }
    }
    logBus.publish(channel, `[runner] app live — status set to running`)

    if (routeApplied) {
      // 6. Grace period.
      logBus.publish(channel, `[runner] grace period ${GRACE_MS / 1_000}s …`)
      await sleep(GRACE_MS)

      // 7. Stop old container.
      logBus.publish(channel, `[runner] stopping old container ${oldNames[0]}`)
      await fenceDeploySideEffect()
      await stopContainerCandidates(agent, oldNames)
      logBus.publish(channel, `[runner] old container stopped`)
    } else {
      logBus.publish(
        channel,
        `[runner] old container retained until the primary route passes DNS/TLS checks`
      )
    }

    return liveInfo
  } catch (error) {
    // Reconcile a target slot created before cancellation/lease loss. Never
    // touch the previously-live color here.
    if (caddySwitched) {
      await runOwnedDeployReconciliation(async () => {
        if (previousCaddyUpstream) {
          await caddyClient.setUpstream(
            appId,
            previousCaddyHost ?? domain,
            previousCaddyUpstream
          )
        } else {
          await caddyClient.removeUpstream(appId)
        }
        if (previousCaddyUpstream) {
          await syncAppDomainAliases({
            db,
            appId,
            caddy: caddyClient,
            upstream: previousCaddyUpstream,
          })
        }
        await purgeCloudflareForApp(db, appId)
      }).catch((cleanupError) =>
        workerLog.error(
          { appId, oldName: oldNames[0], cleanupError },
          "runner: Caddy rollback failed during reconciliation"
        )
      )
    }
    if (newContainerId) {
      const containerIdToRemove = newContainerId
      await runOwnedDeployReconciliation(() =>
        stopContainer(agent, containerIdToRemove)
      ).catch((cleanupError) =>
        workerLog.error(
          { appId, newContainerId: containerIdToRemove, cleanupError },
          "runner: partial container reconciliation failed"
        )
      )
    }
    throw error
  } finally {
    agent.close()
  }
}

/**
 * Stop an app (both colors) and remove its Caddy route.
 * Updates apps.status = 'stopped'.
 */
export async function stopApp(
  appId: string,
  db: Db,
  opts?: { agentSocketPath?: string; caddyBaseUrl?: string }
): Promise<void> {
  const appRows = await db
    .select({ id: apps.id, slug: apps.slug })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const app = appRows[0]
  if (!app) throw new Error(`App not found: ${appId}`)

  const agent = createAgentClient(opts?.agentSocketPath)
  const caddyClient = new CaddyClient(opts?.caddyBaseUrl)

  try {
    await Promise.allSettled([
      stopContainerCandidates(
        agent,
        runtimeContainerNameCandidates(app, "blue")
      ),
      stopContainerCandidates(
        agent,
        runtimeContainerNameCandidates(app, "green")
      ),
    ])

    await caddyClient.removeUpstream(appId)

    await db
      .update(apps)
      .set({ status: "stopped", container_id: null, updated_at: new Date() })
      .where(eq(apps.id, appId))
  } finally {
    agent.close()
  }
}

/**
 * Rollback an app to a specific or the previous succeeded build image.
 *
 * @param targetBuildId — when provided, rolls back to that exact build (must
 *   already be validated as `succeeded` by the caller). When absent, falls back
 *   to the second-to-last succeeded build (legacy behaviour).
 * < 10s target: skips grace period, uses direct container swap.
 */
export async function rollbackApp(
  appId: string,
  db: Db,
  targetBuildId?: string,
  opts?: { agentSocketPath?: string; caddyBaseUrl?: string }
): Promise<void> {
  let previousBuild: {
    id: string
    image_tag: string | null
    container_id: string | null
    routing_domain: string | null
  }

  if (targetBuildId) {
    // Explicit build target — the route handler already validated it is succeeded.
    const rows = await db
      .select({
        id: builds.id,
        image_tag: builds.image_tag,
        container_id: builds.container_id,
        routing_domain: builds.routing_domain,
      })
      .from(builds)
      .where(and(eq(builds.id, targetBuildId), eq(builds.app_id, appId)))
      .limit(1)

    if (!rows[0]) {
      throw new Error(
        `Rollback build ${targetBuildId} not found for app ${appId}`
      )
    }
    previousBuild = rows[0]
  } else {
    // Legacy behaviour: use the second-to-last succeeded build.
    const succeededBuilds = await db
      .select({
        id: builds.id,
        image_tag: builds.image_tag,
        container_id: builds.container_id,
        routing_domain: builds.routing_domain,
      })
      .from(builds)
      .where(and(eq(builds.app_id, appId), inArray(builds.status, ["succeeded", "succeeded_with_warning"])))
      .orderBy(desc(builds.created_at))
      .limit(2)

    if (succeededBuilds.length < 2) {
      throw new Error(
        `Cannot rollback app ${appId}: need at least 2 succeeded builds, found ${succeededBuilds.length}`
      )
    }

    previousBuild = succeededBuilds[1]!
  }

  if (!previousBuild.image_tag) {
    throw new Error(
      `Rollback target build ${previousBuild.id} has no image_tag`
    )
  }

  const channel = `runtime:${appId}`
  logBus.publish(
    channel,
    `[runner] rollback to image ${previousBuild.image_tag}`
  )

  // Determine the current color from the live Caddy route when present. A
  // DNS-gated deploy can leave the DB one slot ahead of that route.
  const caddyClient = new CaddyClient(opts?.caddyBaseUrl)
  const currentColor = await getCurrentColor(db, appId, caddyClient)
  const rollbackColor = oppositeColor(currentColor)

  const agent = createAgentClient(opts?.agentSocketPath)

  // Load app healthcheck port for Caddy upstream + owner_id for labels
  // + quotas + project_id (Phase 1.C).
  const appRows = await db
    .select({
      id: apps.id,
      slug: apps.slug,
      domain: apps.domain,
      domain_source: apps.domain_source,
      container_id: apps.container_id,
      restart_policy: apps.restart_policy,
      runtime_port: apps.runtime_port,
      healthcheck_path: apps.healthcheck_path,
      healthcheck_port: apps.healthcheck_port,
      healthcheck_interval_s: apps.healthcheck_interval_s,
      healthcheck_timeout_s: apps.healthcheck_timeout_s,
      healthcheck_retries: apps.healthcheck_retries,
      healthcheck_start_period_s: apps.healthcheck_start_period_s,
      plan: apps.plan,
      cpu_limit: apps.cpu_limit,
      mem_limit_bytes: apps.mem_limit_bytes,
      pids_limit: apps.pids_limit,
      cdn_mode: apps.cdn_mode,
      cdn_cache_ttl_s: apps.cdn_cache_ttl_s,
      cdn_cache_paths: apps.cdn_cache_paths,
      cdn_compression: apps.cdn_compression,
      cdn_image_optim: apps.cdn_image_optim,
      cdn_headers: apps.cdn_headers,
      cdn_external_provider: apps.cdn_external_provider,
      project_id: apps.project_id,
      owner_id: projects.owner_id,
    })
    .from(apps)
    .innerJoin(projects, eq(apps.project_id, projects.id))
    .where(eq(apps.id, appId))
    .limit(1)

  const appRow = appRows[0]
  if (!appRow) throw new Error(`App not found: ${appId}`)
  const rollbackName = runtimeContainerName(appRow, rollbackColor)
  const oldNames = runtimeContainerNameCandidates(appRow, currentColor)
  const runtimePort = appRow.runtime_port ?? 3000
  const hcPath = appRow.healthcheck_path ?? "/"
  const hcPort = appRow.healthcheck_port ?? runtimePort
  const hcIntervalS = appRow.healthcheck_interval_s ?? 5
  const hcTimeoutS = appRow.healthcheck_timeout_s ?? 3
  const hcRetries = appRow.healthcheck_retries ?? 6
  const hcStartPeriodS = appRow.healthcheck_start_period_s ?? 30
  const domain =
    previousBuild.routing_domain ?? appRow.domain ?? `${appId}.ploydok.local`
  const containerEnv = containerEnvWithPort(
    await loadRuntimeEnv(db, appId),
    runtimePort
  )

  let rollbackContainerId: string | undefined
  let caddySwitched = false
  let previousCaddyUpstream: { host: string; port: number } | null = null
  let previousCaddyHost: string | null = null

  try {
    // Pull image first — host daemon cache ≠ registry storage.
    logBus.publish(channel, `[runner] pulling image ${previousBuild.image_tag}`)
    await pullImage(agent, previousBuild.image_tag, channel)
    logBus.publish(channel, `[runner] image pulled`)

    const projectNetwork = await ensureProjectNetwork(db, appRow.project_id)
    await ensureCaddyOnProjectNetwork(getSharedAgent(), projectNetwork)
    const networks = networksForApp(projectNetwork)
    const resourceLimits = resolveResourceLimits(appRow)
    const volumes = await listRuntimeAppVolumeMounts(db, appId, {
      ensureDirectories: true,
    })

    // Create + start rollback container.
    const createResp = await createContainerWithStaleSlotRecovery({
      agent,
      caddyClient,
      appId,
      containerName: rollbackName,
      channel,
      request: {
        name: rollbackName,
        image: previousBuild.image_tag,
        env: containerEnv,
        labels: {
          "ploydok.kind": "app",
          "ploydok.app_id": appId,
          "ploydok.owner_id": appRow.owner_id,
          "ploydok.color": rollbackColor,
          "ploydok.rollback": "1",
        },
        network: "",
        networks,
        volumes: volumes.map((volume) => ({
          hostPath: volume.hostPath,
          containerPath: volume.mountPath,
          readOnly: volume.readOnly,
        })),
        ports: [],
        restartPolicy: appRow.restart_policy,
        resourceLimits,
        command: [],
        user: "",
        healthcheck: {
          test: healthcheckTest(hcPort, hcPath),
          intervalSeconds: hcIntervalS,
          timeoutSeconds: hcTimeoutS,
          retries: hcRetries,
          startPeriodSeconds: hcStartPeriodS,
        },
      },
    })
    rollbackContainerId = createResp.containerId

    logBus.publish(
      channel,
      `[runner] rollback container created: ${createResp.containerId}`
    )

    await grpcUnary<ContainerStartResponse>(agent.containerStart.bind(agent), {
      containerId: createResp.containerId,
    })
    logBus.publish(channel, `[runner] rollback container started`)

    // A restored runtime must pass the same health gate before receiving traffic.
    const healthy = await pollHealthcheck({
      agent,
      containerId: createResp.containerId,
      intervalMs: hcIntervalS * 1_000,
      retries: hcRetries,
      startPeriodMs: hcStartPeriodS * 1_000,
      appId,
      color: rollbackColor,
    })
    if (!healthy) {
      await stopContainer(agent, createResp.containerId)
      throw new DeployFailedError(appId, "Rollback runtime did not become healthy")
    }

    await withDomainLock(db, domain, async (tx, hostname) => {
      await assertDomainAvailable(tx, hostname, { excludeAppId: appId })
    })
    ;[previousCaddyUpstream, previousCaddyHost] = await Promise.all([
      caddyClient.getUpstream(appId),
      caddyClient.getRouteHost(appId),
    ])
    const routeResult = await publishHealthyAppRoute({
      db,
      appId,
      hostname: domain,
      getCurrentRouteHost: () => caddyClient.getRouteHost(appId),
      proxied: appRow.cdn_mode === "external",
      beforePersist: fenceDeploySideEffect,
      applyRoute: async () => {
        await fenceDeploySideEffect()
        await caddyClient.setUpstream(
          appId,
          domain,
          {
            host: rollbackName,
            port: runtimePort,
          },
          { cdn: appRow }
        )
        caddySwitched = true
      },
      afterRoute: async () => {
        const aliases = await syncAppDomainAliases({
          db, appId, caddy: caddyClient,
          upstream: { host: rollbackName, port: runtimePort },
          beforeSideEffect: fenceDeploySideEffect,
        })
        if (aliases.errors.length) throw new Error("Alias routing requires attention")
      },
    })
    const routeApplied = routeResult.routeApplied
    if (routeApplied) {
      await purgeCloudflareForApp(db, appId)
      logBus.publish(channel, `[runner] Caddy switched to rollback container`)
    } else {
      logBus.publish(
        channel,
        `[runner] rollback runtime is healthy but its primary route requires DNS/TLS action`
      )
    }

    if (routeApplied) {
      // Stop old container.
      await fenceDeploySideEffect()
      await stopContainerCandidates(agent, oldNames)
      logBus.publish(channel, `[runner] old container stopped`)
    } else {
      logBus.publish(
        channel,
        `[runner] old container retained until the rollback route passes DNS/TLS checks`
      )
    }

    // Update DB.
    const rollbackUpdate = db.update(apps).set({
      container_id: rollbackName,
      domain,
      domain_source: classifyAppDomainWithInstanceBase(domain),
      status: "running",
      runtime_has_healthcheck: true,
      updated_at: new Date(),
    })
    const rollbackLeaseCondition = currentDeployLeaseCondition()
    if (rollbackLeaseCondition) {
      const updated = await rollbackUpdate
        .where(and(eq(apps.id, appId), rollbackLeaseCondition))
        .returning({ id: apps.id })
      if (!updated[0]) {
        throw new DeployLeaseLostError(
          "lease changed before rollback runtime commit"
        )
      }
    } else {
      await rollbackUpdate.where(eq(apps.id, appId))
    }

    logBus.publish(channel, `[runner] rollback complete`)
  } catch (error) {
    if (caddySwitched) {
      await runOwnedDeployReconciliation(async () => {
        if (previousCaddyUpstream) {
          await caddyClient.setUpstream(
            appId,
            previousCaddyHost ?? appRow.domain ?? domain,
            previousCaddyUpstream,
            {
              cdn: appRow,
            }
          )
          await syncAppDomainAliases({
            db,
            appId,
            caddy: caddyClient,
            upstream: previousCaddyUpstream,
          })
        } else {
          await caddyClient.removeUpstream(appId)
        }
        await purgeCloudflareForApp(db, appId)
      }).catch((cleanupError) =>
        workerLog.error(
          { appId, cleanupError },
          "runner: Caddy rollback failed during app rollback reconciliation"
        )
      )
    }
    if (rollbackContainerId) {
      const containerIdToRemove = rollbackContainerId
      await runOwnedDeployReconciliation(async () => {
        await stopContainer(agent, containerIdToRemove)
      }).catch((cleanupError) =>
        workerLog.error(
          { appId, rollbackContainerId: containerIdToRemove, cleanupError },
          "runner: rollback container reconciliation failed"
        )
      )
    }
    throw error
  } finally {
    agent.close()
  }
}

/**
 * Restart an app: mark restarting → stop containers → runBlueGreen from last
 * succeeded build. Emits SSE events at each transition.
 *
 * When `background: true`, only the prelude (build precheck + status write +
 * SSE event) is awaited; the stop + redeploy run in the background. Callers
 * that want a quick 202 response (e.g. the POST /apps/:id/restart route) use
 * this to avoid the toast/badge inversion where the SSE "running" event
 * (emitted at runBlueGreen `onLive`) lands before the HTTP response.
 */
export async function restartApp(
  appId: string,
  db: Db,
  userId?: string,
  opts?: {
    agentSocketPath?: string
    caddyBaseUrl?: string
    background?: boolean
  }
): Promise<void> {
  const log = workerLog.child({ appId, op: "restart" })
  const channel = `runtime:${appId}`

  // Find last succeeded build with image_tag before mutating anything.
  const rows = await db
    .select({ image_tag: builds.image_tag })
    .from(builds)
    .where(and(eq(builds.app_id, appId), inArray(builds.status, ["succeeded", "succeeded_with_warning"])))
    .orderBy(desc(builds.created_at))
    .limit(1)

  const lastBuild = rows[0]
  if (!lastBuild?.image_tag) {
    throw new Error(
      `Cannot restart app ${appId}: no succeeded build with an image_tag`
    )
  }

  // 1. Write "restarting" directly — do NOT go through stopApp which forces "stopped".
  await db
    .update(apps)
    .set({ status: "restarting", updated_at: new Date() })
    .where(eq(apps.id, appId))

  logBus.publish(channel, `[runner] restart: status set to restarting`)

  if (userId) {
    try {
      eventBus.publish(`user:${userId}`, {
        type: "deploy.status_change",
        appId,
        message: "Redémarrage en cours",
        data: { status: "restarting" },
      })
    } catch (pubErr) {
      log.warn({ pubErr }, "eventBus publish restarting failed (non-fatal)")
    }
  }

  const heavy = runRestartHeavyWork(
    appId,
    db,
    userId,
    lastBuild.image_tag,
    channel,
    opts
  )

  if (opts?.background) {
    void heavy.catch((err) => {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "restart background work failed"
      )
    })
    return
  }

  await heavy
}

async function runRestartHeavyWork(
  appId: string,
  db: Db,
  userId: string | undefined,
  imageRef: string,
  channel: string,
  opts?: { agentSocketPath?: string; caddyBaseUrl?: string }
): Promise<void> {
  const log = workerLog.child({ appId, op: "restart" })
  // 2. Stop containers (the DB write is already done above — stopApp would
  //    overwrite status to "stopped", so we call the container-stop logic directly).
  logBus.publish(channel, `[runner] restart: stopping current containers`)
  const appRows = await db
    .select({ id: apps.id, slug: apps.slug })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const app = appRows[0]
  if (!app) throw new Error(`App not found: ${appId}`)
  const stopAgent = createAgentClient(opts?.agentSocketPath)
  const stopCaddy = new CaddyClient(opts?.caddyBaseUrl)
  try {
    await Promise.allSettled([
      stopContainerCandidates(
        stopAgent,
        runtimeContainerNameCandidates(app, "blue")
      ),
      stopContainerCandidates(
        stopAgent,
        runtimeContainerNameCandidates(app, "green")
      ),
    ])
    await stopCaddy.removeUpstream(appId)
  } finally {
    stopAgent.close()
  }

  logBus.publish(channel, `[runner] restart: re-deploying ${imageRef}`)

  // 3. Load current env vars.
  const appRuntimeRows = await db
    .select({ runtime_port: apps.runtime_port })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1)
  const runtimePort = appRuntimeRows[0]?.runtime_port ?? 3000
  const containerEnv = containerEnvWithPort(
    await loadRuntimeEnv(db, appId),
    runtimePort
  )

  // 4. Blue-green redeploy — emit "running" as soon as Caddy has switched,
  //    via onLive. The grace period + old-container stop then run without
  //    blocking the UI.
  const runOpts: RunBlueGreenOptions = {
    appId,
    imageRef,
    env: containerEnv,
    runtimePort,
    db,
    onLive: () => {
      if (!userId) return
      try {
        eventBus.publish(`user:${userId}`, {
          type: "deploy.status_change",
          appId,
          message: "Redémarrage terminé",
          data: { status: "running" },
        })
      } catch (pubErr) {
        log.warn(
          { pubErr },
          "eventBus publish running after restart failed (non-fatal)"
        )
      }
    },
  }
  if (opts?.agentSocketPath !== undefined)
    runOpts.agentSocketPath = opts.agentSocketPath
  if (opts?.caddyBaseUrl !== undefined) runOpts.caddyBaseUrl = opts.caddyBaseUrl

  try {
    await runBlueGreen(runOpts)
  } catch (err) {
    // runBlueGreen already wrote "failed" via its own DB update path on error.
    // Emit SSE failure event.
    if (userId) {
      try {
        eventBus.publish(`user:${userId}`, {
          type: "deploy.status_change",
          appId,
          message: `Redémarrage échoué: ${err instanceof Error ? err.message : String(err)}`,
          data: { status: "failed" },
        })
      } catch (pubErr) {
        log.warn(
          { pubErr },
          "eventBus publish restart failed event failed (non-fatal)"
        )
      }
    }
    throw err
  }

  logBus.publish(channel, `[runner] restart complete`)
}

function containerEnvWithPort(
  env: Record<string, string>,
  runtimePort: number
): Record<string, string> {
  return {
    ...env,
    PORT: String(runtimePort),
  }
}
