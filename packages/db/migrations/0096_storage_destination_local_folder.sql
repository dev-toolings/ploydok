-- SPDX-License-Identifier: AGPL-3.0-only
-- Folder of a local destination under <storage root>/<org_id>/. Chosen at
-- creation and never changed, so renaming a destination moves no file.
-- Existing local destinations keep the folder they already use: their id.
ALTER TABLE "storage_destinations" ADD COLUMN IF NOT EXISTS "local_folder" text;
--> statement-breakpoint
UPDATE "storage_destinations" SET "local_folder" = "id"
  WHERE "kind" = 'local' AND "local_folder" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "storage_destinations_org_local_folder_uniq"
  ON "storage_destinations" ("org_id", "local_folder");
