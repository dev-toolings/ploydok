// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Errors that BullMQ should retry (network glitches, agent down, Docker/registry timeouts).
 */
export class TransientDeployError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "TransientDeployError"
  }
}

/**
 * Errors that BullMQ should NOT retry — the job is permanently broken.
 * The caller in `worker/index.ts` is responsible for wrapping these in
 * BullMQ's `UnrecoverableError` so retries are skipped.
 */
export class FatalDeployError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "FatalDeployError"
  }
}

// ---------------------------------------------------------------------------
// Classifier heuristics
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  /socket hang up/i,
  /UNAVAILABLE/i,       // gRPC status UNAVAILABLE (agent down)
  /DEADLINE_EXCEEDED/i, // gRPC status DEADLINE_EXCEEDED
  /connect ETIMEDOUT/i,
  /read ECONNRESET/i,
  /connect ECONNREFUSED/i,
  /redis.*timeout/i,
  /redis.*ECONNREFUSED/i,
  /docker.*5[0-9][0-9]/i, // Docker registry 5xx
  /registry.*5[0-9][0-9]/i,
  /network timeout/i,
  /request timeout/i,
]

const FATAL_PATTERNS: RegExp[] = [
  // Permissions et systèmes de fichiers en lecture seule : un volume mal monté
  // ou possédé par un autre uid ne se répare pas tout seul, un retry ne fait
  // que rejouer le build pour rien.
  /EACCES/,
  /EPERM/,
  /EROFS/,
  /permission denied/i,
  /read-only file system/i,
  /dockerfile.*parse/i,
  /dockerfile.*invalid/i,
  /syntax error.*dockerfile/i,
  /nixpacks.*failed/i,
  /nixpacks.*error/i,
  /manifest.*unknown/i,    // image manifest not found (404)
  /manifest.*not found/i,
  /image.*not found/i,
  /repository.*not found/i,
  /unauthorized.*registry/i, // registry 401
  /denied.*registry/i,       // registry 403
  /no such image/i,
  /invalid.*image.*reference/i,
  /app not found/i,
  /missing repo_full_name/i,
  /missing.*branch/i,
  /has git_provider.*image.*but no image_ref/i,
  /no github app installation/i,
]

/**
 * Classify an unknown error into `TransientDeployError` or `FatalDeployError`
 * based on message heuristics. Unknown errors default to transient (safer to
 * retry than to silently drop a deploy).
 */
export function classifyAgentError(err: unknown): TransientDeployError | FatalDeployError {
  const msg = err instanceof Error ? err.message : String(err)
  // Errors that quote application output (container logs) expose the part
  // written by Ploydok, so an app line such as "ECONNREFUSED" cannot change
  // the retry decision.
  const classifyMessage =
    err instanceof Error
      ? (err as Error & { classifyMessage?: unknown }).classifyMessage
      : undefined
  const probe = typeof classifyMessage === "string" ? classifyMessage : msg

  for (const pattern of FATAL_PATTERNS) {
    if (pattern.test(probe)) {
      return new FatalDeployError(msg, err)
    }
  }

  for (const pattern of TRANSIENT_PATTERNS) {
    if (pattern.test(probe)) {
      return new TransientDeployError(msg, err)
    }
  }

  // Unknown errors default to transient — retrying a fatal is wasteful but
  // not harmful, whereas dropping a transient silently loses a deploy.
  return new TransientDeployError(msg, err)
}
