-- SPDX-License-Identifier: AGPL-3.0-only
-- Repair installs that already recorded 0084/0085 without changing their
-- migration history. The duplicate check is read-only and runs before the
-- unique index so no row is silently selected as the loser.
ALTER TABLE "apps"
  ADD COLUMN IF NOT EXISTS "domain_source" text NOT NULL DEFAULT 'generated',
  ADD COLUMN IF NOT EXISTS "routing_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "routing_error" text,
  ADD COLUMN IF NOT EXISTS "routing_dns_status" text,
  ADD COLUMN IF NOT EXISTS "routing_tls_status" text;
--> statement-breakpoint
ALTER TABLE "builds"
  ADD COLUMN IF NOT EXISTS "routing_domain" text;
--> statement-breakpoint
DO $$
DECLARE
  duplicate_host text;
  duplicate_ids text;
BEGIN
  SELECT lower(domain), string_agg(id, ', ' ORDER BY id)
    INTO duplicate_host, duplicate_ids
  FROM "apps"
  WHERE domain IS NOT NULL
  GROUP BY lower(domain)
  HAVING count(*) > 1
  ORDER BY lower(domain)
  LIMIT 1;

  IF duplicate_host IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot create apps_domain_unique: duplicate hostname % belongs to app ids %',
      duplicate_host, duplicate_ids
      USING ERRCODE = '23505',
        HINT = 'Choose one owner for each hostname, then change or clear the other app domains and rerun the migration. No rows were modified.';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "apps_domain_unique"
  ON "apps" (lower("domain"))
  WHERE "domain" IS NOT NULL;
--> statement-breakpoint
-- Existing active apps have no trustworthy DNS/TLS inspection result after
-- this feature was introduced. Keep only an actionable runtime state until a
-- routing recheck supplies fresh evidence.
UPDATE "apps"
SET
  "routing_status" = 'action_required',
  "routing_error" = 'Routing state must be rechecked after migration',
  "routing_dns_status" = NULL,
  "routing_tls_status" = NULL
WHERE "status" IN ('running', 'restarting', 'serving')
  AND "domain" IS NOT NULL
  AND (
    "routing_status" = 'pending'
    OR (
      "routing_status" = 'ready'
      AND ("routing_dns_status" IS NULL OR "routing_tls_status" IS NULL)
    )
  );
--> statement-breakpoint
-- Populate only the active app's latest successful build. Older successful
-- builds may have used a different hostname and must remain unknown.
WITH latest AS (
  SELECT DISTINCT ON (b."app_id") b."id", a."domain"
  FROM "builds" b
  INNER JOIN "apps" a ON a."id" = b."app_id"
  WHERE a."status" IN ('running', 'restarting', 'serving')
    AND a."domain" IS NOT NULL
    AND b."status" IN ('succeeded', 'succeeded_with_warning')
  ORDER BY b."app_id", b."created_at" DESC, b."id" DESC
)
UPDATE "builds" b
SET "routing_domain" = latest."domain"
FROM latest
WHERE b."id" = latest."id"
  AND b."routing_domain" IS NULL;
