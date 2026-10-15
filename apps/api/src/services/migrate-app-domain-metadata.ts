// SPDX-License-Identifier: AGPL-3.0-only
import { createDb } from "@ploydok/db"
import { env } from "../env"
import {
  backfillAppDomainMetadata,
  deriveDefaultAppDomainBase,
} from "../domains/app-domain"

const db = createDb(env.DATABASE_URL)
try {
  const result = await backfillAppDomainMetadata(
    db,
    deriveDefaultAppDomainBase({
      explicitBase: env.PLOYDOK_DOMAIN_BASE,
      publicHost: env.PLOYDOK_PUBLIC_HOST,
    })
  )
  console.log(
    `app-domain-metadata: ${result.appsUpdated} apps, ${result.buildsUpdated} builds updated`
  )
} finally {
  await db.$client.end()
}
