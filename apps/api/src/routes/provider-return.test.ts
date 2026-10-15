// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "bun:test"
import { env } from "../env"
import {
  GITHUB_RETURN_FALLBACK,
  GITLAB_RETURN_FALLBACK,
  PROVIDER_RETURN_PATHS,
  buildReturnUrl,
  sanitizeReturnTo,
} from "./provider-return"

describe("sanitizeReturnTo", () => {
  it("keeps every allow-listed path", () => {
    for (const path of PROVIDER_RETURN_PATHS) {
      expect(sanitizeReturnTo(path, GITHUB_RETURN_FALLBACK)).toBe(path)
    }
  })

  it("falls back on an unknown internal path", () => {
    expect(sanitizeReturnTo("/dashboard", GITHUB_RETURN_FALLBACK)).toBe(
      GITHUB_RETURN_FALLBACK
    )
    expect(sanitizeReturnTo("/onboarding/", GITHUB_RETURN_FALLBACK)).toBe(
      GITHUB_RETURN_FALLBACK
    )
    expect(
      sanitizeReturnTo("/onboarding?next=/evil", GITHUB_RETURN_FALLBACK)
    ).toBe(GITHUB_RETURN_FALLBACK)
  })

  it("allows the organization GitHub settings route without widening redirects", () => {
    const path = "/orgs/acme-tools/settings/github"
    expect(sanitizeReturnTo(path, GITHUB_RETURN_FALLBACK)).toBe(path)
    expect(buildReturnUrl(path)).toBe(`${env.WEB_ORIGIN}${path}`)
    for (const invalid of [
      "/orgs/../settings/github",
      "/orgs/%2f%2fevil.com/settings/github",
      "/orgs/acme/settings/github?next=https://evil.com",
      "/orgs/acme/settings/github#other",
      "/orgs/acme/settings/general",
      "//evil.com/orgs/acme/settings/github",
    ]) {
      expect(sanitizeReturnTo(invalid, GITHUB_RETURN_FALLBACK)).toBe(
        GITHUB_RETURN_FALLBACK
      )
    }
  })

  it("rejects absolute URLs, scheme-relative hosts and dangerous schemes", () => {
    const hostile = [
      "https://evil.com/onboarding",
      "http://evil.com",
      "//evil.com",
      "//evil.com/onboarding",
      "javascript:alert(1)",
      "/\\evil.com",
      "\t/onboarding",
      `${env.WEB_ORIGIN}/onboarding`,
    ]
    for (const value of hostile) {
      expect(sanitizeReturnTo(value, GITLAB_RETURN_FALLBACK)).toBe(
        GITLAB_RETURN_FALLBACK
      )
    }
  })

  it("falls back on empty and non-string values", () => {
    expect(sanitizeReturnTo("", GITHUB_RETURN_FALLBACK)).toBe(
      GITHUB_RETURN_FALLBACK
    )
    expect(sanitizeReturnTo(null, GITHUB_RETURN_FALLBACK)).toBe(
      GITHUB_RETURN_FALLBACK
    )
    expect(sanitizeReturnTo(undefined, GITHUB_RETURN_FALLBACK)).toBe(
      GITHUB_RETURN_FALLBACK
    )
    expect(sanitizeReturnTo(42, GITHUB_RETURN_FALLBACK)).toBe(
      GITHUB_RETURN_FALLBACK
    )
    expect(
      sanitizeReturnTo(
        { toString: () => "/onboarding" },
        GITHUB_RETURN_FALLBACK
      )
    ).toBe(GITHUB_RETURN_FALLBACK)
  })
})

describe("buildReturnUrl", () => {
  it("resolves against WEB_ORIGIN", () => {
    expect(buildReturnUrl("/onboarding")).toBe(`${env.WEB_ORIGIN}/onboarding`)
  })

  it("appends the query string when there is one", () => {
    const params = new URLSearchParams({ app: "created" })
    expect(buildReturnUrl("/onboarding", params)).toBe(
      `${env.WEB_ORIGIN}/onboarding?app=created`
    )
  })

  it("omits the question mark when the params are empty", () => {
    expect(buildReturnUrl("/onboarding", new URLSearchParams())).toBe(
      `${env.WEB_ORIGIN}/onboarding`
    )
  })

  it("percent-encodes attacker-controlled query values", () => {
    const params = new URLSearchParams({ installation_id: "42#@evil.com" })
    const url = new URL(buildReturnUrl("/onboarding", params))
    expect(url.origin).toBe(new URL(env.WEB_ORIGIN).origin)
    expect(url.pathname).toBe("/onboarding")
    expect(url.searchParams.get("installation_id")).toBe("42#@evil.com")
  })
})
