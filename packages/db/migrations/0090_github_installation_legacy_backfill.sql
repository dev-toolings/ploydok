-- SPDX-License-Identifier: AGPL-3.0-only
-- Preserve only callback links that remain orphaned when this repair runs. The table
-- existence guard makes this seed genuinely one-time: rerunning this file
-- after the first application cannot capture new personal connections.
DO $$
BEGIN
  IF to_regclass('github_installation_legacy_backfill') IS NULL THEN
    CREATE TABLE "github_installation_legacy_backfill" (
      "installation_id" text NOT NULL,
      "user_id" text NOT NULL
        REFERENCES "users"("id") ON DELETE CASCADE,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "consumed_at" timestamptz,
      CONSTRAINT "github_installation_legacy_backfill_pkey"
        PRIMARY KEY ("installation_id", "user_id")
    );

    INSERT INTO "github_installation_legacy_backfill" (
      "installation_id", "user_id", "created_at"
    )
    SELECT DISTINCT
      regexp_replace(giu."installation_id", '^github:', ''),
      giu."user_id",
      now()
    FROM "github_installation_users" giu
    WHERE NOT EXISTS (
      SELECT 1
      FROM "provider_installations" pi
      WHERE pi."provider" = 'github'
        AND (
          pi."id" = 'github:' || regexp_replace(giu."installation_id", '^github:', '')
          OR pi."external_id" = regexp_replace(giu."installation_id", '^github:', '')
        )
    )
    ON CONFLICT ("installation_id", "user_id") DO NOTHING;
  END IF;
END $$;
