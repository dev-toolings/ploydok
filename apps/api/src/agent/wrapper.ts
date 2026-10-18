// SPDX-License-Identifier: AGPL-3.0-only
import * as grpc from "@grpc/grpc-js"
import { type ServiceError, status as GrpcStatus } from "@grpc/grpc-js"
import { childLogger } from "../logger"
import type {
  AgentClient,
  ContainerCreateRequest,
  ContainerCreateResponse,
  ContainerStartRequest,
  ContainerStartResponse,
  ContainerStopRequest,
  ContainerStopResponse,
  ContainerRemoveRequest,
  ContainerRemoveResponse,
  ContainerLogsRequest,
  LogLine,
  ContainerStatsRequest,
  StatsFrame,
  ImagePullRequest,
  PullProgress,
  ImageBuildRequest,
  BuildProgress,
  NetworkCreateRequest,
  NetworkCreateResponse,
  NetworkRemoveRequest,
  NetworkRemoveResponse,
  NetworkConnectRequest,
  NetworkConnectResponse,
  NetworkDisconnectRequest,
  NetworkDisconnectResponse,
  ListContainersRequest,
  ListContainersResponse,
  PingContainerRequest,
  PingContainerResponse,
  InspectContainerHealthRequest,
  InspectContainerHealthResponse,
  ListContainerFilesRequest,
  ListContainerFilesResponse,
  ReadContainerFileRequest,
  ReadContainerFileResponse,
  ExecFrame,
  DumpRequest,
  DumpChunk,
  RestoreChunk,
  RestoreResult,
  HostStatsRequest,
  HostStatsResponse,
  ImageDfRequest,
  ImageDfResponse,
  ImagePruneRequest,
  ImagePruneResponse,
  ImagePushRequest,
  ImagePushResponse,
  ImageRemoveRequest,
  ImageRemoveResponse,
  BuildCachePruneRequest,
  BuildCachePruneResponse,
  DockerCleanupRequest,
  DockerCleanupResponse,
  RegistryGarbageCollectRequest,
  RegistryGarbageCollectResponse,
  RegistryImageDigestRequest,
  RegistryImageDigestResponse,
} from "@ploydok/agent-proto"
import { createAgentClient, type AgentClientOptions } from "./client.js"
import { AgentError, toAgentError } from "./errors.js"

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = childLogger("agent")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RETRIES = 1

/**
 * Promisifie un appel gRPC unary avec timeout et 1 retry sur UNAVAILABLE.
 */
function callUnary<Req, Res>(
  fn: (
    req: Req,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    cb: (err: ServiceError | null, res: Res) => void
  ) => void,
  req: Req,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  retries: number = MAX_RETRIES
): Promise<Res> {
  return new Promise<Res>((resolve, reject) => {
    const attempt = (remaining: number) => {
      const deadline = new Date(Date.now() + timeoutMs)
      fn(req, new grpc.Metadata(), { deadline }, (err, res) => {
        if (err) {
          const agentErr = toAgentError(err)
          if (agentErr.isTransient && remaining > 0) {
            log.warn(
              { code: agentErr.code, remaining },
              "appel gRPC échoué, nouvelle tentative"
            )
            // Retry immédiat — back-off plus sophistiqué peut être ajouté ici
            attempt(remaining - 1)
          } else {
            reject(agentErr)
          }
        } else {
          resolve(res)
        }
      })
    }
    attempt(retries)
  })
}

/**
 * Transforme un ClientReadableStream en AsyncIterable.
 */
