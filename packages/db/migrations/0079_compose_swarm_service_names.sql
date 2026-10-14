-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "swarm_service_names" text[];
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "swarm_service_names" text[];
