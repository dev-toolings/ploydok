// SPDX-License-Identifier: AGPL-3.0-only
import { pgTable, text, bigint, boolean, timestamp, index } from 'drizzle-orm/pg-core'
import { databases } from './databases'
import { backup_configs } from './backup_configs'

export const backups = pgTable('backups', {
  id: text('id').primaryKey(),
  database_id: text('database_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),
  config_id: text('config_id').references(() => backup_configs.id, { onDelete: 'set null' }),
  destination_kind: text('destination_kind', { enum: ['s3', 'azure', 'local'] }),
  // Full location: s3://bucket/prefix/id.age or /var/lib/ploydok/backups/db_id/ts.age
  location: text('location').notNull(),
  size_bytes: bigint('size_bytes', { mode: 'number' }),
  age_encrypted: boolean('age_encrypted').notNull().default(false),
  status: text('status', { enum: ['running', 'succeeded', 'failed'] })
    .notNull()
    .default('running'),
  error: text('error'),
  started_at: timestamp('started_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .$defaultFn(() => new Date()),
  finished_at: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
}, (table) => [
  index('backups_database_id_started_at_id_idx').on(
    table.database_id,
    table.started_at.desc(),
    table.id.desc(),
  ),
])

export type BackupRow = typeof backups.$inferSelect
export type BackupInsert = typeof backups.$inferInsert
