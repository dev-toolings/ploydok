-- SPDX-License-Identifier: AGPL-3.0-only
-- Provider preset of a storage destination (aws, cloudflare-r2, azure-blob...).
-- Nullable: rows created before presets are detected from their endpoint.
ALTER TABLE "storage_destinations" ADD COLUMN IF NOT EXISTS "provider" text;
