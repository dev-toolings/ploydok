-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "services"
  ADD COLUMN IF NOT EXISTS "entrypoint_service_name" text,
  ADD COLUMN IF NOT EXISTS "entrypoint_port" integer;
