// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto"

/** Stable, non-secret identity for the encrypted GitHub App signing config. */
export function getGitHubAppConfigFingerprint(config: {
  app_id: string
  pem_enc: unknown
  pem_nonce: unknown
}): string {
  return createHash("sha256")
    .update(config.app_id)
    .update("\0")
    .update(Buffer.from(config.pem_enc as Buffer))
    .update("\0")
    .update(Buffer.from(config.pem_nonce as Buffer))
    .digest("hex")
}

/** Identity of the whole set of registered Apps, for cross-App fan-out fences. */
export function getGitHubAppsFingerprint(
  configs: ReadonlyArray<{
    id: string
    app_id: string
    pem_enc: unknown
    pem_nonce: unknown
  }>
): string {
  const hash = createHash("sha256")
  for (const config of [...configs].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(config.id).update("\0")
    hash.update(getGitHubAppConfigFingerprint(config)).update("\0")
  }
  return hash.digest("hex")
}
