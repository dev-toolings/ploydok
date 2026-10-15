// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test"

import * as dbQueries from "@ploydok/db/queries"
import * as queueClaimMod from "../queue-claim"
import * as queueAuditMod from "../queue-audit"
import * as routingMod from "../../domains/routing"
import * as verifierMod from "../../domains/verifier"
import * as caddyClientMod from "../../caddy/client"

const MOCK_DOMAIN = {
  id: "dom-1",
  app_id: "app-1",
  hostname: "example.com",
  tls_status: "pending",
  tls_mode: "http01",
  dns01_provider: null,
  verify_token: "abc123",
  verify_error: null,
  requested_by_user_id: "user-1",
  verify_source: "api",
  verify_claimed_at: null,
  created_at: new Date(),
  updated_at: new Date(),
}

function createMockDb() {
  const updates: Array<Record<string, unknown>> = []
  return {
    _updates: updates,
    update: mock(() => ({
      set: mock((values: Record<string, unknown>) => {
        updates.push(values)
        return {
          where: mock(() => Promise.resolve()),
        }
      }),
    })),
  } as any
}

describe("handleDomainVerify", () => {
  beforeEach(() => {
    mock.restore()
  })

  it("rejects payload with non-existent domainId", async () => {
    const { handleDomainVerify } = await import("./domain-verify.js")
    const fakeDb = createMockDb()

    const claimSpy = spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(
      null
    )
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")

    try {
      await handleDomainVerify(fakeDb, { domainId: "dom-nonexistent" })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as Error).message).toContain(
        "not found or not in pending/running state"
      )
    }

    expect(auditUnauthorizedSpy).toHaveBeenCalled()
  })

  it("claim succeeds on first attempt (pending → running)", async () => {
    const { handleDomainVerify } = await import("./domain-verify.js")
    const fakeDb = createMockDb()

    const claimedDomain = { ...MOCK_DOMAIN, tls_status: "running" }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(claimedDomain)
    spyOn(dbQueries, "getAppForUser").mockResolvedValue({
      id: "app-1",
    } as any)
    spyOn(verifierMod, "verifyDomain").mockResolvedValue({
      ok: true,
    })
    spyOn(
      caddyClientMod.CaddyClient.prototype,
      "getUpstream"
    ).mockResolvedValue({
      host: "127.0.0.1",
      port: 3000,
    })
    spyOn(
      caddyClientMod.CaddyClient.prototype,
      "upsertRoute"
    ).mockResolvedValue(undefined)
    const auditClaimedSpy = spyOn(queueAuditMod, "auditClaimed")

    await handleDomainVerify(fakeDb, { domainId: "dom-1" })

    expect(auditClaimedSpy).toHaveBeenCalled()
  })

  it("keeps TLS pending and records an action when DNS is absent", async () => {
    const { handleDomainVerify } = await import("./domain-verify.js")
    const fakeDb = createMockDb()

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      ...MOCK_DOMAIN,
      tls_status: "running",
    })
    spyOn(dbQueries, "getAppForUser").mockResolvedValue({ id: "app-1" } as any)
    spyOn(verifierMod, "verifyDomain").mockResolvedValue({
      ok: false,
      reason: "TXT record not found",
    })

    await expect(handleDomainVerify(fakeDb, { domainId: "dom-1" })).rejects.toThrow(
      /TXT record not found/
    )

    expect(fakeDb._updates).toContainEqual({
      verify_error: "TXT record not found",
      updated_at: expect.any(Date),
    })
    expect(fakeDb._updates.some((patch: Record<string, unknown>) => patch.tls_status === "issued")).toBe(false)
  })

  it.each(["issued", "not_required"] as const)("records verified TLS state %s after DNS verification", async (status) => {
    spyOn(routingMod, "inspectDomainTls").mockResolvedValue({ status, error: null, checkedAt: new Date().toISOString() })
    const { handleDomainVerify } = await import("./domain-verify.js")
    const fakeDb = createMockDb()

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      ...MOCK_DOMAIN,
      tls_status: "running",
    })
    spyOn(dbQueries, "getAppForUser").mockResolvedValue({ id: "app-1" } as any)
    spyOn(verifierMod, "verifyDomain").mockResolvedValue({ ok: true })
    spyOn(caddyClientMod.CaddyClient.prototype, "getUpstream").mockResolvedValue({
      host: "127.0.0.1",
      port: 3000,
    })
    const upsertRouteSpy = spyOn(
      caddyClientMod.CaddyClient.prototype,
      "upsertRoute"
    ).mockResolvedValue(undefined)

    await handleDomainVerify(fakeDb, { domainId: "dom-1" })

    expect(fakeDb._updates).toContainEqual({
      tls_status: status,
      verify_error: null,
      updated_at: expect.any(Date),
    })
    expect(upsertRouteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "example.com",
        upstream: "127.0.0.1:3000",
        tls: { mode: "http01" },
      })
    )
  })

  it("claim succeeds on retry (running → running, no rollback)", async () => {
    const { handleDomainVerify } = await import("./domain-verify.js")
    const fakeDb = createMockDb()

    const retryDomain = {
      ...MOCK_DOMAIN,
      tls_status: "running",
      verify_claimed_at: new Date(),
    }

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(retryDomain)
    spyOn(dbQueries, "getAppForUser").mockResolvedValue({
      id: "app-1",
    } as any)
    spyOn(verifierMod, "verifyDomain").mockResolvedValue({
      ok: true,
    })
    spyOn(
      caddyClientMod.CaddyClient.prototype,
      "getUpstream"
    ).mockResolvedValue({
      host: "127.0.0.1",
      port: 3000,
    })
    spyOn(
      caddyClientMod.CaddyClient.prototype,
      "upsertRoute"
    ).mockResolvedValue(undefined)

    // Should not throw on retry
    await handleDomainVerify(fakeDb, { domainId: "dom-1" })
  })

  it("rejects non-claimable domain rows missing trust metadata", async () => {
    const { handleDomainVerify } = await import("./domain-verify.js")
    const fakeDb = createMockDb()

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue({
      ...MOCK_DOMAIN,
      requested_by_user_id: null,
      verify_source: null,
    })
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")
    const verifyDomainSpy = spyOn(verifierMod, "verifyDomain").mockResolvedValue({
      ok: true,
    })

    try {
      await handleDomainVerify(fakeDb, { domainId: "dom-1" })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as Error).message).toContain("not claimable")
    }

    expect(auditUnauthorizedSpy).toHaveBeenCalled()
    expect(verifyDomainSpy).not.toHaveBeenCalled()
  })

  it("claim drops if domain status is verified (no double-verify)", async () => {
    const { handleDomainVerify } = await import("./domain-verify.js")
    const fakeDb = createMockDb()

    spyOn(queueClaimMod, "claimQueuedRow").mockResolvedValue(null)
    const auditUnauthorizedSpy = spyOn(queueAuditMod, "auditUnauthorized")

    try {
      await handleDomainVerify(fakeDb, { domainId: "dom-1" })
      expect.unreachable("should have thrown")
    } catch (err) {
      expect((err as Error).message).toContain(
        "not found or not in pending/running state"
      )
    }

    expect(auditUnauthorizedSpy).toHaveBeenCalled()
  })
})
