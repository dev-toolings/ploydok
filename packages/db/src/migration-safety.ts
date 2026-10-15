// SPDX-License-Identifier: AGPL-3.0-only
import postgres from "postgres"

type PostgresClient = ReturnType<typeof postgres>

type DuplicateAppDomain = {
  hostname: string
  app_ids: string[]
  duplicate_count: number
}

/**
 * Check the legacy app domain data before migration 0084 can create its
 * case-insensitive unique index. This is deliberately read-only: callers get
 * an actionable error and must choose which ownership to keep themselves.
 *
 * The check is safe to run against a fresh database. The apps table is not
 * present yet, so there is nothing to inspect and the migration continues.
 */
export async function assertNoCaseInsensitiveAppDomainDuplicates(
  sql: PostgresClient
): Promise<void> {
  const table = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'apps'
    ) AS exists
  `
  if (!table[0]?.exists) return

  const columns = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'apps'
        AND column_name = 'domain'
    ) AS exists
  `
  if (!columns[0]?.exists) return

  const duplicates = await sql<DuplicateAppDomain[]>`
    SELECT
      lower(domain) AS hostname,
      array_agg(id ORDER BY id)::text[] AS app_ids,
      count(*)::int AS duplicate_count
    FROM public.apps
    WHERE domain IS NOT NULL
    GROUP BY lower(domain)
    HAVING count(*) > 1
    ORDER BY lower(domain)
    LIMIT 20
  `
  if (duplicates.length === 0) return

  const details = duplicates
    .map(
      (duplicate) =>
        `${duplicate.hostname} (app ids: ${duplicate.app_ids.join(", ")})`
    )
    .join("; ")
  throw new Error(
    "Cannot apply the case-insensitive app domain uniqueness migration: " +
      `duplicate hostnames were found: ${details}. ` +
      "Choose one owner for each hostname, then change or clear the other " +
      "app domains and rerun the migration. No rows were modified."
  )
}
