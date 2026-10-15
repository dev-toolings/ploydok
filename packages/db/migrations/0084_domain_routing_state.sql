-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "apps"
  ADD COLUMN IF NOT EXISTS "domain_source" text NOT NULL DEFAULT 'generated',
  ADD COLUMN IF NOT EXISTS "routing_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "routing_error" text;
--> statement-breakpoint
ALTER TABLE "builds"
  ADD COLUMN IF NOT EXISTS "routing_domain" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_domain_unique"
  ON "apps" (lower("domain"))
  WHERE "domain" IS NOT NULL;
