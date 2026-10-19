-- SPDX-License-Identifier: AGPL-3.0-only
-- MCP tokens are API tokens confined to the /mcp endpoint and bound to one
-- organization, optionally to a subset of its apps (NULL = every app).
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'api' NOT NULL;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "org_id" text;
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "app_ids" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_projects_id_fk"
    FOREIGN KEY ("org_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_kind_check"
    CHECK ("kind" IN ('api', 'mcp') AND ("kind" = 'api' OR "org_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
