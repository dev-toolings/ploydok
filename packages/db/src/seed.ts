// SPDX-License-Identifier: AGPL-3.0-only
import postgres from "postgres"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import { join } from "node:path"
import bcrypt from "bcryptjs"
import { createDb, type Db } from "./client"
import { users, projects, backup_codes, totp_secrets } from "./schema"

// Dev-only fixed credentials used by local login and scripts/run-dod.ts.
// Safe to commit: only works on local seed data. Never valid in prod.
export const DEV_PASSWORD = "DEVD-EVDE-VDEV"
export const DEV_BACKUP_CODE = DEV_PASSWORD

const SEED_STEPS = [
  "migrations",
  "user",
  "projects",
  "backup code",
  "TOTP",
] as const
const progressEnabled = Boolean(process.stdout.isTTY)
let completedSteps = 0

function renderProgress(label: string) {
  if (!import.meta.main) return
  const total = SEED_STEPS.length
  const percent = Math.round((completedSteps / total) * 100)
  const width = 24
  const filled = Math.round((percent / 100) * width)
  const bar = "█".repeat(filled) + "░".repeat(width - filled)
  const output = `[seed] [${bar}] ${percent.toString().padStart(3)}%: ${label}`

  if (progressEnabled) {
    process.stdout.write(`\r\x1b[2K${output}`)
  } else {
    console.log(output)
  }
}

function startStep(step: (typeof SEED_STEPS)[number]) {
  renderProgress(`running ${step}`)
}

function completeStep(step: (typeof SEED_STEPS)[number]) {
  completedSteps += 1
  renderProgress(`${step} done`)
}

export async function seedData(db: Pick<Db, "insert">) {
  const now = new Date()

  startStep("user")
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10)
  const [user] = await db
    .insert(users)
    .values({
      id: "dev-user-0001",
      email: "dev@ploydok.local",
      display_name: "Dev",
      password_hash: passwordHash,
      is_instance_admin: true,
      created_at: now,
      updated_at: now,
      recovery_token_hash: null,
      recovery_expires_at: null,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        password_hash: passwordHash,
        is_instance_admin: true,
        updated_at: now,
      },
    })
    .returning({ id: users.id })
  if (!user) throw new Error("Seed user upsert returned no user")
  completeStep("user")

  startStep("projects")
  await db
    .insert(projects)
    .values({
      id: "dev-project-0001",
      owner_id: user.id,
      name: "Default",
      slug: "default",
      created_at: now,
    })
    .onConflictDoNothing()

  // Second project: required by isolation e2e (cross-project-blocked) to
  // verify two projects of the SAME owner get isolated Docker networks.
  await db
    .insert(projects)
    .values({
      id: "dev-project-0002",
      owner_id: user.id,
      name: "Isolation",
      slug: "isolation",
      created_at: now,
    })
    .onConflictDoNothing()
  completeStep("projects")

  const codeHash = await bcrypt.hash(DEV_BACKUP_CODE, 10)
  // Idempotent: `make db-seed` restores the backup code to its unconsumed state
  // so e2e suites can re-run without regenerating the user.
  startStep("backup code")
  await db
    .insert(backup_codes)
    .values({
      id: "dev-backup-0001",
      user_id: user.id,
      code_hash: codeHash,
      consumed_at: null,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: backup_codes.id,
      set: { user_id: user.id, code_hash: codeHash, consumed_at: null },
    })
  completeStep("backup code")

  // Pre-verified TOTP row so `requireSecondFactor` passes AFTER the backup code
  // has been consumed by apiLogin(). Ciphertext is a placeholder: the verified_at
  // flag is what the guard actually checks (it never reads the secret in e2e).
  startStep("TOTP")
  await db
    .insert(totp_secrets)
    .values({
      id: "dev-totp-0001",
      user_id: user.id,
      secret_encrypted: "seed-placeholder-never-used",
      verified_at: now,
      created_at: now,
    })
    .onConflictDoUpdate({
      target: totp_secrets.user_id,
      set: { verified_at: now },
    })
  completeStep("TOTP")
}

if (import.meta.main) {
  // Seed picks DATABASE_URL from apps/api/.env.local when not already set, so
  // `make db-seed` hits the real dev Postgres (configured local database)
  // without requiring the user to export the URL manually.
  if (!Bun.env["DATABASE_URL"]) {
    try {
      const envFile = Bun.file(
        join(import.meta.dir, "../../../apps/api/.env.local")
      )
      if (await envFile.exists()) {
        const text = await envFile.text()
        const match = text.match(/^DATABASE_URL=(.*)$/m)
        if (match) Bun.env["DATABASE_URL"] = match[1]!.trim()
      }
    } catch {
      // Ignore: fall through to hardcoded default.
    }
  }
  const DB_URL =
    Bun.env["DATABASE_URL"] ??
    "postgres://ploydok:ploydok@127.0.0.1:5434/ploydok"
  const MIGRATIONS_DIR = join(import.meta.dir, "../migrations")

  renderProgress("starting")

  // Run migrations first. `onnotice` muted: drift_catchup migrations re-issue
  // `ADD COLUMN IF NOT EXISTS` which Postgres echoes as NOTICE: pure noise.
  startStep("migrations")
  const migSql = postgres(DB_URL, { max: 1, onnotice: () => {} })
  await migrate(drizzle(migSql), { migrationsFolder: MIGRATIONS_DIR })
  await migSql.end()
  completeStep("migrations")

  const db = createDb(DB_URL)

  await db.transaction(seedData)

  if (progressEnabled) process.stdout.write("\n")

  console.log(
    `Seed complete: 1 user + 2 projects + 1 backup code + TOTP verified (login: dev@ploydok.local / pwd: ${DEV_PASSWORD})`
  )
}
