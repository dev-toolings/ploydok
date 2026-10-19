// SPDX-License-Identifier: AGPL-3.0-only
import * as fs from "node:fs"
import * as grpc from "@grpc/grpc-js"
import { AgentClient } from "@ploydok/agent-proto"
import { childLogger } from "../logger"

const log = childLogger("agent.client")

export interface AgentClientOptions {
  /**
   * Adresse TCP de l'agent (ex: `agent:50051` en prod Docker mTLS).
   * Si fournie, elle prend le pas sur le socket Unix.
   */
  address?: string
  /**
   * Chemin vers le socket Unix de l'agent Rust.
   * Par défaut : process.env.PLOYDOK_AGENT_SOCKET, sinon
   *   - `/tmp/ploydok/agent.sock` hors prod (exposé par le container `ploydok-agent` via infra/docker-compose.yml)
   *   - `/run/ploydok/agent.sock` en prod
   */
  socketPath?: string
  /**
   * Credentials gRPC.
   * Par défaut : insecure, sauf si l'appelant injecte les credentials mTLS.
   */
  credentials?: grpc.ChannelCredentials
}

function defaultSocketPath(): string {
  const env = process.env["PLOYDOK_AGENT_SOCKET"]
  if (env) return env
  return process.env["NODE_ENV"] === "prod"
    ? "/run/ploydok/agent.sock"
    : "/tmp/ploydok/agent.sock"
}

function defaultAddress(): string | null {
  return process.env["PLOYDOK_AGENT_ADDR"] ?? null
}

function isProductionAgentMode(): boolean {
  return (
    process.env["NODE_ENV"] === "production" ||
    process.env["NODE_ENV"] === "prod" ||
    process.env["PLOYDOK_AGENT_REQUIRE_MTLS"] === "1"
  )
}

function isUnixAddress(address: string): boolean {
  return address.startsWith("unix:")
}

function credentialsFromEnv(): grpc.ChannelCredentials | null {
  const caPath = process.env["PLOYDOK_AGENT_CA"]
  const certPath = process.env["PLOYDOK_AGENT_CLIENT_CERT"]
  const keyPath = process.env["PLOYDOK_AGENT_CLIENT_KEY"]
  if (!caPath || !certPath || !keyPath) return null

  return grpc.credentials.createSsl(
    fs.readFileSync(caPath),
    fs.readFileSync(keyPath),
    fs.readFileSync(certPath)
  )
}

/**
 * Crée un AgentClient gRPC connecté au socket Unix de l'agent.
 *
 * Hook mTLS :
 *   const creds = grpc.credentials.createSsl(rootCert, clientKey, clientCert);
 *   createAgentClient({ credentials: creds });
 */
export function createAgentClient(opts: AgentClientOptions = {}): AgentClient {
  const address =
    opts.address ??
    defaultAddress() ??
    `unix://${opts.socketPath ?? defaultSocketPath()}`
  const credentials = opts.credentials ?? credentialsFromEnv()

  if (!credentials && !isUnixAddress(address) && isProductionAgentMode()) {
    throw new Error(
      "Ploydok agent TCP address requires mTLS credentials in production",
    )
  }

  if (!credentials && !isUnixAddress(address)) {
    if (process.env["PLOYDOK_AGENT_INSECURE"] === "1") {
      log.warn({ address }, "agent mTLS disabled by PLOYDOK_AGENT_INSECURE=1")
    } else {
      log.warn({ address }, "agent mTLS disabled; using insecure dev channel")
    }
  }

  const channelOptions: grpc.ClientOptions = {
    // Large receive buffer for build context / image pull streams
    "grpc.max_receive_message_length": 256 * 1024 * 1024, // 256 MiB
    "grpc.max_send_message_length": 256 * 1024 * 1024, // 256 MiB
    // Le backoff de reconnexion par défaut monte à 120 s : après un restart de
    // l'agent, l'API restait aveugle bien après le retour du socket. L'agent
    // est local (socket Unix ou réseau overlay), une reconnexion coûte peu.
    "grpc.initial_reconnect_backoff_ms": 500,
    "grpc.max_reconnect_backoff_ms": 5_000,
    // Sur Unix socket avec TLS, gRPC n'extrait pas de SNI depuis l'address ;
    // on force le hostname utilisé pour la vérification du SAN à correspondre
    // au CN du cert serveur émis par installer/install.sh::generate_agent_pki.
    "grpc.ssl_target_name_override": "ploydok-agent",
    "grpc.default_authority": "ploydok-agent",
  }

  return new AgentClient(
    address,
    credentials ?? grpc.credentials.createInsecure(),
    channelOptions
  )
}
