// SPDX-License-Identifier: AGPL-3.0-only
import { pgTable, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core'
import { databases } from './databases'
import { secrets } from './secrets'
import { storage_destinations } from './storage-destinations'

export const backup_configs = pgTable('backup_configs', {
  id: text('id').primaryKey(),
  database_id: text('database_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),
  // New configurations point at a workspace destination. The legacy fields
  // below remain nullable so pre-migration rows and historical restores keep
  // working until they are migrated or edited.
  destination_id: text('destination_id').references(() => storage_destinations.id),
  destination_kind: text('destination_kind', { enum: ['s3', 'local'] })
    .notNull()
    .default('local'),
  s3_endpoint: text('s3_endpoint'),
  s3_bucket: text('s3_bucket'),
  s3_prefix: text('s3_prefix'),
  s3_region: text('s3_region'),
  // Secret containing serialized S3 credentials (access_key_id + secret_access_key)
  s3_credentials_secret_id: text('s3_credentials_secret_id').references(() => secrets.id, {
    onDelete: 'set null',
  }),
  schedule_cron: text('schedule_cron').notNull().default('0 3 * * *'),
  retention_days: integer('retention_days').notNull().default(7),
  // Plain public key — intentionally not encrypted (age public keys are public by design)
  age_recipient_public_key: text('age_recipient_public_key'),
  enabled: boolean('enabled').notNull().default(true),
  last_scheduled_at: timestamp('last_scheduled_at', { withTimezone: true, mode: 'date' }),
  last_run_at: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  last_error: text('last_error'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  index('backup_configs_database_id_idx').on(table.database_id),
])

export type BackupConfigRow = typeof backup_configs.$inferSelect
export type BackupConfigInsert = typeof backup_configs.$inferInsert
