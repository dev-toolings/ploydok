// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm"
import { memberships } from "@ploydok/db"
import type { Db } from "@ploydok/db"
import { tokenHasScope } from "@ploydok/shared"

type RoleLevel = "owner" | "admin" | "member" | "guest"

const rolePriority: Record<RoleLevel, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  guest: 1,
}

const roleScopeMap: Record<RoleLevel, string[]> = {
  owner: ["admin:*"],
  admin: [
    "apps:read",
    "apps:write",
    "apps:deploy",
    "secrets:read",
    "secrets:write",
    "databases:read",
    "databases:write",
    "databases:*",
    "storage:read",
    "storage:write",
  ],
  member: ["apps:read", "databases:read", "storage:read"],
  guest: ["apps:read"],
}

/**
 * Récupère les scopes maximums autorisés pour un user selon son rôle d'org le plus élevé.
 * Lit la table `memberships` pour déterminer le rôle max parmi toutes les orgs.
 */
export async function userMaxScopes(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(eq(memberships.user_id, userId))

  let maxRole: RoleLevel = "guest"

  for (const row of rows) {
    const role = row.role as RoleLevel
    if (rolePriority[role] > rolePriority[maxRole]) {
      maxRole = role
    }
  }

  return roleScopeMap[maxRole]
}

/**
 * Vérifie que chaque scope demandé est couvert par les scopes alloués.
 * Réutilise `tokenHasScope` de @ploydok/shared pour la matching logic.
 */
export function assertScopesAllowed(
  requested: string[],
  allowed: string[]
): { ok: true } | { ok: false; denied: string[] } {
  const denied: string[] = []

  for (const scope of requested) {
    if (!tokenHasScope(allowed, scope)) {
      denied.push(scope)
    }
  }

  if (denied.length > 0) {
    return { ok: false, denied }
  }

  return { ok: true }
}
