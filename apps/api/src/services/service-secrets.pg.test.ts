// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test"
import { createDb, services, type Db } from "@ploydok/db"
import { eq, sql } from "drizzle-orm"
import { protectServiceSecrets, resolveServiceCompose, maskServiceSecrets, migrateServiceSecrets } from "./service-secrets"

test.skipIf(!process.env.DATABASE_URL)("generated secrets are absent from persisted columns and resolve at deployment", async () => {
  const db = createDb(process.env.DATABASE_URL!)
  try {
    await db.transaction(async tx => {
      await tx.execute(sql.raw("CREATE TEMP TABLE services (LIKE public.services INCLUDING ALL) ON COMMIT DROP"))
      const secret = "fixture-generated-secret-long-random"
      const compose = `services:\n  db:\n    image: postgres:16\n    environment:\n      PASSWORD: ${secret}\n`
      const protectedValues = await protectServiceSecrets(compose, { password: secret })
      await tx.insert(services).values({
        id: "fixture-secret", project_id: "fixture-project", name: "Fixture",
        slug: "fixture", template_id: "fixture", ...protectedValues,
      })
      const [row] = await tx.select().from(services).where(eq(services.id, "fixture-secret"))
      expect(JSON.stringify(row)).not.toContain(secret)
      expect(await resolveServiceCompose(row!)).toBe(compose)
      expect(JSON.stringify(maskServiceSecrets(row!))).not.toContain(secret)
      expect(JSON.stringify(maskServiceSecrets(row!))).not.toContain("nonce")
    })
  } finally { await db.$client.end() }
})

test.skipIf(!process.env.DATABASE_URL)("legacy migration encrypts both columns atomically and is idempotent", async () => {
  const db = createDb(process.env.DATABASE_URL!)
  try {
    await db.transaction(async tx => {
      await tx.execute(sql.raw("CREATE TEMP TABLE services (LIKE public.services INCLUDING ALL) ON COMMIT DROP"))
      const compose = "services:\n  web:\n    image: alpine\n    environment:\n      TOKEN: legacy-long-secret"
      await tx.insert(services).values({ id: "legacy", project_id: "fixture-project", name: "Legacy",
        slug: "legacy", template_id: "fixture", compose_raw: compose, generated_env: { token: "legacy-long-secret" } })
      expect(await migrateServiceSecrets(tx as unknown as Db)).toBe(1)
      expect(await migrateServiceSecrets(tx as unknown as Db)).toBe(0)
      const [row] = await tx.select().from(services)
      expect(JSON.stringify(row)).not.toContain("legacy-long-secret")
      expect(await resolveServiceCompose(row!)).toBe(compose)
    })
  } finally { await db.$client.end() }
})
