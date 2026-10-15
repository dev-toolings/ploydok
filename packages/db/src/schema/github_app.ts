// SPDX-License-Identifier: AGPL-3.0-only
import { pgTable, text, timestamp, customType, unique } from 'drizzle-orm/pg-core';

// Postgres bytea ↔ Buffer (mirrors SQLite blob({ mode: 'buffer' }))
const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return 'bytea'
  },
})

/**
 * One row per GitHub App registered by this instance. GitHub only lets a
 * private App be installed on the account that owns it, so each GitHub owner
 * (personal account or organization) gets its own App. The row created before
 * multi-owner support keeps id='singleton' and a null owner.
 * Encrypted fields use AES-256-GCM (keyring); nonce is stored alongside.
 */
export const github_app = pgTable('github_app', {
  id: text('id').primaryKey(),
  app_id: text('app_id').notNull(),
  client_id: text('client_id').notNull(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  owner_login: text('owner_login'),
  owner_type: text('owner_type'),
  // AES-GCM encrypted blobs
  client_secret_enc: bytea('client_secret_enc').notNull(),
  client_secret_nonce: bytea('client_secret_nonce').notNull(),
  pem_enc: bytea('pem_enc').notNull(),
  pem_nonce: bytea('pem_nonce').notNull(),
  webhook_secret_enc: bytea('webhook_secret_enc').notNull(),
  webhook_secret_nonce: bytea('webhook_secret_nonce').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (t) => ({
  uniqueAppId: unique('uq_github_app_app_id').on(t.app_id),
}));
