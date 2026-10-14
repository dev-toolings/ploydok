// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from "bun:test"
import { defaultStateDir, resolveRegistryApiUrl } from "./env"

const originalNodeEnv = Bun.env["NODE_ENV"]
const originalHome = Bun.env["HOME"]

describe("resolveRegistryApiUrl", () => {
  const config = { registryUrl: "127.0.0.1:5000", pushUrl: "registry:5000" }
  it("uses the published registry address for the local host API", () => {
    expect(resolveRegistryApiUrl({ ...config, nodeEnv: "dev" })).toBe(
      "127.0.0.1:5000"
    )
  })
  it("preserves the internal Docker address in production", () => {
    expect(resolveRegistryApiUrl({ ...config, nodeEnv: "prod" })).toBe(
      "registry:5000"
    )
  })
  it("honors an explicit registry API address", () => {
    expect(
      resolveRegistryApiUrl({
        ...config,
        nodeEnv: "dev",
        apiUrl: "registry.example.com",
      })
    ).toBe("registry.example.com")
  })
})

afterEach(() => {
  if (originalNodeEnv === undefined) delete Bun.env["NODE_ENV"]
  else Bun.env["NODE_ENV"] = originalNodeEnv
  if (originalHome === undefined) delete Bun.env["HOME"]
  else Bun.env["HOME"] = originalHome
})

describe("defaultStateDir", () => {
  it("uses the mounted volume path in production", () => {
    Bun.env["NODE_ENV"] = "prod"
    // HOME vaut "/" quand le container tourne sous un uid numérique : un default
    // dérivé du home viserait un rootfs read-only.
    Bun.env["HOME"] = "/"
    expect(defaultStateDir("static")).toBe("/var/lib/ploydok/static")
    expect(defaultStateDir("builds")).toBe("/var/lib/ploydok/builds")
  })

  it("stays under the user home outside production", () => {
    Bun.env["NODE_ENV"] = "dev"
    Bun.env["HOME"] = "/home/someone"
    expect(defaultStateDir("static")).toBe("/home/someone/.ploydok-dev/static")
  })

  it("falls back to /tmp when HOME is unset", () => {
    Bun.env["NODE_ENV"] = "dev"
    delete Bun.env["HOME"]
    expect(defaultStateDir("static")).toBe("/tmp/.ploydok-dev/static")
  })
})
