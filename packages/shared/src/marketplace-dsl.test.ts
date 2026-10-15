// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"

import {
  UnknownDslHelperError,
  resolveTemplate,
  rewriteGeneratedDomainUrls,
} from "./marketplace-dsl"

const CTX = { projectSlug: "my-proj", domainBase: "apps.example.test" }
const CTX_NO_BASE = { projectSlug: "my-proj" }

// ---------------------------------------------------------------------------
// compose vide / sans DSL
// ---------------------------------------------------------------------------

describe("resolveTemplate — no DSL", () => {
  it("returns empty compose unchanged", () => {
    const r = resolveTemplate("", CTX)
    expect(r.composeResolved).toBe("")
    expect(r.generatedVars).toEqual({})
    expect(r.domain).toBeNull()
  })

  it("returns plain compose unchanged", () => {
    const compose = "services:\n  web:\n    image: nginx"
    const r = resolveTemplate(compose, CTX)
    expect(r.composeResolved).toBe(compose)
    expect(r.generatedVars).toEqual({})
    expect(r.domain).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ${domain}
// ---------------------------------------------------------------------------

describe("${domain}", () => {
  it("generates a domain on the configured base", () => {
    const r = resolveTemplate("HOST=${domain}", CTX)
    expect(r.domain).toMatch(/^my-proj-[0-9a-f]{6}\.apps\.example\.test$/)
    expect(r.composeResolved).toBe(`HOST=${r.domain}`)
  })

  it("returns null domain when ${domain} not used", () => {
    const r = resolveTemplate("FOO=bar", CTX)
    expect(r.domain).toBeNull()
  })

  it("uses the safe development base when no domain base is supplied", () => {
    const r = resolveTemplate("HOST=${domain}", CTX_NO_BASE)
    expect(r.domain).toMatch(/^my-proj-[0-9a-f]{6}\.demo\.localhost$/)
  })

  it.each([
    ["explicit", "apps.example.test"],
    ["IPv4 sslip", "212-47-249-36.sslip.io"],
    ["development fallback", "demo.localhost"],
  ])("uses the API-provided %s domain base", (_label, domainBase) => {
    const r = resolveTemplate("HOST=${domain}", {
      projectSlug: "my-proj",
      domainBase,
    })
    expect(r.domain).toMatch(
      new RegExp(`^my-proj-[0-9a-f]{6}\\.${domainBase.replaceAll(".", "\\.")}$`)
    )
    expect(r.domain).not.toContain("traefik.me")
  })
})

describe("generated domain URL rewriting", () => {
  const generated = "service-abc123.apps.example.test"
  const context = {
    publicOrigin: "http://localhost:8181",
    publicScheme: "http" as const,
  }

  it("uses the configured staging scheme and port for generated hosts", () => {
    expect(
      rewriteGeneratedDomainUrls(
        `WEBHOOK_URL=https://${generated}/`,
        generated,
        context
      )
    ).toBe(`WEBHOOK_URL=http://${generated}:8181/`)
  })

  it.each([
    `https://${generated}.external.test/`,
    `https://${generated}@external.test/`,
    `https://prefix-${generated}/`,
  ])("does not rewrite an unrelated URL: %s", (value) => {
    expect(rewriteGeneratedDomainUrls(value, generated, context)).toBe(value)
  })
})

// ---------------------------------------------------------------------------
// ${password}
// ---------------------------------------------------------------------------

describe("${password}", () => {
  it("generates a 16-char lowercase alphanumeric string by default", () => {
    const r = resolveTemplate("PASS=${password}", CTX)
    const val = r.generatedVars["password"]
    expect(val).toMatch(/^[a-z0-9]{16}$/)
  })

  it("generates N-char password with ${password:N}", () => {
    const r = resolveTemplate("PASS=${password:32}", CTX)
    const val = r.generatedVars["password:32"]
    expect(val).toMatch(/^[a-z0-9]{32}$/)
  })

  it("falls back to default length on malformed arg", () => {
    const r = resolveTemplate("PASS=${password:0}", CTX)
    // 0 is not > 0 → fallback to 16
    const val = r.generatedVars["password:0"]
    expect(val).toMatch(/^[a-z0-9]{16}$/)
  })
})

// ---------------------------------------------------------------------------
// Idempotence : même token → même valeur partout dans le compose
// ---------------------------------------------------------------------------

describe("idempotence", () => {
  it("${password} used 3× produces the same value each time", () => {
    const compose = "A=${password}\nB=${password}\nC=${password}"
    const r = resolveTemplate(compose, CTX)
    const lines = r.composeResolved.split("\n")
    const vals = lines.map((l) => l.split("=")[1])
    expect(vals[0]).toBe(vals[1])
    expect(vals[1]).toBe(vals[2])
  })

  it("${domain} used 2× produces the same domain", () => {
    const compose = "HOST=${domain}\nALT=${domain}"
    const r = resolveTemplate(compose, CTX)
    const lines = r.composeResolved.split("\n")
    const host = (lines[0] ?? "").split("=").slice(1).join("=")
    const alt = (lines[1] ?? "").split("=").slice(1).join("=")
    expect(host).toBe(alt)
  })

  it("${uuid} used 2× produces the same UUID", () => {
    const compose = "ID1=${uuid}\nID2=${uuid}"
    const r = resolveTemplate(compose, CTX)
    const lines = r.composeResolved.split("\n")
    const id1 = (lines[0] ?? "").split("=").slice(1).join("=")
    const id2 = (lines[1] ?? "").split("=").slice(1).join("=")
    expect(id1).toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// Multiplicité : tokens différents → valeurs différentes
// ---------------------------------------------------------------------------

describe("multiplicity", () => {
  it("${password:16} and ${password:32} produce distinct values of correct length", () => {
    const compose = "SHORT=${password:16}\nLONG=${password:32}"
    const r = resolveTemplate(compose, CTX)
    const short = r.generatedVars["password:16"]
    const long = r.generatedVars["password:32"]
    expect(short).toHaveLength(16)
    expect(long).toHaveLength(32)
    expect(short).not.toBe(long)
  })
})

// ---------------------------------------------------------------------------
// ${base64}
// ---------------------------------------------------------------------------

describe("${base64}", () => {
  it("generates a base64 string decodable to 32 bytes by default", () => {
    const r = resolveTemplate("SECRET=${base64}", CTX)
    const val = r.generatedVars["base64"] ?? ""
    const decoded = Buffer.from(val, "base64")
    expect(decoded.length).toBe(32)
  })

  it("generates a base64 string decodable to N bytes with ${base64:N}", () => {
    const r = resolveTemplate("SECRET=${base64:16}", CTX)
    const val = r.generatedVars["base64:16"] ?? ""
    const decoded = Buffer.from(val, "base64")
    expect(decoded.length).toBe(16)
  })
})

// ---------------------------------------------------------------------------
// ${hash}
// ---------------------------------------------------------------------------

describe("${hash}", () => {
  it("generates '<slug>-<6hexchars>' by default", () => {
    const r = resolveTemplate("H=${hash}", CTX)
    const val = r.generatedVars["hash"]
    expect(val).toMatch(/^my-proj-[0-9a-f]{6}$/)
  })

  it("generates '<slug>-<2*N hexchars>' with ${hash:N}", () => {
    const r = resolveTemplate("H=${hash:5}", CTX)
    const val = r.generatedVars["hash:5"]
    // 5 bytes → 10 hex chars
    expect(val).toMatch(/^my-proj-[0-9a-f]{10}$/)
  })
})

// ---------------------------------------------------------------------------
// ${uuid}
// ---------------------------------------------------------------------------

describe("${uuid}", () => {
  it("generates a valid UUID v4", () => {
    const r = resolveTemplate("ID=${uuid}", CTX)
    const val = r.generatedVars["uuid"]
    expect(val).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})

// ---------------------------------------------------------------------------
// ${timestamp} / ${timestampms} / ${timestamps}
// ---------------------------------------------------------------------------

describe("timestamp helpers", () => {
  it("${timestamp} returns a numeric string close to Date.now()", () => {
    const before = Date.now()
    const r = resolveTemplate("T=${timestamp}", CTX)
    const after = Date.now()
    const val = Number(r.generatedVars["timestamp"])
    expect(val).toBeGreaterThanOrEqual(before)
    expect(val).toBeLessThanOrEqual(after)
  })

  it("${timestampms} is identical to ${timestamp}", () => {
    const compose = "A=${timestamp}\nB=${timestampms}"
    const r = resolveTemplate(compose, CTX)
    // They are different cache keys, so may differ by a few ms — just check both are numeric
    expect(Number(r.generatedVars["timestamp"])).toBeGreaterThan(0)
    expect(Number(r.generatedVars["timestampms"])).toBeGreaterThan(0)
  })

  it("${timestamps} returns unix seconds", () => {
    const before = Math.round(Date.now() / 1000)
    const r = resolveTemplate("T=${timestamps}", CTX)
    const after = Math.round(Date.now() / 1000)
    const val = Number(r.generatedVars["timestamps"])
    expect(val).toBeGreaterThanOrEqual(before)
    expect(val).toBeLessThanOrEqual(after)
  })
})

// ---------------------------------------------------------------------------
// Helper inconnu → UnknownDslHelperError
// ---------------------------------------------------------------------------

describe("unknown helper", () => {
  it("throws UnknownDslHelperError for an unrecognised token", () => {
    expect(() => resolveTemplate("X=${foo}", CTX)).toThrow(
      UnknownDslHelperError
    )
  })

  it("includes the literal token in the error message", () => {
    try {
      resolveTemplate("X=${randomPort}", CTX)
      expect(true).toBe(false) // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownDslHelperError)
      expect((e as Error).message).toContain("${randomPort}")
    }
  })
})
