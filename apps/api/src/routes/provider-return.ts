// SPDX-License-Identifier: AGPL-3.0-only
import { env } from "../env"

/**
 * Static paths a Git-provider round-trip is allowed to come back to.
 * Membership is checked both when the value is signed into a state cookie and
 * again right before the redirect is issued, so a cookie minted by an instance
 * running an older allow-list can never widen this one.
 */
export const PROVIDER_RETURN_PATHS = [
  "/onboarding",
  "/settings/git-providers/github",
  "/settings/git-providers/gitlab",
] as const

export type ProviderReturnPath =
  | (typeof PROVIDER_RETURN_PATHS)[number]
  | `/orgs/${string}/settings/github`

export const GITHUB_RETURN_FALLBACK: ProviderReturnPath =
  "/settings/git-providers/github"
export const GITLAB_RETURN_FALLBACK: ProviderReturnPath =
  "/settings/git-providers/gitlab"

/**
 * Resolves an untrusted value to a static path or an organization GitHub
 * settings path. Absolute URLs, scheme-relative hosts and dangerous schemes
 * collapse to the fallback.
 */
export function sanitizeReturnTo(
  raw: unknown,
  fallback: ProviderReturnPath
): ProviderReturnPath {
  if (typeof raw !== "string") return fallback
  // Only the GitHub settings route is dynamic. Exclude encoded separators,
  // query strings and dot segments so this can never become an open redirect.
  if (/^\/orgs\/[a-z0-9]+(?:-[a-z0-9]+)*\/settings\/github$/.test(raw)) {
    return raw as ProviderReturnPath
  }
  return PROVIDER_RETURN_PATHS.find((allowed) => allowed === raw) ?? fallback
}

export function buildReturnUrl(
  returnTo: ProviderReturnPath,
  params?: URLSearchParams
): string {
  const url = new URL(returnTo, env.WEB_ORIGIN)
  if (params) {
    const qs = params.toString()
    if (qs) url.search = qs
  }
  return url.toString()
}
