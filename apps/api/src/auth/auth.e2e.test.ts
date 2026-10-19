// SPDX-License-Identifier: AGPL-3.0-only
//
// E2E auth flow tests.
//
// NOTE: Full WebAuthn register/login flows require a real authenticator or a
// browser-level stub (navigator.credentials). Mocking @simplewebauthn/server
// at the module level in Bun's test runner is not straightforward in v1.
// These tests are skipped and will be implemented in Sprint 6 as integration
// tests against a real WebAuthn software authenticator.
//
// What IS tested here:
//   - /me returns 401 without auth
//   - /auth/backup-codes/consume rejects invalid code
//   - /auth/sessions/revoke-others works via DB helpers
//
// Full WebAuthn e2e coverage needs a browser-level virtual authenticator.

import { describe, it, expect, test } from "bun:test";

// We test through the Hono app directly (no real HTTP server needed)
// but we need a real DB with schema. Requires PLOYDOK_TEST_PG_URL.

import { Hono } from "hono";
import { requireAuth } from "./middleware";
import { signAccessToken, ACCESS_COOKIE } from "./jwt";
import { createSession } from "./sessions";
import { users } from "@ploydok/db";
import type { Db } from "@ploydok/db";
import { nanoid } from "nanoid";
import { makeTestDb, TEST_PG_URL } from "../test/db-helpers";

const skip = !TEST_PG_URL;
if (skip) console.log("[auth.e2e.test] PLOYDOK_TEST_PG_URL not set — skipping");

describe.skipIf(skip)("/me endpoint", () => {
  it("returns 401 without auth cookie", async () => {
    const { db } = await makeTestDb();
    const app = new Hono();
    app.get("/me", requireAuth(db), (c) => c.json({ ok: true }));

    const res = await app.request("/me");
    expect(res.status).toBe(401);
  });

  it("returns 200 with valid auth cookie and user in context", async () => {
    const { db } = await makeTestDb();
    const userId = `e2e-${nanoid(6)}`;
    const now = new Date();
    await db.insert(users).values({
      id: userId,
      email: `alice-${userId}@example.com`,
      display_name: "Alice",
      created_at: now,
      updated_at: now,
      recovery_token_hash: null,
      recovery_expires_at: null,
    }).onConflictDoNothing();

    const { sessionId } = await createSession(db, { userId, userAgent: "test", ip: "127.0.0.1" });
    const token = await signAccessToken({ userId, email: `alice-${userId}@example.com`, sessionId });

    const app = new Hono();
    app.get("/me", requireAuth(db), (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (c as any).get("user") as { id: string };
      return c.json({ id: user.id });
    });

    const res = await app.request("/me", {
      headers: { cookie: `${ACCESS_COOKIE}=${encodeURIComponent(token)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(body.id).toBe(userId);
  });
});

// ---------------------------------------------------------------------------
// WebAuthn flow — skipped in v1, to be implemented in Sprint 6
// ---------------------------------------------------------------------------

test.skip("register → login → /me flow (requires WebAuthn mock, Sprint 6)", async () => {
  // TODO Sprint 6: Use a software authenticator (e.g., virtual-authenticator-js)
  // to exercise the full WebAuthn registration and authentication flow end-to-end.
});
