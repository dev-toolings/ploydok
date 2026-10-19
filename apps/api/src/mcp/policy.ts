// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm"
import { apps, databases, projects, services } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { tokenHasScope } from "@ploydok/shared"
import type { AuthUser } from "../auth/middleware"

export type ResourceKind = "app" | "service" | "database"

export type PolicyStore = {
  resourceOrgId(kind: ResourceKind, id: string): Promise<string | null>
  orgSlug(orgId: string): Promise<string | null>
}

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export function createPolicyStore(db: Db): PolicyStore {
  const tables = { app: apps, service: services, database: databases }
  return {
    async resourceOrgId(kind, id) {
      const table = tables[kind]
      const [row] = await db
        .select({ project_id: table.project_id })
        .from(table)
        .where(eq(table.id, id))
        .limit(1)
      return row?.project_id ?? null
    },
    async orgSlug(orgId) {
      const [row] = await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(eq(projects.id, orgId))
        .limit(1)
      return row?.slug ?? null
    },
  }
}

/**
 * The org/app allowlist an MCP token carries. REST routes still enforce
 * membership, ownership and scopes; this layer narrows them to the token.
 */
export class TokenPolicy {
  readonly orgId: string
  readonly appIds: readonly string[] | undefined

  constructor(
    private readonly user: AuthUser,
    private readonly store: PolicyStore
  ) {
    if (user.token_kind !== "mcp" || !user.token_org_id) {
      throw new PolicyError("TOKEN_RESTRICTED", "An MCP token is required")
    }
    this.orgId = user.token_org_id
    this.appIds = user.token_app_ids
  }

  requireScope(scope: string): void {
    if (!tokenHasScope(this.user.token_scopes ?? [], scope)) {
      throw new PolicyError("FORBIDDEN", `This token lacks the ${scope} scope`)
    }
  }

  allowsApp(appId: string): boolean {
    return !this.appIds || this.appIds.includes(appId)
  }

  async assertApp(appId: string): Promise<void> {
    if (!this.allowsApp(appId)) throw notAllowed("app")
    await this.assertInOrg("app", appId)
  }

  /** Services and databases are out of reach of an app-limited token. */
  assertOrgWide(): void {
    if (this.appIds) {
      throw new PolicyError(
        "TOKEN_RESTRICTED",
        "This token is limited to specific apps"
      )
    }
  }

  async assertOrgResource(
    kind: "service" | "database",
    id: string
  ): Promise<void> {
    this.assertOrgWide()
    await this.assertInOrg(kind, id)
  }

  async orgSlug(): Promise<string> {
    const slug = await this.store.orgSlug(this.orgId)
    if (!slug) throw notAllowed("organization")
    return slug
  }

  private async assertInOrg(kind: ResourceKind, id: string): Promise<void> {
    const orgId = await this.store.resourceOrgId(kind, id)
    if (orgId !== this.orgId) throw notAllowed(kind)
  }
}

function notAllowed(kind: string): PolicyError {
  // Same answer for "missing" and "outside the allowlist": no existence leak.
  return new PolicyError(
    "TOKEN_RESTRICTED",
    `This ${kind} is not available to this token`
  )
}
