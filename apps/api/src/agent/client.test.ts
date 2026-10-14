// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as grpc from "@grpc/grpc-js"
import { createAgentClient } from "./client"

const ORIGINAL_ENV = { ...process.env }

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value
  }
}

describe("createAgentClient mTLS policy", () => {
  afterEach(() => {
    restoreEnv()
  })

  it("fails closed for TCP agent addresses in production without credentials", () => {
    process.env["NODE_ENV"] = "production"

    expect(() => createAgentClient({ address: "agent:50051" })).toThrow(
      "requires mTLS credentials",
    )
  })

  it("allows production TCP when credentials are supplied", () => {
    process.env["NODE_ENV"] = "production"

    const client = createAgentClient({
      address: "agent:50051",
      credentials: grpc.credentials.createSsl(),
    })
    expect(client).toBeTruthy()
    client.close()
  })

  it("loads production TCP mTLS credentials from environment files", () => {
    process.env["NODE_ENV"] = "production"
    process.env["PLOYDOK_AGENT_ADDR"] = "agent:50051"
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ploydok-agent-mtls-"))
    try {
      const caPath = path.join(dir, "ca.pem")
      const certPath = path.join(dir, "client.pem")
      const keyPath = path.join(dir, "client.key")
      const openssl = Bun.spawnSync([
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=ploydok-agent-test",
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ])
      expect(openssl.exitCode).toBe(0)
      fs.copyFileSync(certPath, caPath)
      process.env["PLOYDOK_AGENT_CA"] = caPath
      process.env["PLOYDOK_AGENT_CLIENT_CERT"] = certPath
      process.env["PLOYDOK_AGENT_CLIENT_KEY"] = keyPath

      const client = createAgentClient()
      expect(client).toBeTruthy()
      client.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps insecure TCP fallback available in development", () => {
    process.env["NODE_ENV"] = "development"
    process.env["PLOYDOK_AGENT_INSECURE"] = "1"

    const client = createAgentClient({ address: "agent:50051" })
    expect(client).toBeTruthy()
    client.close()
  })
})
