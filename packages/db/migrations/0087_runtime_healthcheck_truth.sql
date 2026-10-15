-- SPDX-License-Identifier: AGPL-3.0-only
-- Persist the healthcheck actually selected for the runtime. Compose keeps
-- NULL for legacy rows so the API can use its healthcheck fields as fallback.
ALTER TABLE "apps"
  ADD COLUMN IF NOT EXISTS "runtime_has_healthcheck" boolean;
--> statement-breakpoint
-- Existing non-Compose deployments always receive Ploydok's injected probe.
-- Leave Compose rows NULL because their entrypoint healthcheck was not
-- persisted before this migration.
UPDATE "apps"
SET "runtime_has_healthcheck" = true
WHERE "build_method" IS DISTINCT FROM 'compose'
  AND "runtime_has_healthcheck" IS NULL;
