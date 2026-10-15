// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto"

export interface ManifestOptions {
  webBaseUrl: string // e.g. http://localhost:5173
  apiBaseUrl: string // e.g. http://localhost:3335
  webhookUrl?: string // Public webhook URL (ngrok/cloudflared). Omit in local dev.
  ownerLogin?: string // GitHub organization that will own the App.
}

// GitHub App names are unique across GitHub and limited to 34 characters.
const GITHUB_APP_NAME_MAX = 34

function isLoopbackHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost")
    )
  } catch {
    return false
  }
}

/**
 * `Ploydok <org> <instance tag>`: the tag is derived from the hostname, so two
 * instances registering an App for the same organization never collide, and
 * the name always fits GitHub's limit.
 */
function organizationAppName(ownerLogin: string, hostname: string): string {
  const tag = createHash("sha256").update(hostname).digest("hex").slice(0, 6)
  const room = GITHUB_APP_NAME_MAX - "Ploydok ".length - ` ${tag}`.length
  return `Ploydok ${ownerLogin.slice(0, room)} ${tag}`
}

export function buildManifest(opts: ManifestOptions) {
  // GitHub rejects manifests whose hook URL is not publicly reachable.
  // Three cases:
  //  1. Explicit public webhookUrl provided (tunnel/prod) → include hook + events.
  //  2. apiBaseUrl is public (non-loopback) → default to apiBaseUrl/github/webhook.
  //  3. Loopback → omit hook entirely; user configures webhook manually later.
  const publicWebhook =
    opts.webhookUrl ??
    (isLoopbackHost(opts.apiBaseUrl)
      ? null
      : `${opts.apiBaseUrl}/github/webhook`)

  const hostname = new URL(opts.webBaseUrl).hostname
  const name = opts.ownerLogin
    ? organizationAppName(opts.ownerLogin, hostname)
    : `Ploydok (${hostname})`.slice(0, GITHUB_APP_NAME_MAX)

  const base = {
    name,
    url: opts.webBaseUrl,
    redirect_url: `${opts.apiBaseUrl}/github/app/callback`,
    callback_urls: [`${opts.apiBaseUrl}/github/app/callback`],
    request_oauth_on_install: false,
    // After install/update, GitHub redirects the user here with
    // `?installation_id=X&setup_action=install|update`. The endpoint validates
    // and redirects to the UI with the same params so the frontend can show
    // a flash message. Routing through the API is more robust than the SPA
    // directly because query params survive any client-side router quirks.
    setup_url: `${opts.apiBaseUrl}/github/app/setup`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "read",
      deployments: "write",
      members: "read",
      metadata: "read",
      pull_requests: "read",
      // Required for posting commit-status checks (✓/✗) on push SHAs.
      // Existing installations must re-consent to inherit this scope —
      // without it, POST /repos/:owner/:repo/statuses/:sha returns 403.
      statuses: "write",
    },
  } as const

  if (!publicWebhook) return base

  return {
    ...base,
    hook_attributes: { url: publicWebhook },
    default_events: ["push", "pull_request"],
  }
}
