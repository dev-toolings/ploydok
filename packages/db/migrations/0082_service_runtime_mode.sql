-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "services"
  ADD COLUMN IF NOT EXISTS "runtime_mode" text DEFAULT 'swarm' NOT NULL;

-- Services created by the pre-Swarm marketplace implementation already have
-- container ids. Preserve their Docker runtime during the migration.
UPDATE "services"
SET "runtime_mode" = 'docker'
WHERE COALESCE(array_length("container_ids", 1), 0) > 0
  AND COALESCE(array_length("swarm_service_names", 1), 0) = 0;
