// SPDX-License-Identifier: AGPL-3.0-only
import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // Per-project Docker bridge network (lazily created by ensureProjectNetwork).
  network_name: text('network_name'),
  // Per-project Swarm overlay (lazily created by ensureProjectSwarmNetwork).
  swarm_network_name: text('swarm_network_name'),
  is_default: boolean('is_default').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});
