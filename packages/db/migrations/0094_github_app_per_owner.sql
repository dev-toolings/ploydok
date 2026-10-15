-- SPDX-License-Identifier: AGPL-3.0-only
-- A private GitHub App can only be installed on the account that owns it.
-- Allow one App per GitHub owner and bind every installation to its App.
ALTER TABLE "github_app" ADD COLUMN IF NOT EXISTS "owner_login" text;--> statement-breakpoint
ALTER TABLE "github_app" ADD COLUMN IF NOT EXISTS "owner_type" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "github_app" ADD CONSTRAINT "uq_github_app_app_id" UNIQUE ("app_id");
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "provider_installations" ADD COLUMN IF NOT EXISTS "github_app_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "provider_installations"
    ADD CONSTRAINT "provider_installations_github_app_id_fk"
    FOREIGN KEY ("github_app_id") REFERENCES "github_app"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_installations_github_app_idx"
  ON "provider_installations" ("github_app_id");--> statement-breakpoint
UPDATE "provider_installations"
SET "github_app_id" = 'singleton'
WHERE "provider" = 'github'
  AND "github_app_id" IS NULL
  AND EXISTS (SELECT 1 FROM "github_app" WHERE "id" = 'singleton');