function streamToAsyncIterable<T>(
  stream: import("@grpc/grpc-js").ClientReadableStream<T>
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const queue: Array<{ value?: T; done: boolean; error?: unknown }> = []
      let resolveNext: (() => void) | null = null
      let finished = false

      stream.on("data", (chunk: T) => {
        queue.push({ value: chunk, done: false })
        resolveNext?.()
        resolveNext = null
      })
      stream.on("end", () => {
        finished = true
        queue.push({ done: true })
        resolveNext?.()
        resolveNext = null
      })
      stream.on("error", (err: unknown) => {
        finished = true
        queue.push({ done: true, error: toAgentError(err) })
        resolveNext?.()
        resolveNext = null
      })

      return {
        async next(): Promise<IteratorResult<T>> {
          // Attendre qu'un item soit disponible
          while (queue.length === 0 && !finished) {
            await new Promise<void>((r) => {
              resolveNext = r
            })
          }
          const item = queue.shift()
          if (!item) return { done: true, value: undefined as unknown as T }
          if (item.error) throw item.error
          if (item.done) return { done: true, value: undefined as unknown as T }
          return { done: false, value: item.value as T }
        },
        return(): Promise<IteratorResult<T>> {
          finished = true
          queue.length = 0
          resolveNext?.()
          resolveNext = null
          stream.cancel()
          stream.destroy()
          return Promise.resolve({
            done: true,
            value: undefined as unknown as T,
          })
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Classe principale
// ---------------------------------------------------------------------------

/**
 * Wrapper haut-niveau autour de AgentClient.
 *
 * Utilisation (tâche 2.6) :
 *   const agent = new Agent();
 *   const { containerId } = await agent.containerCreate({ name: "ploydok-web", image: "nginx:alpine", ... });
 *
 *   for await (const line of agent.containerLogs({ containerId, follow: true, sinceUnix: 0, tail: 100 })) {
 *     console.log(line.stream, line.line);
 *   }
 */
export class Agent {
  private readonly client: AgentClient

  constructor(opts: AgentClientOptions = {}) {
    this.client = createAgentClient(opts)
    log.debug({ socketPath: opts.socketPath }, "Agent initialisé")
  }

  // -------------------------------------------------------------------------
  // RPCs unary
  // -------------------------------------------------------------------------

  containerCreate(
    req: ContainerCreateRequest,
    timeoutMs: number = 330_000
  ): Promise<ContainerCreateResponse> {
    log.debug({ name: req.name, image: req.image }, "containerCreate")
    return callUnary(
      (r, m, opts, cb) => this.client.containerCreate(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  containerStart(
    req: ContainerStartRequest,
    timeoutMs?: number
  ): Promise<ContainerStartResponse> {
    log.debug({ containerId: req.containerId }, "containerStart")
    return callUnary(
      (r, m, opts, cb) => this.client.containerStart(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  containerStop(
    req: ContainerStopRequest,
    timeoutMs?: number
  ): Promise<ContainerStopResponse> {
    log.debug({ containerId: req.containerId }, "containerStop")
    return callUnary(
      (r, m, opts, cb) => this.client.containerStop(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  containerRemove(
    req: ContainerRemoveRequest,
    timeoutMs?: number
  ): Promise<ContainerRemoveResponse> {
    log.debug({ containerId: req.containerId }, "containerRemove")
    return callUnary(
      (r, m, opts, cb) => this.client.containerRemove(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  networkCreate(
    req: NetworkCreateRequest,
    timeoutMs?: number
  ): Promise<NetworkCreateResponse> {
    log.debug({ name: req.name }, "networkCreate")
    return callUnary(
      (r, m, opts, cb) => this.client.networkCreate(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  networkRemove(
    req: NetworkRemoveRequest,
    timeoutMs?: number
  ): Promise<NetworkRemoveResponse> {
    log.debug({ networkId: req.networkId }, "networkRemove")
    return callUnary(
      (r, m, opts, cb) => this.client.networkRemove(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  networkConnect(
    req: NetworkConnectRequest,
    timeoutMs?: number
  ): Promise<NetworkConnectResponse> {
    log.debug(
      {
        networkId: req.networkId,
        containerId: req.containerId,
        aliases: req.aliases,
      },
      "networkConnect"
    )
    return callUnary(
      (r, m, opts, cb) => this.client.networkConnect(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  networkDisconnect(
    req: NetworkDisconnectRequest,
    timeoutMs?: number
  ): Promise<NetworkDisconnectResponse> {
    log.debug(
      {
        networkId: req.networkId,
        containerId: req.containerId,
        force: req.force,
      },
      "networkDisconnect"
    )
    return callUnary(
      (r, m, opts, cb) => this.client.networkDisconnect(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  listContainers(
    req: ListContainersRequest,
    timeoutMs?: number
  ): Promise<ListContainersResponse> {
    log.debug({ kindFilter: req.kindFilter }, "listContainers")
    return callUnary(
      (r, m, opts, cb) => this.client.listContainers(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  hostStats(
    req: HostStatsRequest = {},
    timeoutMs?: number
  ): Promise<HostStatsResponse> {
    log.debug({}, "hostStats")
    return callUnary(
      (r, m, opts, cb) => this.client.hostStats(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  pingContainer(
    req: PingContainerRequest,
    timeoutMs?: number
  ): Promise<PingContainerResponse> {
    log.debug(
      { containerId: req.containerId, path: req.path, port: req.port },
      "pingContainer"
    )
    return callUnary(
      (r, m, opts, cb) => this.client.pingContainer(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  inspectContainerHealth(
    req: InspectContainerHealthRequest,
    timeoutMs?: number
  ): Promise<InspectContainerHealthResponse> {
    log.debug({ containerId: req.containerId }, "inspectContainerHealth")
    return callUnary(
      (r, m, opts, cb) => this.client.inspectContainerHealth(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  listContainerFiles(
    req: ListContainerFilesRequest,
    timeoutMs?: number
  ): Promise<ListContainerFilesResponse> {
    log.debug(
      { containerId: req.containerId, path: req.path },
      "listContainerFiles"
    )
    return callUnary(
      (r, m, opts, cb) => this.client.listContainerFiles(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  readContainerFile(
    req: ReadContainerFileRequest,
    timeoutMs?: number
  ): Promise<ReadContainerFileResponse> {
    log.debug(
      {
        containerId: req.containerId,
        path: req.path,
        maxBytes: req.maxBytes,
      },
      "readContainerFile"
    )
    return callUnary(
      (r, m, opts, cb) => this.client.readContainerFile(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  imageDf(
    req: ImageDfRequest = {},
    timeoutMs?: number
  ): Promise<ImageDfResponse> {
    log.debug({}, "imageDf")
    return callUnary(
      (r, m, opts, cb) => this.client.imageDf(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  imagePrune(
    req: ImagePruneRequest,
    timeoutMs?: number
  ): Promise<ImagePruneResponse> {
    log.debug({ all: req.all, untilUnix: req.untilUnix }, "imagePrune")
    return callUnary(
      (r, m, opts, cb) => this.client.imagePrune(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  imagePush(req: ImagePushRequest, timeoutMs?: number): Promise<ImagePushResponse> {
    return callUnary((r, m, opts, cb) => this.client.imagePush(r, m, opts, cb), req, timeoutMs)
  }

  imageRemove(req: ImageRemoveRequest, timeoutMs?: number): Promise<ImageRemoveResponse> {
    return callUnary((r, m, opts, cb) => this.client.imageRemove(r, m, opts, cb), req, timeoutMs)
  }

  buildCachePrune(req: BuildCachePruneRequest, timeoutMs?: number): Promise<BuildCachePruneResponse> {
    return callUnary((r, m, opts, cb) => this.client.buildCachePrune(r, m, opts, cb), req, timeoutMs)
  }

  dockerCleanup(
    req: DockerCleanupRequest = {},
    timeoutMs?: number
  ): Promise<DockerCleanupResponse> {
    return callUnary(
      (r, m, opts, cb) => this.client.dockerCleanup(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  registryGarbageCollect(req: RegistryGarbageCollectRequest, timeoutMs?: number): Promise<RegistryGarbageCollectResponse> {
    return callUnary((r, m, opts, cb) => this.client.registryGarbageCollect(r, m, opts, cb), req, timeoutMs)
  }

  registryImageDigest(
    req: RegistryImageDigestRequest,
    timeoutMs?: number
  ): Promise<RegistryImageDigestResponse> {
    log.debug({ image: req.image }, "registryImageDigest")
    return callUnary(
      (r, m, opts, cb) => this.client.registryImageDigest(r, m, opts, cb),
      req,
      timeoutMs
    )
  }

  // -------------------------------------------------------------------------
  // RPCs streaming (server-streaming → AsyncIterable)
  // -------------------------------------------------------------------------

  containerLogs(req: ContainerLogsRequest): AsyncIterable<LogLine> {
    log.debug(
      { containerId: req.containerId, follow: req.follow },
      "containerLogs stream"
    )
    return streamToAsyncIterable(this.client.containerLogs(req))
  }

  containerStats(req: ContainerStatsRequest): AsyncIterable<StatsFrame> {
    log.debug({ containerId: req.containerId }, "containerStats stream")
    return streamToAsyncIterable(this.client.containerStats(req))
  }

  imagePull(req: ImagePullRequest): AsyncIterable<PullProgress> {
    log.debug({ image: req.image }, "imagePull stream")
    return streamToAsyncIterable(this.client.imagePull(req))
  }

  imageBuild(req: ImageBuildRequest): AsyncIterable<BuildProgress> {
    log.debug({ tag: req.tag }, "imageBuild stream")
    return streamToAsyncIterable(this.client.imageBuild(req))
  }

  // -------------------------------------------------------------------------
  // RPC bidi-streaming — ContainerExec
  // -------------------------------------------------------------------------

  /**
   * Ouvre un stream bidi ContainerExec vers l'agent Rust.
   *
   * TODO: quand @ploydok/agent-proto sera régénéré avec ContainerExec,
   *       remplacer le cast `any` par le type généré et typer `stream`
   *       via `ClientDuplexStream<ExecFrame, ExecFrame>`.
   *
   * @returns { send, events, close }
   *   - send(frame)  : envoie un ExecFrame vers l'agent
   *   - events       : AsyncIterable<ExecFrame> des frames reçus
   *   - close()      : met fin au stream client-side (half-close)
   */
  containerExec(): {
    send(frame: ExecFrame): void
    events: AsyncIterable<ExecFrame>
    close(): void
  } {
    log.debug("containerExec: ouverture stream bidi")

    const stream: import("@grpc/grpc-js").ClientDuplexStream<
      ExecFrame,
      ExecFrame
    > = this.client.containerExec(new grpc.Metadata())

    const queue: Array<{ value?: ExecFrame; done: boolean; error?: unknown }> =
      []
    let resolveNext: (() => void) | null = null
    let finished = false

    stream.on("data", (frame: ExecFrame) => {
      queue.push({ value: frame, done: false })
      resolveNext?.()
      resolveNext = null
    })
    stream.on("end", () => {
      finished = true
      queue.push({ done: true })
      resolveNext?.()
      resolveNext = null
    })
    stream.on("error", (err: unknown) => {
      finished = true
      queue.push({ done: true, error: toAgentError(err) })
      resolveNext?.()
      resolveNext = null
    })

    const events: AsyncIterable<ExecFrame> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<ExecFrame>> {
            while (queue.length === 0 && !finished) {
              await new Promise<void>((r) => {
                resolveNext = r
              })
            }
            const item = queue.shift()
            if (!item)
              return { done: true, value: undefined as unknown as ExecFrame }
            if (item.error) throw item.error
            if (item.done)
              return { done: true, value: undefined as unknown as ExecFrame }
            return { done: false, value: item.value as ExecFrame }
          },
          return(): Promise<IteratorResult<ExecFrame>> {
            stream.destroy()
            return Promise.resolve({
              done: true,
              value: undefined as unknown as ExecFrame,
            })
          },
        }
      },
    }

    return {
      send(frame: ExecFrame): void {
        stream.write(frame)
      },
      events,
      close(): void {
        stream.end()
      },
    }
  }

  // -------------------------------------------------------------------------
  // RPC server-streaming — DumpDatabase
  // -------------------------------------------------------------------------

  /**
   * Streams dump chunks from the agent.
   * Each chunk is raw dump bytes (possibly age-encrypted if age_recipient was set).
   * The caller is responsible for consuming the async iterator to completion.
   */
  dumpDatabase(req: DumpRequest): AsyncIterable<DumpChunk> {
    log.debug(
      { containerId: req.containerId, kind: req.kind },
      "dumpDatabase: opening stream"
    )
    const stream: import("@grpc/grpc-js").ClientReadableStream<DumpChunk> =
      this.client.dumpDatabase(req, new grpc.Metadata())

    const queue: Array<{ value?: DumpChunk; done: boolean; error?: unknown }> =
      []
    let resolveNext: (() => void) | null = null
    let finished = false

    stream.on("data", (chunk: DumpChunk) => {
      queue.push({ value: chunk, done: false })
      resolveNext?.()
      resolveNext = null
    })
    stream.on("end", () => {
      finished = true
      queue.push({ done: true })
      resolveNext?.()
      resolveNext = null
    })
    stream.on("error", (err: unknown) => {
      finished = true
      queue.push({ done: true, error: toAgentError(err) })
      resolveNext?.()
      resolveNext = null
    })

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<DumpChunk>> {
            while (queue.length === 0 && !finished) {
              await new Promise<void>((r) => {
                resolveNext = r
              })
            }
            const item = queue.shift()
            if (!item)
              return { done: true, value: undefined as unknown as DumpChunk }
            if (item.error) throw item.error
            if (item.done)
              return { done: true, value: undefined as unknown as DumpChunk }
            return { done: false, value: item.value as DumpChunk }
          },
          return(): Promise<IteratorResult<DumpChunk>> {
            stream.destroy()
            return Promise.resolve({
              done: true,
              value: undefined as unknown as DumpChunk,
            })
          },
        }
      },
    }
  }

  // -------------------------------------------------------------------------
  // RPC client-streaming — RestoreDatabase
  // -------------------------------------------------------------------------

  /**
   * Streams restore chunks to the agent and waits for the RestoreResult.
   * Caller must first send a RestoreChunk with `header` set, then data chunks.
   */
  restoreDatabase(chunks: AsyncIterable<RestoreChunk>): Promise<RestoreResult> {
    log.debug("restoreDatabase: opening client stream")

    return new Promise<RestoreResult>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (this.client as any).restoreDatabase(
        new grpc.Metadata(),
        (err: grpc.ServiceError | null, res: RestoreResult) => {
          if (err) return reject(toAgentError(err))
          resolve(res)
        }
      )

      async function writeAll() {
        for await (const chunk of chunks) {
          stream.write(chunk)
        }
        stream.end()
      }

      writeAll().catch(reject)
    })
  }

  // -------------------------------------------------------------------------
  // Audit signing
  // -------------------------------------------------------------------------

  signAuditEntry(
    canonical: Uint8Array,
    keyId: string = "",
    timeoutMs?: number
  ): Promise<{ signature: Uint8Array; keyId: string }> {
    log.debug({ keyId }, "signAuditEntry")
    return callUnary(
      (r, m, opts, cb) => this.client.signAuditEntry(r, m, opts, cb),
      { canonicalPayload: canonical, keyId },
      timeoutMs
    )
  }

  getAuditPubkey(
    keyId: string = "",
    timeoutMs?: number
  ): Promise<{ pubkey: Uint8Array; keyId: string }> {
    log.debug({ keyId }, "getAuditPubkey")
    return callUnary(
      (r, m, opts, cb) => this.client.getAuditPubkey(r, m, opts, cb),
      { keyId },
      timeoutMs
    )
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Ferme le canal gRPC proprement.
   * À appeler lors du shutdown de l'application.
   */
  close(): void {
    this.client.close()
    log.debug("Agent fermé")
  }
}
