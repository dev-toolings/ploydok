-- SPDX-License-Identifier: AGPL-3.0-only
-- Re-home every encrypted destination credential before the post-migration
-- deduplication pass. This keeps a destination independent from a shared or
-- resource-owned source secret if that source is later deleted.
INSERT INTO "secrets" (
  "id", "app_id", "project_id", "scope", "phase", "key",
  "value_ciphertext", "nonce", "linked_database_id", "created_at"
)
SELECT
  'storage-destination-secret-' || d.id,
  NULL,
  d.org_id,
  'shared',
  'runtime',
  'storage-destination:' || d.id,
  s.value_ciphertext,
  s.nonce,
  NULL,
  coalesce(s.created_at, now())
FROM "storage_destinations" d
INNER JOIN "secrets" s ON s.id = d.credentials_secret_id
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
UPDATE "storage_destinations" d
SET "credentials_secret_id" = 'storage-destination-secret-' || d.id,
    "updated_at" = now()
FROM "secrets" s
WHERE s.id = d.credentials_secret_id;
