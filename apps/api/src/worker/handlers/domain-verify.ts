// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm"
import { apps, domains } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { getAppForUser } from "@ploydok/db/queries"
import { verifyDomain } from "../../domains/verifier.js"
import { getCaddyTlsOptionsForDomain } from "../../domains/caddy-tls.js"
import { inspectDomainTls } from "../../domains/routing.js"
import { CaddyClient } from "../../caddy/client.js"
import { claimQueuedRow } from "../queue-claim.js"
import { auditClaimed, auditUnauthorized } from "../queue-audit.js"
import { workerLog as logger } from "../logger.js"

export interface DomainVerifyPayload {
  domainId: string
}

const caddyClient = new CaddyClient(
  Bun.env["CADDY_ADMIN_URL"] ?? "http://127.0.0.1:2020"
)

export async function handleDomainVerify(
  db: Db,
  payload: DomainVerifyPayload
): Promise<void> {
  const { domainId } = payload

  logger.info({ domainId }, "domain.verify job started")

  // Claim the domain row with CAS: allow retry transitions from "running" → "running"
  const claimed = await claimQueuedRow<typeof domains.$inferSelect>({
    db,
    table: domains,
    id: domainId,
    expectedStatuses: ["pending", "running"],
    setClaimedAt: false,
  })

  if (!claimed) {
    auditUnauthorized({
      jobName: "domain.verify",
      jobId: `verify-${domainId}`,
      payload,
      reason: "Domain not found or not in pending/running state",
    })
    throw new Error(
      `Domain ${domainId} not found or not in pending/running state`
    )
  }

  if (!claimed.requested_by_user_id || !claimed.verify_source) {
    const reason =
      "Domain row is not claimable: missing requested_by_user_id or verify_source"
    await db
      .update(domains)
      .set({
        tls_status: "failed",
        verify_error: reason,
        updated_at: new Date(),
      })
      .where(eq(domains.id, domainId))

    auditUnauthorized({
      jobName: "domain.verify",
      jobId: `verify-${domainId}`,
      payload,
      reason,
    })
    throw new Error(reason)
  }

  // Update verify_claimed_at manually
  await db
    .update(domains)
    .set({ verify_claimed_at: new Date() })
    .where(eq(domains.id, domainId))

  auditClaimed({
    jobName: "domain.verify",
    jobId: `verify-${domainId}`,
    rowId: domainId,
    actor: claimed.requested_by_user_id ?? null,
    source: claimed.verify_source ?? "system",
  })

  // Verify ownership: ensure requester still has access to parent app
  let parentApp: typeof apps.$inferSelect | null = null
  if (claimed.requested_by_user_id) {
    parentApp = await getAppForUser(
      db,
      claimed.app_id,
      claimed.requested_by_user_id
    )
    if (!parentApp) {
      auditUnauthorized({
        jobName: "domain.verify",
        jobId: `verify-${domainId}`,
        payload,
        reason: "Requester no longer has access to parent app",
      })
      throw new Error(
        `User ${claimed.requested_by_user_id} no longer has access to app ${claimed.app_id}`
      )
    }
  }

  if (
    parentApp?.status &&
    parentApp.status !== "running" &&
    parentApp.status !== "serving"
  ) {
    const reason = "Runtime is not healthy; TLS and routing wait for go-live"
    await db
      .update(domains)
      .set({ verify_error: reason, updated_at: new Date() })
      .where(eq(domains.id, domainId))
    throw new Error(reason)
  }

  const result = await verifyDomain(db, domainId)

  if (!result.ok) {
    logger.warn(
      { domainId, reason: result.reason },
      "domain verification failed — will retry"
    )
    await db
      .update(domains)
      .set({ verify_error: result.reason ?? null, updated_at: new Date() })
      .where(eq(domains.id, domainId))
    // Throw so BullMQ retries with backoff
    throw new Error(`domain verification failed: ${result.reason}`)
  }

  logger.info(
    { domainId, appId: claimed.app_id },
    "domain verified, registering Caddy route"
  )

  try {
    const upstream = await caddyClient.getUpstream(claimed.app_id)
    if (!upstream) {
      const reason = "Runtime is not healthy; route registration requires go-live"
      await db
        .update(domains)
        .set({ tls_status: "pending", verify_error: reason, updated_at: new Date() })
        .where(eq(domains.id, domainId))
      throw new Error(reason)
    }

    const tls = await getCaddyTlsOptionsForDomain(
      db,
      claimed.app_id,
      claimed.tls_mode,
      claimed.dns01_provider
    )
    await caddyClient.upsertRoute({
      host: claimed.hostname,
      upstream: `${upstream.host}:${upstream.port}`,
      appId: `domain-${domainId}`,
      ...(tls ? { tls } : {}),
      ...(parentApp ? { middlewares: { cdn: parentApp } } : {}),
    })
    const tlsCheck = await inspectDomainTls(claimed.hostname)
    if (tlsCheck.status === "failed" || tlsCheck.status === "pending") {
      const reason = tlsCheck.error ?? "TLS certificate requires attention"
      await db
        .update(domains)
        .set({ tls_status: "failed", verify_error: reason, updated_at: new Date() })
        .where(eq(domains.id, domainId))
      logger.warn(
        { domainId, hostname: claimed.hostname, reason },
        "domain verified but TLS remains an action required"
      )
      return
    }
    await db
      .update(domains)
      .set({ tls_status: tlsCheck.status, verify_error: null, updated_at: new Date() })
      .where(eq(domains.id, domainId))
    logger.info(
      { domainId, hostname: claimed.hostname },
      "Caddy domain route registered"
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await db
      .update(domains)
      .set({ tls_status: "failed", verify_error: reason, updated_at: new Date() })
      .where(eq(domains.id, domainId))
    // DNS/ACME/Caddy errors become an operator action after go-live. The app
    // runtime has already been verified and must not be marked as failed.
    logger.warn(
      { domainId, err },
      "domain route or TLS provisioning requires attention"
    )
  }
}
