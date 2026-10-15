-- SPDX-License-Identifier: AGPL-3.0-only
-- Make GitHub App installations explicitly visible to a Ploydok workspace.
CREATE TABLE IF NOT EXISTS "org_github_installations" (
  "org_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "installation_id" text NOT NULL REFERENCES "provider_installations"("id") ON DELETE CASCADE,
  "granted_by" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "org_github_installations_pkey" PRIMARY KEY ("org_id", "installation_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_github_installations_installation_idx"
  ON "org_github_installations" ("installation_id");
--> statement-breakpoint
-- Existing callback links were trusted user connections. Preserve access for
-- organizations that the connecting user owns, while keeping other workspaces
-- closed until an owner explicitly grants the installation.
INSERT INTO "org_github_installations" (
  "org_id", "installation_id", "granted_by", "created_at", "updated_at"
)
SELECT DISTINCT
  m."org_id",
  pi."id",
  giu."user_id",
  now(),
  now()
FROM "github_installation_users" giu
JOIN "provider_installations" pi
  ON pi."provider" = 'github'
 AND (
   pi."id" = 'github:' || regexp_replace(giu."installation_id", '^github:', '')
   OR pi."external_id" = regexp_replace(giu."installation_id", '^github:', '')
 )
JOIN "memberships" m
  ON m."user_id" = giu."user_id"
 AND m."role" = 'owner'
 AND m."accepted_at" IS NOT NULL
ON CONFLICT ("org_id", "installation_id") DO NOTHING;
