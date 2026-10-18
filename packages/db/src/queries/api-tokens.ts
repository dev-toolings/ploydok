// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, gt, or } from "drizzle-orm"
import type { Db } from "../client"
import { api_tokens, users } from "../schema"
import type { ApiTokenRow, UserRow } from "../schema"

export async function createToken(
  db: Db,
  {
    userId,
    name,
    tokenHash,
    bcryptHash,
    expiresAt,
    scopes,
  }: {
    userId: string
    name: string
    tokenHash: string
    bcryptHash?: string
    expiresAt?: Date
    scopes?: string[]
  }
): Promise<ApiTokenRow> {
  const now = new Date()
  const id = crypto.getRandomValues(new Uint8Array(16))
  const tokenId = Array.from(id)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

  const rows = await db
    .insert(api_tokens)
    .values({
      id: tokenId,
      user_id: userId,
      name,
      token_hash: tokenHash,
      bcrypt_hash: bcryptHash ?? null,
      scopes: scopes && scopes.length > 0 ? scopes : ["admin:*"],
      created_at: now,
      expires_at: expiresAt ?? null,
    })
    .returning()

  return rows[0]!
}

export async function listTokensForUser(
  db: Db,
  userId: string
): Promise<
  Array<{
    id: string
    name: string
    scopes: string[]
    created_at: Date
    last_used_at: Date | null
    expires_at: Date | null
    revoked_at: Date | null
  }>
> {
  return db
    .select({
      id: api_tokens.id,
      name: api_tokens.name,
      scopes: api_tokens.scopes,
      created_at: api_tokens.created_at,
      last_used_at: api_tokens.last_used_at,
      expires_at: api_tokens.expires_at,
      revoked_at: api_tokens.revoked_at,
    })
    .from(api_tokens)
    .where(eq(api_tokens.user_id, userId))
    .orderBy(api_tokens.created_at)
}

export async function getTokenByHash(
  db: Db,
  hash: string
): Promise<ApiTokenRow | null> {
  const [row] = await db
    .select()
    .from(api_tokens)
    .where(eq(api_tokens.token_hash, hash))

  return row ?? null
}

export async function updateTokenLastUsed(
  db: Db,
  tokenId: string,
  now: Date
): Promise<void> {
  await db
    .update(api_tokens)
    .set({ last_used_at: now })
    .where(eq(api_tokens.id, tokenId))
}

export async function revokeToken(
  db: Db,
  userId: string,
  tokenId: string
): Promise<void> {
  await db
    .update(api_tokens)
    .set({ revoked_at: new Date() })
    .where(and(eq(api_tokens.id, tokenId), eq(api_tokens.user_id, userId)))
}

export async function deleteToken(
  db: Db,
  userId: string,
  tokenId: string
): Promise<void> {
  await db
    .delete(api_tokens)
    .where(and(eq(api_tokens.id, tokenId), eq(api_tokens.user_id, userId)))
}

export async function getActiveToken(
  db: Db,
  hash: string
): Promise<ApiTokenRow | null> {
  const now = new Date()
  const [row] = await db
    .select()
    .from(api_tokens)
    .where(
      and(
        eq(api_tokens.token_hash, hash),
        isNull(api_tokens.revoked_at),
        or(isNull(api_tokens.expires_at), gt(api_tokens.expires_at, now))
      )
    )

  return row ?? null
}

export async function getUser(db: Db, userId: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.id, userId))

  return row ?? null
}
