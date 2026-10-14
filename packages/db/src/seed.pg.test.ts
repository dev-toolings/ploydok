// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, describe, expect, it } from "bun:test"
import bcrypt from "bcryptjs"
import { eq, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema"
import { DEV_PASSWORD, seedData } from "./seed"

const pgUrl = Bun.env["PLOYDOK_TEST_PG_URL"]

describe.skipIf(!pgUrl)("development seed PostgreSQL", () => {
  const client = postgres(pgUrl!, { max: 1, onnotice: () => {} })
  const db = drizzle(client, { schema })
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

  afterAll(async () => {
    await client.end()
  })

  // Copy only the required tables into a transaction-local namespace. Every
  // fixture and DDL statement is rolled back; existing accounts stay untouched.
  async function isolated(check: (tx: Transaction) => Promise<void>) {
    const namespace = `seed_test_${crypto.randomUUID().replaceAll("-", "")}`
    const rollback = new Error("roll back seed fixtures")
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`CREATE SCHEMA ${namespace}`))
        await tx.execute(sql.raw(`SET LOCAL search_path TO ${namespace}`))
        for (const table of [
          "users",
          "projects",
          "backup_codes",
          "totp_secrets",
        ]) {
          await tx.execute(
            sql.raw(
              `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`
            )
          )
          if (table !== "users") {
            const column = table === "projects" ? "owner_id" : "user_id"
            await tx.execute(
              sql.raw(
                `ALTER TABLE ${table} ADD FOREIGN KEY (${column}) REFERENCES users(id)`
              )
            )
          }
        }
        await check(tx)
        throw rollback
      })
    } catch (error) {
      if (error !== rollback) throw error
    }
  }

  async function expectSeed(tx: Transaction, userId: string) {
    const users = await tx.select().from(schema.users)
    expect(users).toHaveLength(1)
    expect(users[0]!.id).toBe(userId)
    expect(users[0]!.is_instance_admin).toBe(true)
    expect(await bcrypt.compare(DEV_PASSWORD, users[0]!.password_hash!)).toBe(
      true
    )
    const projects = await tx.select().from(schema.projects)
    expect(projects).toHaveLength(2)
    expect(projects.every((project) => project.owner_id === userId)).toBe(true)
    const codes = await tx.select().from(schema.backup_codes)
    expect(codes).toHaveLength(1)
    expect(codes[0]!.user_id).toBe(userId)
    expect(codes[0]!.consumed_at).toBeNull()
    const secrets = await tx.select().from(schema.totp_secrets)
    expect(secrets).toHaveLength(1)
    expect(secrets[0]!.user_id).toBe(userId)
    expect(secrets[0]!.verified_at).not.toBeNull()
  }

  it("creates fresh fixtures and restores them on a second run", async () => {
    await isolated(async (tx) => {
      await seedData(tx)
      await expectSeed(tx, "dev-user-0001")
      await tx.update(schema.backup_codes).set({ consumed_at: new Date() })
      await seedData(tx)
      await expectSeed(tx, "dev-user-0001")
    })
  })

  it("reuses the existing email's ID for every dependent fixture", async () => {
    await isolated(async (tx) => {
      const createdAt = new Date("2025-01-01T00:00:00Z")
      await tx.insert(schema.users).values({
        id: "existing-dev-account",
        email: "dev@ploydok.local",
        display_name: "Existing developer",
        created_at: createdAt,
        updated_at: createdAt,
      })
      await seedData(tx)
      await expectSeed(tx, "existing-dev-account")
      await seedData(tx)
      await expectSeed(tx, "existing-dev-account")
      const [user] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, "existing-dev-account"))
      expect(user!.display_name).toBe("Existing developer")
      expect(user!.created_at).toEqual(createdAt)
    })
  })
})
