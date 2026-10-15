-- SPDX-License-Identifier: AGPL-3.0-only
-- Reusable workspace destinations. Legacy destination columns remain on the
-- config tables so historical rows can still be read during and after the
-- backfill.
CREATE TABLE IF NOT EXISTS "storage_destinations" (
  "id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "s3_endpoint" text,
  "s3_bucket" text,
  "s3_region" text,
  "credentials_secret_id" text,
  "last_test_at" timestamp with time zone,
  "last_test_status" text,
  "last_test_error" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'storage_destinations_org_id_projects_id_fk'
  ) THEN
    ALTER TABLE "storage_destinations"
      ADD CONSTRAINT "storage_destinations_org_id_projects_id_fk"
      FOREIGN KEY ("org_id") REFERENCES "public"."projects"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'storage_destinations_credentials_secret_id_secrets_id_fk'
  ) THEN
    ALTER TABLE "storage_destinations"
      ADD CONSTRAINT "storage_destinations_credentials_secret_id_secrets_id_fk"
      FOREIGN KEY ("credentials_secret_id") REFERENCES "public"."secrets"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "storage_destinations_org_id_idx"
  ON "storage_destinations" ("org_id");
--> statement-breakpoint
ALTER TABLE "backup_configs" ADD COLUMN IF NOT EXISTS "destination_id" text;
--> statement-breakpoint
ALTER TABLE "volume_backup_configs" ADD COLUMN IF NOT EXISTS "destination_id" text;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'backup_configs_destination_id_storage_destinations_id_fk'
  ) THEN
    ALTER TABLE "backup_configs"
      ADD CONSTRAINT "backup_configs_destination_id_storage_destinations_id_fk"
      FOREIGN KEY ("destination_id") REFERENCES "public"."storage_destinations"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'volume_backup_configs_destination_id_storage_destinations_id_fk'
  ) THEN
    ALTER TABLE "volume_backup_configs"
      ADD CONSTRAINT "volume_backup_configs_destination_id_storage_destinations_id_fk"
      FOREIGN KEY ("destination_id") REFERENCES "public"."storage_destinations"("id")
      ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_configs_destination_id_idx"
  ON "backup_configs" ("destination_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "volume_backup_configs_destination_id_idx"
  ON "volume_backup_configs" ("destination_id");
--> statement-breakpoint

-- The encrypted secret is intentionally not grouped by ciphertext or secret
-- id here: AES-GCM uses a fresh nonce for every write. The idempotent runtime
-- backfill decrypts the referenced values and merges equal credentials. This
-- SQL stage only creates stable candidates and attaches configs to them.
INSERT INTO "storage_destinations" (
  "id", "org_id", "name", "kind", "s3_endpoint", "s3_bucket", "s3_region",
  "credentials_secret_id", "created_at", "updated_at"
)
SELECT
  'legacy-' || md5(
    jsonb_build_array(
      p.id, bc.destination_kind, bc.s3_endpoint, bc.s3_bucket,
      bc.s3_region, bc.s3_credentials_secret_id
    )::text
  ),
  p.id,
  'Migrated backup destination',
  bc.destination_kind,
  bc.s3_endpoint,
  bc.s3_bucket,
  bc.s3_region,
  bc.s3_credentials_secret_id,
  coalesce(bc.created_at, now()),
  coalesce(bc.created_at, now())
FROM "backup_configs" bc
INNER JOIN "databases" d ON d.id = bc.database_id
INNER JOIN "projects" p ON p.id = d.project_id
WHERE bc.destination_id IS NULL
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO "storage_destinations" (
  "id", "org_id", "name", "kind", "s3_endpoint", "s3_bucket", "s3_region",
  "credentials_secret_id", "created_at", "updated_at"
)
SELECT
  'legacy-' || md5(
    jsonb_build_array(
      p.id, vbc.destination_kind, vbc.s3_endpoint, vbc.s3_bucket,
      vbc.s3_region, vbc.s3_credentials_secret_id
    )::text
  ),
  p.id,
  'Migrated backup destination',
  vbc.destination_kind,
  vbc.s3_endpoint,
  vbc.s3_bucket,
  vbc.s3_region,
  vbc.s3_credentials_secret_id,
  coalesce(vbc.created_at, now()),
  coalesce(vbc.created_at, now())
FROM "volume_backup_configs" vbc
INNER JOIN "apps" a ON a.id = vbc.app_id
INNER JOIN "projects" p ON p.id = a.project_id
WHERE vbc.destination_id IS NULL
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
UPDATE "backup_configs" bc
SET "destination_id" = 'legacy-' || md5(
  jsonb_build_array(
    p.id, bc.destination_kind, bc.s3_endpoint, bc.s3_bucket,
    bc.s3_region, bc.s3_credentials_secret_id
  )::text
)
FROM "databases" d
INNER JOIN "projects" p ON p.id = d.project_id
WHERE d.id = bc.database_id AND bc.destination_id IS NULL;
--> statement-breakpoint
UPDATE "volume_backup_configs" vbc
SET "destination_id" = 'legacy-' || md5(
  jsonb_build_array(
    p.id, vbc.destination_kind, vbc.s3_endpoint, vbc.s3_bucket,
    vbc.s3_region, vbc.s3_credentials_secret_id
  )::text
)
FROM "apps" a
INNER JOIN "projects" p ON p.id = a.project_id
WHERE a.id = vbc.app_id AND vbc.destination_id IS NULL;
