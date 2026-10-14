-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "swarm_network_name" text;
