-- SPDX-License-Identifier: AGPL-3.0-only
ALTER TABLE services ADD COLUMN IF NOT EXISTS secrets_encrypted boolean NOT NULL DEFAULT false;
