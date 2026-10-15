-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE "apps"
  ADD COLUMN IF NOT EXISTS "framework_preset" text,
  ADD COLUMN IF NOT EXISTS "framework_detection" text;
