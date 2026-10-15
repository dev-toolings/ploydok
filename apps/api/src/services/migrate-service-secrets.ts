// SPDX-License-Identifier: AGPL-3.0-only
import { createDb } from "@ploydok/db"
import { env } from "../env"
import { migrateServiceSecrets } from "./service-secrets"

const db = createDb(env.DATABASE_URL)
try {
  const count = await migrateServiceSecrets(db)
  console.log(`service-secrets: ${count} rows encrypted`)
} finally {
  await db.$client.end()
}
