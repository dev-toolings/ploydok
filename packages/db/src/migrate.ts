// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { assertNoCaseInsensitiveAppDomainDuplicates } from "./migration-safety"
import { backfillStorageDestinations } from "./storage-destinations-backfill"

const url =
  Bun.env["DATABASE_URL"] ?? "postgres://ploydok:ploydok@127.0.0.1:5432/ploydok"
const here = dirname(fileURLToPath(import.meta.url))
const migrationsFolder = join(here, "..", "migrations")

// `onnotice: () => {}` swallows server NOTICEs (drift_catchup migrations use
// `IF NOT EXISTS`, which Postgres echoes as NOTICE — noisy and looks like a
// failure even though exit is clean).
const sql = postgres(url, { max: 1, onnotice: () => {} })
const db = drizzle(sql)

function redactDatabaseUrl(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.password) parsed.password = "***"
    return parsed.toString()
  } catch {
    return "<redacted>"
  }
}

console.log(
  `[migrate] applying migrations from ${migrationsFolder} to ${redactDatabaseUrl(url)}`
)
await sql`SELECT pg_advisory_lock(hashtext('ploydok:drizzle-migrations'))`
try {
  await assertNoCaseInsensitiveAppDomainDuplicates(sql)
  await migrate(db, { migrationsFolder })
  await backfillStorageDestinations(db, Bun.env["MASTER_KEY"])
  console.log("[migrate] done")
} finally {
  await sql`SELECT pg_advisory_unlock(hashtext('ploydok:drizzle-migrations'))`.catch(
    () => undefined
  )
  await sql.end()
}
