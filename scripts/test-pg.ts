// SPDX-License-Identifier: AGPL-3.0-only
import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import postgres from "postgres"

// Postgres-backed API suites are `describe.skipIf(!PLOYDOK_TEST_PG_URL)`. Without
// a dedicated test database they silently pass as skipped, so a regression in a
// lease, outbox or reconciler query only shows up on staging. This script
// derives the test URLs from the dev credentials in .env.local, creates the test
// database once, then runs every suite that reads PLOYDOK_TEST_PG_URL, one file
// per process (bun test shares module mocks within a process).

const ROOT = process.cwd()
const ENV_FILE = join(ROOT, "apps/api/.env.local")
const API_SRC = join(ROOT, "apps/api/src")
const TEST_DB_NAME = "ploydok_test"
const TEST_REDIS_DB = "15"
const MARKER = "PLOYDOK_TEST_PG_URL"

function fail(message: string): never {
  console.error(`[test-pg] ${message}`)
  process.exit(1)
}

async function readEnvFile(): Promise<Map<string, string>> {
  let content: string
  try {
    content = await readFile(ENV_FILE, "utf8")
  } catch {
    fail(`${relative(ROOT, ENV_FILE)} not found: run 'make secrets-init' first`)
  }
  const entries = new Map<string, string>()
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const separator = line.indexOf("=")
    if (separator <= 0) continue
    entries.set(
      line.slice(0, separator),
      line.slice(separator + 1).replace(/^["']|["']$/g, "")
    )
  }
  return entries
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

async function ensureTestDatabase(adminUrl: string): Promise<void> {
  const sql = postgres(adminUrl, { max: 1 })
  try {
    const rows = await sql<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${TEST_DB_NAME}) as exists`
    if (!rows[0]?.exists) {
      await sql.unsafe(`create database "${TEST_DB_NAME}"`)
      console.log(`[test-pg] created database ${TEST_DB_NAME}`)
    }
  } catch (error) {
    fail(
      `cannot reach Postgres through DATABASE_URL (${(error as Error).message}): run 'make infra-up && make db-ensure-auth'`
    )
  } finally {
    await sql.end()
  }
}

async function collectSuites(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSuites(path, out)
      continue
    }
    if (!entry.name.endsWith(".test.ts")) continue
    if ((await readFile(path, "utf8")).includes(MARKER)) out.push(path)
  }
}

async function main(): Promise<void> {
  const env = await readEnvFile()
  const databaseUrl = env.get("DATABASE_URL")
  const redisUrl = env.get("REDIS_URL")
  if (!databaseUrl) fail("DATABASE_URL missing from .env.local")
  if (!redisUrl) fail("REDIS_URL missing from .env.local")

  const testPgUrl =
    Bun.env["PLOYDOK_TEST_PG_URL"] ?? withDatabase(databaseUrl, TEST_DB_NAME)
  const testRedisUrl =
    Bun.env["PLOYDOK_TEST_REDIS_URL"] ?? withDatabase(redisUrl, TEST_REDIS_DB)
  if (new URL(testPgUrl).pathname === new URL(databaseUrl).pathname) {
    fail("PLOYDOK_TEST_PG_URL points at the dev database; use a separate one")
  }

  await ensureTestDatabase(withDatabase(databaseUrl, "postgres"))

  const suites: string[] = []
  await collectSuites(API_SRC, suites)
  suites.sort()
  if (suites.length === 0) fail(`no suite reads ${MARKER} under apps/api/src`)

  const failed: string[] = []
  for (const suite of suites) {
    const name = relative(API_SRC, suite)
    console.log(`\n[test-pg] ${name}`)
    const proc = Bun.spawn(["bun", "test", suite], {
      cwd: join(ROOT, "apps/api"),
      env: {
        ...Bun.env,
        PLOYDOK_TEST_PG_URL: testPgUrl,
        PLOYDOK_TEST_REDIS_URL: testRedisUrl,
      },
      stdout: "inherit",
      stderr: "inherit",
    })
    if ((await proc.exited) !== 0) failed.push(name)
  }

  console.log(
    `\n[test-pg] ${suites.length - failed.length}/${suites.length} suites passed against ${TEST_DB_NAME}`
  )
  if (failed.length > 0) {
    for (const name of failed) console.error(`[test-pg] FAIL ${name}`)
    process.exit(1)
  }
}

await main()
