-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "apps"
  ADD COLUMN IF NOT EXISTS "routing_dns_status" text,
  ADD COLUMN IF NOT EXISTS "routing_tls_status" text;
