<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Marketplace secrets at rest

Generated DSL values use the existing instance AES-256-GCM key, with a fresh
nonce per value. generated_env contains ciphertext; Compose contains references
resolved by workers just before creation. Ordinary responses redact both.
Owner-only POST /services/:id/secrets/reveal requires services:write, audits
before disclosure and returns Cache-Control: no-store.

Run bun --env-file=apps/api/.env.local run db:migrate with the stable instance
key. Migration 0080 runs before the atomic application-level conversion of
existing rows. Conversion is idempotent. Keep API/workers stopped during the
deployment migration window, then deploy the new code together. Preserve
MASTER_KEY with backups; losing it loses access to secrets.

Protection covers generated values in current columns. Operator-written literal
credentials, Docker environment specs, logs, host access and historical database
backups/WAL remain separate trust boundaries. Old backups require existing
retention/access controls. No infrastructure deletion is performed here.
